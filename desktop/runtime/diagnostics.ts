import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { identifier } from './input.ts';
import { invalid, RuntimeError } from './errors.ts';
import { readPackageZip, writePackageZip, type PackageEntry } from './package.ts';

export type DiagnosticExportRequest = { threadId: string; includeAttachments: string[]; outputDirectory: string };
export type DiagnosticPreview = { files: { path: string; bytes: number }[]; missing: { item: string; reason: string }[]; attachments: { id: string; name: string }[]; redactionPolicy: string };
export type DiagnosticExport = { uploadId: string; threadId: string; packageFile: string; bundleSha256: string; manifest: object; preview: DiagnosticPreview };
const MAX_FILE = 20 * 1024 * 1024, MAX_TOTAL = 100 * 1024 * 1024, MAX_ROWS = 10_000;
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const within = (root: string, target: string) => { const rest = relative(root, target); return rest === '' || !rest.startsWith('..') && !isAbsolute(rest); };
const failure = (cause: unknown) => Object.assign(new RuntimeError('storage', '无法读取或保存诊断材料。'), { cause });
const safeId = z.string().min(1).max(256).refine(value => !/[\x00-\x1f\x7f]/u.test(value));
const hex = z.string().regex(/^[a-f0-9]{64}$/u);
const missingSchema = z.array(z.object({ item: z.string().max(2048), reason: z.string().max(128) }).strict()).max(10_000);
const previewSchema = z.object({ files: z.array(z.object({ path: z.string().max(1024), bytes: z.number().int().nonnegative() }).strict()).max(1000), missing: missingSchema, attachments: z.array(z.object({ id: safeId, name: z.string().max(512) }).strict()).max(100), redactionPolicy: z.literal('omniops-diagnostics:1') }).strict();
const savedSchema = z.object({ uploadId: z.string().uuid(), threadId: safeId, packageFile: z.string().max(8192), bundleSha256: hex,
  manifest: z.object({ schemaVersion: z.literal(1), uploadId: z.string().uuid(), threadId: safeId, cutoff: z.string().datetime({ offset: true }), files: z.array(z.object({ path: z.string().max(1024), bytes: z.number().int().nonnegative(), sha256: hex }).strict()).max(1000), missing: missingSchema }).passthrough(), preview: previewSchema }).strict();

async function readLocal(root: string, file: string, signal?: AbortSignal, max = MAX_FILE): Promise<Buffer> {
  signal?.throwIfAborted();
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > max || !within(root, await realpath(file))) throw invalid('诊断材料路径或大小无效。');
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const actual = await handle.stat();
    if (!actual.isFile() || actual.size > max) throw invalid('诊断材料路径或大小无效。');
    const bytes = Buffer.alloc(actual.size + 1);
    let length = 0;
    while (length < bytes.length) {
      signal?.throwIfAborted();
      const result = await handle.read(bytes, length, bytes.length - length, length);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length !== actual.size || (await handle.stat()).mtimeMs !== actual.mtimeMs) throw new RuntimeError('integrity', '诊断材料在读取期间发生变化。');
    return bytes.subarray(0, length);
  } finally { await handle.close(); }
}

async function rootDirectory(localRoot: string) {
  if (typeof localRoot !== 'string' || !isAbsolute(localRoot)) throw invalid('诊断数据根目录必须是绝对路径。');
  const info = await lstat(localRoot);
  if (!info.isDirectory() || info.isSymbolicLink()) throw invalid('诊断数据根目录无效。');
  return realpath(localRoot);
}

async function savedPackage(localRoot: string, uploadId: string, signal?: AbortSignal): Promise<DiagnosticExport> {
  if (!z.string().uuid().safeParse(uploadId).success) throw invalid('诊断上传编号无效。');
  const root = await rootDirectory(localRoot), directory = join(root, 'diagnostics');
  const bytes = await readLocal(root, join(directory, `${uploadId}.json`), signal);
  if (bytes.length > 2 * 1024 * 1024) throw new RuntimeError('resource-limit', '诊断索引超过大小限制。');
  let value;
  try { value = savedSchema.parse(JSON.parse(bytes.toString('utf8'))); }
  catch { throw invalid('保留的诊断包索引无效。'); }
  const packageFile = join(directory, `${uploadId}.zip`);
  if (value.uploadId !== uploadId || value.manifest.uploadId !== uploadId || value.manifest.threadId !== value.threadId || resolve(value.packageFile) !== packageFile) throw invalid('诊断包身份或路径不一致。');
  const info = await lstat(packageFile);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_TOTAL || !within(root, await realpath(packageFile))) throw invalid('保留的诊断包不可读取。');
  return { ...value, packageFile };
}

/** Retained packages are discovered by UUID under the private diagnostic directory, never an IPC path.
 * Metadata listing is capped at 100; an excessive retained set reports resource-limit, not silent truncation.
 */
export async function listSavedDiagnosticPackages(localRoot: string, { signal }: { signal?: AbortSignal } = {}) {
  const root = await rootDirectory(localRoot);
  let names: string[];
  try { names = (await readdir(join(root, 'diagnostics'))).filter(name => /^[a-f0-9-]{36}\.json$/u.test(name)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw failure(error); }
  if (names.length > 100) throw new RuntimeError('resource-limit', '保留的诊断包过多，请先归档已有材料。');
  const values = [];
  for (const name of names) {
    const saved = await savedPackage(root, name.slice(0, -5), signal);
    const manifest = saved.manifest as { cutoff: string };
    values.push({ uploadId: saved.uploadId, threadId: saved.threadId, createdAt: manifest.cutoff, bundleSha256: saved.bundleSha256, preview: saved.preview });
  }
  return values.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.uploadId.localeCompare(b.uploadId));
}

/** Reopen an immutable retained package and recheck its wire digest before reusing it for consent/upload. */
export async function openSavedDiagnosticPackage(localRoot: string, uploadId: string, { signal }: { signal?: AbortSignal } = {}) {
  const saved = await savedPackage(localRoot, uploadId, signal);
  const bytes = await readLocal(await rootDirectory(localRoot), saved.packageFile, signal, MAX_TOTAL);
  if (bytes.length > MAX_TOTAL || hash(bytes) !== saved.bundleSha256) throw new RuntimeError('integrity', '保留的诊断包摘要不匹配。');
  return saved;
}

/** Preview only manifest-listed, already-redacted ZIP members. Images are limited to PNG/JPEG.
 * Binary or malformed UTF-8 is never rendered as code/HTML; text is capped at 1 MiB with explicit truncation.
 */
export async function previewDiagnosticFile(localRoot: string, uploadId: string, path: string, { signal }: { signal?: AbortSignal } = {}) {
  const saved = await openSavedDiagnosticPackage(localRoot, uploadId, { signal });
  const manifest = saved.manifest as { files: { path: string; bytes: number; sha256: string }[] };
  const item = manifest.files.find(item => item.path === path);
  if (path !== 'manifest.json' && !item) throw invalid('该文件不在诊断包材料清单内。');
  const contents = await readLocal(await rootDirectory(localRoot), saved.packageFile, signal, MAX_TOTAL);
  if (hash(contents) !== saved.bundleSha256) throw new RuntimeError('integrity', '诊断包在预览前发生变化。');
  const entries = await readPackageZip(contents, { signal });
  const entry = entries.find(entry => entry.kind === 'file' && entry.path === path);
  if (!entry?.bytes || item && (entry.bytes.length !== item.bytes || hash(entry.bytes) !== item.sha256)) throw new RuntimeError('integrity', '诊断材料摘要不匹配。');
  const bytes = Buffer.from(entry.bytes);
  const png = bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (png || jpeg) {
    const mediaType = png ? 'image/png' as const : 'image/jpeg' as const;
    return { mediaType, dataUrl: `data:${mediaType};base64,${bytes.toString('base64')}`, truncated: false };
  }
  const truncated = bytes.length > 1024 * 1024;
  try { return { mediaType: 'text/plain' as const, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, Math.min(bytes.length, 1024 * 1024)), { stream: truncated }), truncated }; }
  catch { throw new RuntimeError('unsupported', '该二进制材料无法以安全文本预览。'); }
}

/** Read-only offline list. Host must own the same OS data-root lock as normal startup.
 * No recovery writes, model, MCP, browser, or execution initialization occurs here.
 * Invalid cursor/input rejects RuntimeError; abort stops file reads. Each call owns no persistent handles.
 */
export async function listOfflineDiagnosticThreads({ localRoot, cursor, limit = 50 }: { localRoot: string; cursor?: string; limit?: number }, { signal }: { signal?: AbortSignal } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw invalid('诊断列表数量无效。');
  const root = await rootDirectory(localRoot), directory = join(root, 'runs', '.records');
  let names: string[];
  try { names = (await readdir(directory)).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).sort(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { items: [], nextCursor: null }; throw failure(error); }
  if (names.length > MAX_ROWS) throw new RuntimeError('resource-limit', '诊断记录数量超过读取上限。');
  const threads = new Map<string, { threadId: string; title: string; lastUpdated: string; checkpointAvailable: boolean }>();
  const graphOwners = new Map<string, string | null>();
  const identity: string[] = [];
  for (const name of names) {
    signal?.throwIfAborted();
    try {
      const bytes = await readLocal(root, join(directory, name), signal);
      identity.push(hash(bytes));
      const record = JSON.parse(bytes.toString('utf8'));
      if (typeof record.runId !== 'string' || hash(record.runId) + '.json' !== name || typeof record.threadId !== 'string') continue;
      identifier(record.threadId, 'threadId');
      const lastUpdated = record.endedAt ?? record.startedAt;
      if (typeof lastUpdated !== 'string' || !Number.isFinite(Date.parse(lastUpdated))) continue;
      const old = threads.get(record.threadId);
      if (!old || old.lastUpdated < lastUpdated) threads.set(record.threadId, { threadId: record.threadId, title: typeof record.details?.title === 'string' ? record.details.title.slice(0, 256) : record.threadId, lastUpdated, checkpointAvailable: false });
      if (typeof record.graphThreadId === 'string' && !record.graphThreadId.startsWith('legacy:')) {
        const previous = graphOwners.get(record.graphThreadId);
        graphOwners.set(record.graphThreadId, previous === undefined || previous === record.threadId ? record.threadId : null);
      }
    } catch (error) { if (signal?.aborted) throw error; }
  }
  let db: Database.Database | undefined;
  try {
    const file = join(root, 'checkpoints.sqlite');
    if ((await lstat(file)).isSymbolicLink() || !within(root, await realpath(file))) throw invalid('checkpoint 路径无效。');
    db = new Database(file, { readonly: true, fileMustExist: true, timeout: 1000 });
    const exists = db.prepare('SELECT 1 FROM checkpoints WHERE thread_id=? LIMIT 1');
    for (const [graphId, threadId] of graphOwners) if (threadId && exists.get(graphId)) threads.get(threadId)!.checkpointAvailable = true;
  } catch { /* Availability is false when existing checkpoint evidence cannot be read; export records the cause category. */ }
  finally { db?.close(); }
  const revision = hash(JSON.stringify([identity, [...threads.values()].map(t => [t.threadId, t.checkpointAvailable])]));
  let offset = 0;
  if (cursor !== undefined) {
    try { const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString()); if (parsed.revision !== revision || !Number.isSafeInteger(parsed.offset) || parsed.offset < 0) throw new Error(); offset = parsed.offset; }
    catch { throw invalid('诊断列表已变化，请重新读取。'); }
  }
  const items = [...threads.values()].sort((a, b) => b.lastUpdated.localeCompare(a.lastUpdated) || a.threadId.localeCompare(b.threadId));
  return { items: items.slice(offset, offset + limit), nextCursor: offset + limit < items.length ? Buffer.from(JSON.stringify({ revision, offset: offset + limit })).toString('base64url') : null };
}

/** Freeze logical evidence for exactly one thread. Online caller holds its runtime export lease;
 * offline caller holds the host's exclusive data-root lock. Does not create or repair source data.
 * Output is an immutable ZIP owned by the caller; cancellation removes only this call's unfinished ZIP.
 * Expected errors: invalid-request, resource-limit, aborted, storage; raw causes never cross IPC.
 */
export async function exportOfflineThreadDiagnostics(options: DiagnosticExportRequest & { localRoot: string; redact?: (value: string) => string }, { signal }: { signal?: AbortSignal } = {}): Promise<DiagnosticExport> {
  const threadId = identifier(options.threadId, 'threadId');
  if (!Array.isArray(options.includeAttachments) || options.includeAttachments.length > 100 || options.includeAttachments.some(id => typeof id !== 'string') || new Set(options.includeAttachments).size !== options.includeAttachments.length || typeof options.outputDirectory !== 'string' || !isAbsolute(options.outputDirectory)) throw invalid('诊断导出参数无效。');
  const root = await rootDirectory(options.localRoot);
  const uploadId = randomUUID(), missing: DiagnosticPreview['missing'] = [], attachments: DiagnosticPreview['attachments'] = [];
  const entries: PackageEntry[] = [], selected = new Set(options.includeAttachments);
  const images = new Map<string, { bytes: Buffer; extension: 'png' | 'jpg' }>();
  const imagePattern = /data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+={0,2}/gu;
  const discoverImages = (value: unknown, runId: string, depth = 0): void => {
    if (depth > 64) return;
    if (typeof value === 'string') {
      for (const match of value.matchAll(imagePattern)) {
        const id = `image-${hash(runId + '\0' + match[0])}`;
        if (images.has(id)) continue;
        if (images.size >= 100) throw new RuntimeError('resource-limit', '诊断截图数量超过上限。');
        const bytes = Buffer.from(match[0].slice(match[0].indexOf(',') + 1), 'base64');
        if (bytes.length > MAX_FILE) throw new RuntimeError('resource-limit', '诊断截图超过大小限制。');
        images.set(id, { bytes, extension: match[1] === 'png' ? 'png' : 'jpg' });
        attachments.push({ id, name: `${runId} 截图 ${images.size}` });
      }
    } else if (value && typeof value === 'object') for (const child of Object.values(value)) discoverImages(child, runId, depth + 1);
  };
  let total = 0;
  const scrub = (value: unknown, key = '', depth = 0): unknown => {
    if (depth > 64) { missing.push({ item: 'value', reason: 'serialization-depth' }); return '[omitted]'; }
    if (/(?:api.?key|token|authorization|cookie|password|secret|credential)/i.test(key)) return '[redacted]';
    if (/^(?:screenshot|sourcePath|scriptPath|artifactDir|directory|workingDirectory|workspacePath)$/i.test(key)) return '[attachment-excluded]';
    if (typeof value === 'string') {
      if (/^\s*[\[{]/u.test(value)) {
        try { return JSON.stringify(scrub(JSON.parse(value), '', depth + 1)); } catch { /* Ordinary text stays text. */ }
      }
      return (options.redact ?? String)(value).replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [redacted]').replace(imagePattern, '[attachment-excluded]');
    }
    if (Array.isArray(value)) return value.map(v => scrub(v, '', depth + 1));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v, k, depth + 1)]));
    return value;
  };
  const add = (path: string, value: unknown, runId?: string) => {
    if (runId) discoverImages(value, runId);
    const bytes = Buffer.from(JSON.stringify(scrub(value)) + '\n');
    total += bytes.length;
    if (bytes.length > MAX_FILE || total > MAX_TOTAL || entries.length >= 998) throw new RuntimeError('resource-limit', '诊断材料超过本机导出限制。');
    entries.push({ path, kind: 'file', bytes });
  };
  const records: Record<string, unknown>[] = [];
  const checkpointHeads = new Map<string, { namespace: string; checkpointId: string }[]>();
  const graphOwners = new Map<string, string | null>();
  const directory = join(root, 'runs', '.records');
  let names: string[] = [];
  try { names = (await readdir(directory)).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).sort(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw failure(error); }
  if (names.length > MAX_ROWS) throw new RuntimeError('resource-limit', '诊断记录数量超过读取上限。');
  for (const name of names) {
    signal?.throwIfAborted();
    let raw;
    try { raw = JSON.parse((await readLocal(root, join(directory, name), signal)).toString()); }
    catch (error) { if (signal?.aborted) throw error; missing.push({ item: name, reason: 'unreadable-record-unattributed' }); continue; }
    if (typeof raw.runId !== 'string' || hash(raw.runId) + '.json' !== name) { missing.push({ item: name, reason: 'invalid-run-identity' }); continue; }
    if (typeof raw.threadId === 'string' && typeof raw.graphThreadId === 'string') {
      const previous = graphOwners.get(raw.graphThreadId);
      graphOwners.set(raw.graphThreadId, previous === undefined || previous === raw.threadId ? raw.threadId : null);
    }
    if (raw.threadId !== threadId) continue;
    if (['preparing', 'running'].includes(raw.status) && !options.redact) {
      // Offline exports preserve the disk-observed state. They never rewrite it as a recovered Run.
      missing.push({ item: raw.runId, reason: 'disk-state-incomplete' });
    }
    records.push(raw);
    add(`runs/${hash(raw.runId)}.json`, raw, raw.runId);
  }
  if (!records.length) throw invalid('没有可证明属于此会话的执行记录。');
  const sessionFile = join(root, 'runs', '.sessions', hash(threadId) + '.json');
  try {
    const session = JSON.parse((await readLocal(root, sessionFile, signal)).toString());
    if (session.snapshot?.sessionId !== threadId) throw invalid('会话记录身份不一致。');
    add('thread.json', session);
  } catch (error) { if (signal?.aborted) throw error; missing.push({ item: 'thread.json', reason: 'session-unavailable' }); }
  let db: Database.Database | undefined;
  try {
    const file = join(root, 'checkpoints.sqlite');
    if ((await lstat(file)).isSymbolicLink() || !within(root, await realpath(file))) throw invalid('checkpoint 路径无效。');
    db = new Database(file, { readonly: true, fileMustExist: true, timeout: 1000 });
    let sourceBytes = total;
    const read = db.transaction(() => {
      // Names come only from these fixed column lists. octet_length measures SQLite values before
      // materializing BLOBs in JS; the same read transaction keeps the measured snapshot stable.
      const measure = (table: 'checkpoints' | 'writes', columns: string[], graphId: string) => db!.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(bytes),0) AS bytes FROM (SELECT ${columns.map(column => `COALESCE(octet_length(${column}),0)`).join('+')} AS bytes FROM ${table} WHERE thread_id=? LIMIT ?)`).get(graphId, MAX_ROWS + 1) as { count: number; bytes: number };
      for (const record of records) {
        signal?.throwIfAborted();
        const graphId = record.graphThreadId;
        if (typeof graphId !== 'string' || graphId.startsWith('legacy:')) { missing.push({ item: String(record.runId), reason: 'checkpoint-missing' }); continue; }
        if (graphOwners.get(graphId) !== threadId) { missing.push({ item: String(record.runId), reason: 'checkpoint-owner-conflict' }); continue; }
        const checkpointSize = measure('checkpoints', ['thread_id', 'checkpoint_ns', 'checkpoint_id', 'parent_checkpoint_id', 'type', 'checkpoint', 'metadata'], graphId);
        const writeSize = measure('writes', ['thread_id', 'checkpoint_ns', 'checkpoint_id', 'task_id', 'task_path', 'idx', 'channel', 'type', 'value'], graphId);
        if ([checkpointSize, writeSize].some(size => !Number.isSafeInteger(size.count) || size.count > MAX_ROWS || !Number.isSafeInteger(size.bytes) || size.bytes < 0) || sourceBytes + checkpointSize.bytes + writeSize.bytes > MAX_TOTAL) throw new RuntimeError('resource-limit', 'checkpoint 原始材料超过导出读取上限。');
        sourceBytes += checkpointSize.bytes + writeSize.bytes;
        const rows = db!.prepare('SELECT thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata FROM checkpoints WHERE thread_id=? ORDER BY checkpoint_ns, checkpoint_id LIMIT ?').all(graphId, MAX_ROWS + 1) as Record<string, unknown>[];
        const writes = db!.prepare('SELECT thread_id, checkpoint_ns, checkpoint_id, task_id, task_path, idx, channel, type, value FROM writes WHERE thread_id=? ORDER BY checkpoint_ns,checkpoint_id,task_path,task_id,idx LIMIT ?').all(graphId, MAX_ROWS + 1) as Record<string, unknown>[];
        if (rows.length > MAX_ROWS || writes.length > MAX_ROWS) throw new RuntimeError('resource-limit', 'checkpoint 记录超过导出上限。');
        if (!rows.length) missing.push({ item: String(record.runId), reason: 'checkpoint-missing' });
        const heads = new Map<string, string>();
        for (const row of rows) if (typeof row.checkpoint_ns === 'string' && typeof row.checkpoint_id === 'string') heads.set(row.checkpoint_ns, row.checkpoint_id);
        checkpointHeads.set(String(record.runId), [...heads].map(([namespace, checkpointId]) => ({ namespace, checkpointId })));
        const decode = (row: Record<string, unknown>, keys: string[]) => {
          const result = { ...row };
          for (const key of keys) {
            if (row[key] == null) continue;
            if (row.type !== 'json') { result[key] = '[uninterpreted-value]'; missing.push({ item: `${record.runId}/${row.checkpoint_ns}/${row.checkpoint_id}/${key}`, reason: 'unsupported-value' }); continue; }
            try { result[key] = JSON.parse(Buffer.from(row[key] as Uint8Array).toString('utf8')); }
            catch { result[key] = '[unreadable-value]'; missing.push({ item: `${record.runId}/${key}`, reason: 'serialization-invalid' }); }
          }
          return result;
        };
        add(`checkpoints/${hash(String(record.runId))}.json`, { serialization: 'sqlite-saver:1.1.0;jsonplus:1;read-only-json', checkpoints: rows.map(row => decode(row, ['checkpoint', 'metadata'])), pendingWrites: writes.map(row => decode(row, ['value'])) }, String(record.runId));
      }
    });
    read();
  } catch (error) { if (signal?.aborted || error instanceof RuntimeError && error.kind === 'resource-limit') throw error; missing.push({ item: 'checkpoints', reason: 'checkpoint-unavailable' }); }
  finally { db?.close(); }
  for (const id of selected) {
    const image = images.get(id);
    if (!image) throw invalid('所选附件不属于此会话或已不可用。');
    total += image.bytes.length;
    if (total > MAX_TOTAL) throw new RuntimeError('resource-limit', '诊断附件超过总大小限制。');
    entries.push({ path: `attachments/${id}.${image.extension}`, kind: 'file', bytes: image.bytes });
  }
  const cutoff = new Date().toISOString();
  // Old local records do not retain a verified installation identity. A current login cannot
  // establish which device produced historical evidence, so keep that attribution explicitly unknown.
  missing.push({ item: 'sourceInstallationId', reason: 'source-identity-unavailable' });
  const files = entries.map(entry => ({ path: entry.path, bytes: entry.bytes!.byteLength, sha256: hash(entry.bytes!) }));
  const manifest = { schemaVersion: 1, uploadId, threadId, cutoff, sourceInstallationId: null, redactionPolicy: 'omniops-diagnostics:1', engine: 'langgraph:1.5.0;sqlite-saver:1.1.0', eventSequenceBase: 0, runs: records.map(r => {
    const details = r.details && typeof r.details === 'object' ? r.details as { events?: unknown[]; snapshot?: { desktopVersion?: unknown } } : undefined;
    const desktopVersion = details?.snapshot?.desktopVersion;
    return { runId: r.runId, graphThreadId: r.graphThreadId, diskStatus: r.status, collectedAt: cutoff,
      clientVersion: typeof desktopVersion === 'string' && desktopVersion.length <= 128 ? desktopVersion : null,
      lastEventSequence: Array.isArray(details?.events) && details.events.length ? details.events.length - 1 : null,
      namespaces: checkpointHeads.get(String(r.runId)) ?? [] };
  }), files, missing };
  add('manifest.json', manifest);
  const folders = new Set<string>();
  for (const entry of entries) {
    const segments = entry.path.split('/');
    for (let length = 1; length < segments.length; length++) folders.add(segments.slice(0, length).join('/'));
  }
  entries.unshift(...[...folders].sort().map(path => ({ path, kind: 'folder' as const })));
  signal?.throwIfAborted();
  await mkdir(options.outputDirectory, { recursive: true, mode: 0o700 });
  if ((await lstat(options.outputDirectory)).isSymbolicLink()) throw invalid('导出目录不能是符号链接。');
  const packageFile = join(await realpath(resolve(options.outputDirectory)), `${uploadId}.zip`);
  try {
    const zipped = await writePackageZip(entries, packageFile, { signal });
    return { uploadId, threadId, packageFile, bundleSha256: zipped.sha256, manifest, preview: { files: entries.map(e => ({ path: e.path, bytes: e.bytes?.byteLength ?? 0 })), missing, attachments, redactionPolicy: 'omniops-diagnostics:1' } };
  } catch (error) { await rm(packageFile, { force: true }); if (error instanceof RuntimeError || signal?.aborted) throw error; throw failure(error); }
}
