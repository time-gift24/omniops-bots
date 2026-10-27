import { createHash } from 'node:crypto';
import { lstat, mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { AgentCard } from '@a2a-js/sdk';
import type { ServerCallContext } from '@a2a-js/sdk/server';
import type { OfficialEndpoint } from './a2a/index.ts';
import { RuntimeError, invalid } from './errors.ts';
import { identifier } from './input.ts';
import { PACKAGE_LIMITS, packageContentId, packagePath, readPackage, readPackageZip, writePackageFiles, writePackageZip, type PackageLimits } from './package.ts';

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u).refine(value => !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu.test(value));
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const text = z.string().min(1).max(4096).refine(value => !/[\x00-\x1f\x7f]/u.test(value));
const time = z.string().datetime({ offset: true });
const permission = z.enum(['official-read', 'official-maintain', 'task-call', 'diagnostic-own', 'diagnostic-read']);
const sessionSchema = z.object({ schemaVersion: z.literal(1), organizationId: text, callerId: text, installationId: text, expiresAt: time, permissions: z.array(permission).max(16) }).strict();
const referenceSchema = z.object({ kind: z.enum(['agent', 'skill']), id, contentId: digest }).strict();
const fileSchema = z.discriminatedUnion('kind', [
  z.object({ path: text, kind: z.literal('folder') }).strict(),
  z.object({ path: text, kind: z.literal('file'), bytes: z.number().int().nonnegative(), sha256: digest, url: z.string().max(8192).optional() }).strict(),
]);
const manifestSchema = z.object({ schemaVersion: z.literal(1), id, contentId: digest, files: z.array(fileSchema).max(1000), package: z.object({ url: z.string().max(8192), bytes: z.number().int().nonnegative(), sha256: digest }).strict().optional(), agentCard: z.unknown().optional(), releaseTag: z.string().regex(/^v\.\d+\.\d+\.\d+$/u).optional() }).strict();
export type VerifiedSession = z.infer<typeof sessionSchema>;
export type PackageReference = z.infer<typeof referenceSchema>;
export type PackageManifest = z.infer<typeof manifestSchema>;
export type PlatformLimits = PackageLimits & { requestTimeoutMs: number; maxJsonBytes: number };
export type DownloadedPackage = { directory: string; contentId: string; manifest: PackageManifest; discard(): Promise<void> };
export type PlatformOptions = { baseUrl: string; allowedDownloadOrigins: string[]; getAuthorization(options: { signal: AbortSignal }): Promise<string>; limits?: Partial<PlatformLimits> };
type CallOptions = { signal?: AbortSignal };
const DEFAULT_LIMITS: PlatformLimits = { ...PACKAGE_LIMITS, requestTimeoutMs: 15_000, maxJsonBytes: 2 * 1024 * 1024 };
function checked<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw invalid('平台请求或响应格式无效。');
  return result.data;
}
function origin(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw invalid('平台地址无效。'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw invalid('平台地址必须为不含凭据的 HTTPS origin。');
  return url;
}
function authorization(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > 8192 || /[^\x20-\x7e]/u.test(value)) throw new RuntimeError('authentication', '平台凭据不可用。');
  return value;
}
function checkSignal(value: AbortSignal | undefined): void { if (value !== undefined && !(value instanceof AbortSignal)) throw invalid('取消信号无效。'); value?.throwIfAborted(); }
async function body(response: Response, max: number, signal: AbortSignal): Promise<Buffer> {
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > max)) { await response.body?.cancel(); throw new RuntimeError('resource-limit', '平台响应超过大小限制。'); }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) throw new RuntimeError('resource-limit', '平台响应超过大小限制。');
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
const failureFor = (status: number) => new RuntimeError(status === 401 ? 'authentication' : status === 403 ? 'forbidden' : status === 404 ? 'not-found' : status === 409 ? 'revision-conflict' : status === 413 ? 'resource-limit' : status === 429 ? 'rate-limited' : 'unavailable', status === 409 ? '平台内容或发布基线冲突，请保留编辑并重新核对。' : '平台请求未成功，已有材料保留。');
const draftSchema = z.object({ schemaVersion: z.literal(1), draftRevisionId: id, contentId: digest, savedAt: time, revision: text }).strict();
const previewSchema = z.object({ schemaVersion: z.literal(1), contentId: digest, baseline: text, affectedAgents: z.array(z.object({ agentId: id, expectedContentId: digest }).strict()).max(256) }).strict();
const receiptSchema = z.object({ schemaVersion: z.literal(1), releaseId: id, versions: z.array(z.object({ kind: z.enum(['agent', 'skill']), id, contentId: digest, releaseTag: z.string().regex(/^v\.\d+\.\d+\.\d+$/u) }).strict()).max(257) }).strict();
const diagnosticLimitsSchema = z.object({ schemaVersion: z.literal(1), formatVersions: z.array(z.number().int().positive()).min(1).max(16), maxPackageBytes: z.number().int().positive(), maxExpandedBytes: z.number().int().positive(), maxFiles: z.number().int().positive() }).strict();
const diagnosticStateSchema = z.discriminatedUnion('state', [
  z.object({ schemaVersion: z.literal(1), state: z.literal('pending'), uploadId: text }).strict(),
  z.object({ schemaVersion: z.literal(1), state: z.literal('failed'), uploadId: text, code: text }).strict(),
  z.object({ schemaVersion: z.literal(1), state: z.literal('received'), diagnosticId: text, uploadId: text, threadId: text, bundleSha256: digest, receivedAt: time, incomplete: z.boolean(), missing: z.array(text).max(1000) }).strict(),
]);
export type DiagnosticUploadState = z.infer<typeof diagnosticStateSchema>;
export type DraftUpload = { kind: 'agent' | 'skill'; id: string; directory: string; contentId: string; expectedRevision: string | null; idempotencyKey: string };
export type SkillRelease = { kind: 'skill'; id: string; draftRevisionId: string; releaseTag: string; baseline: string; affectedAgents: { agentId: string; expectedContentId: string; releaseTag: string }[]; idempotencyKey: string };
export type AgentRelease = { kind: 'agent'; id: string; draftRevisionId: string; releaseTag: string; expectedContentId: string | null; idempotencyKey: string };

/** HTTPS platform boundary. Construction validates options but never performs network I/O.
 * const client = createPlatformClient({baseUrl, allowedDownloadOrigins:[baseUrl], getAuthorization});
 * const {session,authorization} = await client.credentials({signal}); // one credential snapshot
 * await client.close({deadline:performance.now()+1000});
 * Errors are safe RuntimeError categories; caller signals cancel only their request.
 */
export function createPlatformClient(options: PlatformOptions) {
  if (!options || typeof options.getAuthorization !== 'function' || !Array.isArray(options.allowedDownloadOrigins)) throw invalid('平台配置无效。');
  const base = origin(options.baseUrl), allowed = new Set([base.origin, ...options.allowedDownloadOrigins.map(value => origin(value).origin)]);
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  for (const key of Object.keys(limits) as (keyof PlatformLimits)[]) if (!Number.isSafeInteger(limits[key]) || limits[key] <= 0 || limits[key] > DEFAULT_LIMITS[key]) throw invalid('平台容量限制无效。');
  const closing = new AbortController(), operations = new Set<Promise<unknown>>();
  let downloads = 0;
  const downloadWaiters: Array<() => void> = [];
  async function downloadSlot(signal: AbortSignal): Promise<() => void> {
    const releaseSlot = () => { downloads--; downloadWaiters.shift()?.(); };
    if (downloads >= 2) {
      if (downloadWaiters.length >= 64) throw new RuntimeError('resource-limit', '下载等待已达上限。');
      await new Promise<void>((resolve, reject) => {
        const ready = () => { downloads++; signal.removeEventListener('abort', abort); resolve(); };
        const abort = () => { const index = downloadWaiters.indexOf(ready); if (index >= 0) downloadWaiters.splice(index, 1); reject(signal.reason); };
        downloadWaiters.push(ready); signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
    } else downloads++;
    if (signal.aborted) { releaseSlot(); signal.throwIfAborted(); }
    let released = false;
    return () => { if (released) return; released = true; releaseSlot(); };
  }
  function operation<T>(call: CallOptions, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
    checkSignal(call.signal);
    if (closing.signal.aborted) return Promise.reject(new RuntimeError('unavailable', '平台连接已关闭。'));
    const signal = AbortSignal.any([closing.signal, ...(call.signal ? [call.signal] : []), AbortSignal.timeout(limits.requestTimeoutMs)]);
    const work = Promise.resolve().then(() => { signal.throwIfAborted(); return action(signal); }).catch((cause: unknown) => {
      if (cause instanceof RuntimeError) throw cause;
      if (signal.aborted) throw Object.assign(new RuntimeError(call.signal?.aborted ? 'aborted' : closing.signal.aborted ? 'unavailable' : 'timeout', '平台请求已停止或超时。'), { cause });
      throw Object.assign(new RuntimeError('unavailable', '平台暂时不可用。'), { cause });
    });
    operations.add(work); void work.finally(() => operations.delete(work)).catch(() => {});
    return work;
  }
  async function request(url: string, signal: AbortSignal, init: RequestInit = {}, credential?: string, max = limits.maxJsonBytes): Promise<{ bytes: Buffer; status: number }> {
    const address = new URL(url, base);
    if (address.protocol !== 'https:' || address.username || address.password || address.hash || !allowed.has(address.origin)) throw new RuntimeError('forbidden', '物料下载来源未获允许。');
    const headers = new Headers(init.headers);
    if (address.origin === base.origin) headers.set('Authorization', credential ?? authorization(await options.getAuthorization({ signal })));
    else headers.delete('Authorization');
    const response = await fetch(address, { ...init, headers, signal, redirect: 'manual' });
    if (!response.ok) {
      const failure = failureFor(response.status);
      const bytes = await body(response, Math.min(limits.maxJsonBytes,64*1024), signal);
      try {
        const code = JSON.parse(bytes.toString('utf8'))?.error?.code;
        const allowedErrors = new Set(['invalid-request','unsupported-schema','invalid-tag','invalid-package','unauthenticated','forbidden','not-found','revision-conflict','tag-conflict','idempotency-conflict','payload-too-large','rate-limited','temporarily-unavailable']);
        if (allowedErrors.has(code)) throw new RuntimeError(code === 'unauthenticated' ? 'authentication' : code === 'payload-too-large' ? 'resource-limit' : code, failure.message);
      } catch(error) { if(error instanceof RuntimeError)throw error; }
      throw failure;
    }
    return { bytes: await body(response, max, signal), status: response.status };
  }
  async function json(url: string, signal: AbortSignal, init: RequestInit = {}, credential?: string): Promise<unknown> {
    const { bytes } = await request(url, signal, init, credential);
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw invalid('平台 JSON 响应无效。'); }
  }
  async function credentials(signal: AbortSignal) {
    const value = authorization(await options.getAuthorization({ signal }));
    const session = checked(sessionSchema, await json('/api/session', signal, {}, value));
    for (const key of ['organizationId', 'callerId', 'installationId'] as const) identifier(session[key], key);
    if (Date.parse(session.expiresAt) <= Date.now() || new Set(session.permissions).size !== session.permissions.length) throw new RuntimeError('authentication', '平台会话已失效。');
    return { authorization: value, session };
  }
  function reference(value: PackageReference) { return checked(referenceSchema, value); }
  function route(value: PackageReference) { return `/api/${value.kind === 'agent' ? 'agents' : 'skills'}/${encodeURIComponent(value.id)}/versions/${value.contentId}`; }
  async function manifest(ref: PackageReference, signal: AbortSignal, credential?: string): Promise<PackageManifest> {
    const value = checked(manifestSchema, await json(route(ref), signal, {}, credential));
    if (value.id !== ref.id || value.contentId !== ref.contentId || value.files.length > limits.maxEntries) throw invalid('平台物料身份不匹配。');
    let total = 0;
    const paths = new Set<string>();
    for (const file of value.files) {
      packagePath(file.path, limits);
      if (paths.has(file.path.toLowerCase())) throw invalid('平台清单存在路径冲突。');
      paths.add(file.path.toLowerCase());
      if (file.kind === 'file') {
        if (file.bytes > limits.maxFileBytes) throw new RuntimeError('resource-limit', '物料文件超过上限。');
        total += file.bytes;
      }
    }
    if (total > limits.maxExpandedBytes || value.package && value.package.bytes > limits.maxPackageBytes) throw new RuntimeError('resource-limit', '物料包超过上限。');
    if (ref.kind === 'agent' && (value.files.length !== 2 || !['agent.json', 'prompt.md'].every(name => value.files.some(file => file.path === name && file.kind === 'file')))) throw invalid('正式 Agent 必须恰有 agent.json 与 prompt.md。');
    return value;
  }
  const client = {
    credentials: (call: CallOptions = {}) => operation(call, credentials),
    session: (call: CallOptions = {}) => operation(call, async signal => (await credentials(signal)).session),
    resolveEndpoint(context: ServerCallContext, tenant: string, call: { signal: AbortSignal }): Promise<OfficialEndpoint> {
      return operation(call, async signal => {
        const match = /^agent\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/([a-f0-9]{64})$/u.exec(tenant);
        if (!match || !context.user?.isAuthenticated) throw new RuntimeError('forbidden', '任务入口不可用。');
        const trusted = context.state.get('omniops.principal') as Record<string, unknown> | undefined;
        const verified = await credentials(signal);
        if (!trusted || !['organizationId', 'callerId', 'installationId'].every(key => trusted[key] === verified.session[key as keyof VerifiedSession]) || !verified.session.permissions.includes('task-call')) throw new RuntimeError('forbidden', '任务入口不可用。');
        const ref = reference({ kind: 'agent', id: match[1]!, contentId: match[2]! });
        const value = await manifest(ref, signal, verified.authorization);
        if (!value.agentCard || typeof value.agentCard !== 'object') throw invalid('任务 AgentCard 缺失。');
        const card = AgentCard.fromJSON(value.agentCard);
        if (card.version !== ref.contentId || !card.supportedInterfaces.some(entry => entry.tenant === tenant && entry.protocolVersion === '1.0' && entry.protocolBinding === 'urn:omniops:a2a:binding:wss-jsonrpc:v1' && entry.url === base.href.replace('https:', 'wss:').replace(/\/$/u, '') + '/api/clients/connect')) throw invalid('任务 AgentCard 与入口不匹配。');
        return { agentId: ref.id, contentId: ref.contentId, card };
      });
    },
    catalog(raw: {kind:'agent'|'skill';cursor?:string;limit?:number}, call:CallOptions={}) {
      const value=checked(z.object({kind:z.enum(['agent','skill']),cursor:text.optional(),limit:z.number().int().min(1).max(100).optional()}).strict(),raw);
      return operation(call,async signal=>{
        const query=new URLSearchParams({limit:String(value.limit??50)});if(value.cursor)query.set('cursor',value.cursor);
        return checked(z.object({schemaVersion:z.literal(1).optional(),items:z.array(z.object({id,name:text,contentId:digest.nullable()}).strict()).max(100),nextCursor:text.nullable()}).strict(),await json(`/api/${value.kind==='agent'?'agents':'skills'}?${query}`,signal));
      });
    },
    versions(raw: {kind:'agent'|'skill';id:string;cursor?:string;limit?:number}, call:CallOptions={}) {
      const value=checked(z.object({kind:z.enum(['agent','skill']),id,cursor:text.optional(),limit:z.number().int().min(1).max(100).optional()}).strict(),raw);
      return operation(call,async signal=>{
        const query=new URLSearchParams({limit:String(value.limit??50)});if(value.cursor)query.set('cursor',value.cursor);
        return checked(z.object({schemaVersion:z.literal(1).optional(),items:z.array(z.object({contentId:digest,releaseTag:z.string().regex(/^v\.\d+\.\d+\.\d+$/u),publishedAt:time.optional()}).strict()).max(100),nextCursor:text.nullable()}).strict(),await json(`/api/${value.kind==='agent'?'agents':'skills'}/${value.id}/versions?${query}`,signal));
      });
    },
    drafts(raw:{kind:'agent'|'skill';id:string;cursor?:string;limit?:number},call:CallOptions={}) {
      const value=checked(z.object({kind:z.enum(['agent','skill']),id,cursor:text.optional(),limit:z.number().int().min(1).max(100).optional()}).strict(),raw);
      return operation(call,async signal=>{
        const query=new URLSearchParams({limit:String(value.limit??50)});if(value.cursor)query.set('cursor',value.cursor);
        return checked(z.object({schemaVersion:z.literal(1).optional(),items:z.array(z.object({draftRevisionId:id,contentId:digest,savedAt:time}).strict()).max(100),nextCursor:text.nullable(),head:id.nullable()}).strict(),await json(`/api/${value.kind==='agent'?'agents':'skills'}/${value.id}/drafts?${query}`,signal));
      });
    },
    fetchPackage(raw: PackageReference, call: CallOptions = {}): Promise<DownloadedPackage> {
      const ref = reference(raw);
      return operation(call, async signal => {
        const release = await downloadSlot(signal);
        let directory: string | undefined;
        try {
          const value = await manifest(ref, signal);
          let entries;
          if (value.package) {
            const response = await request(value.package.url, signal, {}, undefined, limits.maxPackageBytes);
            if (response.bytes.length !== value.package.bytes || hash(response.bytes) !== value.package.sha256) throw new RuntimeError('integrity', '物料传输摘要不匹配。');
            entries = await readPackageZip(response.bytes, { signal, limits });
          } else {
            entries = [];
            for (const file of value.files) {
              if (file.kind === 'folder') entries.push({ path: file.path, kind: 'folder' as const });
              else {
                if (!file.url) throw invalid('物料文件下载地址缺失。');
                const result = await request(file.url, signal, {}, undefined, limits.maxFileBytes);
                entries.push({ path: file.path, kind: 'file' as const, bytes: result.bytes });
              }
            }
          }
          if (entries.length !== value.files.length || packageContentId(entries) !== ref.contentId) throw new RuntimeError('integrity', '物料完整包摘要不匹配。');
          for (const file of value.files) {
            const entry = entries.find(item => item.path === file.path && item.kind === file.kind);
            if (!entry || file.kind === 'file' && (!entry.bytes || entry.bytes.byteLength !== file.bytes || hash(entry.bytes) !== file.sha256)) throw new RuntimeError('integrity', '物料文件清单不匹配。');
          }
          directory = await mkdtemp(path.join(tmpdir(), 'omniops-package-'));
          await writePackageFiles(entries, directory, { signal, limits });
          const owned = directory;
          return { directory: owned, contentId: ref.contentId, manifest: value, discard: () => rm(owned, { recursive: true, force: true }) };
        } catch (error) { if (directory) await rm(directory, { recursive: true, force: true }); throw error; }
        finally { release(); }
      });
    },
    createResource(raw: { kind: 'agent' | 'skill'; name: string; idempotencyKey: string }, call: CallOptions = {}) {
      const value = checked(z.object({ kind: z.enum(['agent', 'skill']), name: text, idempotencyKey: text }).strict(), raw);
      return operation(call, async signal => checked(z.object({ schemaVersion: z.literal(1), kind: z.literal(value.kind), id }).strict(), await json(`/api/${value.kind === 'agent' ? 'agents' : 'skills'}`, signal, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': value.idempotencyKey }, body: JSON.stringify({ schemaVersion: 1, name: value.name }) })));
    },
    uploadDraft(raw: DraftUpload, call: CallOptions = {}) {
      const value = checked(z.object({ kind: z.enum(['agent', 'skill']), id, directory: text, contentId: digest, expectedRevision: text.nullable(), idempotencyKey: text }).strict(), raw);
      return operation(call, async signal => {
        if (!path.isAbsolute(value.directory)) throw invalid('草稿目录无效。');
        const entries = await readPackage(value.directory, { signal, limits });
        if (packageContentId(entries) !== value.contentId) throw new RuntimeError('integrity', '草稿上传内容已改变。');
        const temporary = await mkdtemp(path.join(tmpdir(), 'omniops-draft-'));
        try {
          const file = path.join(temporary, 'package.zip');
          await writePackageZip(entries, file, { signal, limits });
          const bytes = await readFile(file), form = new FormData();
          form.set('manifest', JSON.stringify({ schemaVersion: 1, contentId: value.contentId, expectedRevision: value.expectedRevision, files: entries.map(entry => entry.kind === 'folder' ? { path: entry.path, kind: entry.kind } : { path: entry.path, kind: entry.kind, bytes: entry.bytes!.byteLength, sha256: hash(entry.bytes!) }) }));
          form.set('package', new Blob([new Uint8Array(bytes)]), 'package.zip');
          return checked(draftSchema, await json(`/api/${value.kind === 'agent' ? 'agents' : 'skills'}/${value.id}/drafts`, signal, { method: 'POST', headers: { 'Idempotency-Key': value.idempotencyKey }, body: form }));
        } finally { await rm(temporary, { recursive: true, force: true }); }
      });
    },
    previewSkillRelease(raw: { skillId: string; draftRevisionId: string }, call: CallOptions = {}) {
      const value = checked(z.object({ skillId: id, draftRevisionId: id }).strict(), raw);
      return operation(call, async signal => checked(previewSchema, await json(`/api/skills/${value.skillId}/publish-preview`, signal, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ schemaVersion: 1, draftRevisionId: value.draftRevisionId }) })));
    },
    publish(raw: SkillRelease | AgentRelease, call: CallOptions = {}) {
      const tag = z.string().regex(/^v\.\d+\.\d+\.\d+$/u);
      const common = { id, draftRevisionId: id, releaseTag: tag, idempotencyKey: text };
      const value = checked(z.discriminatedUnion('kind', [z.object({ ...common, kind: z.literal('agent'), expectedContentId: digest.nullable() }).strict(), z.object({ ...common, kind: z.literal('skill'), baseline: text, affectedAgents: z.array(z.object({ agentId: id, expectedContentId: digest, releaseTag: tag }).strict()).max(256) }).strict()]), raw);
      const { kind, id: resourceId, idempotencyKey, ...data } = value;
      return operation(call, async signal => checked(receiptSchema, await json(`/api/${kind === 'agent' ? 'agents' : 'skills'}/${resourceId}/releases`, signal, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey }, body: JSON.stringify({ schemaVersion: 1, ...data }) })));
    },
    diagnosticLimits: (call: CallOptions = {}) => operation(call, async signal => {
      const value = checked(diagnosticLimitsSchema, await json('/api/diagnostics/limits', signal));
      if (value.maxPackageBytes > limits.maxPackageBytes || value.maxExpandedBytes > limits.maxExpandedBytes || value.maxFiles > limits.maxEntries) throw new RuntimeError('resource-limit', '诊断接收限制超出本机能力。');
      return value;
    }),
    uploadDiagnostic(raw: { uploadId: string; packageFile: string; bundleSha256: string }, call: CallOptions = {}) {
      const value = checked(z.object({ uploadId: text, packageFile: text, bundleSha256: digest }).strict(), raw);
      return operation(call, async signal => {
        if (!path.isAbsolute(value.packageFile)) throw invalid('诊断包路径无效。');
        const info = await lstat(value.packageFile);
        if (!info.isFile() || info.isSymbolicLink() || info.size > limits.maxPackageBytes) throw new RuntimeError('resource-limit','诊断包不是受限普通文件。');
        const handle = await open(value.packageFile, 'r');
        let bytes: Buffer;
        try {
          const current = await handle.stat();
          if (!current.isFile() || current.dev !== info.dev || current.ino !== info.ino || current.size !== info.size) throw invalid('诊断包读取期间改变。');
          const buffer = Buffer.alloc(info.size+1); let count=0;
          while(count<buffer.length){signal.throwIfAborted();const read=await handle.read(buffer,count,buffer.length-count,count);if(!read.bytesRead)break;count+=read.bytesRead;}
          bytes=buffer.subarray(0,count);
        } finally { await handle.close(); }
        if (bytes.length !== info.size || hash(bytes) !== value.bundleSha256) throw new RuntimeError('integrity', '诊断包内容已改变或超过上限。');
        const contents = await readPackageZip(bytes,{signal,limits});
        const manifest = contents.find(file=>file.path==='manifest.json'&&file.kind==='file');
        let expected: {threadId:string;uploadId:string};
        try { expected = checked(z.object({threadId:text,uploadId:text}),JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(manifest?.bytes))); }
        catch { throw invalid('诊断包缺少有效范围清单。'); }
        if(expected.uploadId!==value.uploadId)throw new RuntimeError('integrity','诊断上传身份与包不匹配。');
        const response = await request(`/api/diagnostics/thread-uploads/${encodeURIComponent(value.uploadId)}`, signal, { method: 'PUT', headers: { 'Content-Type': 'application/zip', 'X-Bundle-SHA256': value.bundleSha256 }, body: new Uint8Array(bytes) });
        let raw:unknown;
        try {raw=JSON.parse(response.bytes.toString('utf8'));} catch {throw invalid('诊断接收响应格式无效。');}
        const result = checked(diagnosticStateSchema,raw);
        if (response.status===202&&result.state!=='pending' || result.uploadId !== value.uploadId || result.state === 'received' && (result.bundleSha256 !== value.bundleSha256 || result.threadId !== expected.threadId)) throw new RuntimeError('integrity', '诊断接收回执不匹配。');
        return result;
      });
    },
    diagnosticStatus(uploadId: string, call: CallOptions = {}) {
      identifier(uploadId, 'uploadId');
      return operation(call, async signal => {
        const result = checked(diagnosticStateSchema, await json(`/api/diagnostics/thread-uploads/${encodeURIComponent(uploadId)}`, signal));
        if (result.uploadId !== uploadId) throw new RuntimeError('integrity', '诊断接收身份不匹配。');
        return result;
      });
    },
    async close({ deadline }: { deadline: number }): Promise<void> {
      if (!Number.isFinite(deadline) || deadline < 0) throw invalid('关闭期限无效。');
      closing.abort();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([Promise.allSettled([...operations]), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new RuntimeError('timeout', '平台请求清理超时。')), Math.max(0, Math.min(2_147_483_647, deadline - performance.now()))); })]);
      } finally { clearTimeout(timer); }
    },
  };
  return client;
}
export type PlatformClient = ReturnType<typeof createPlatformClient>;
