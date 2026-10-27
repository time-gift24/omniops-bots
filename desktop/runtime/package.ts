import { constants, createWriteStream } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';
import yazl from 'yazl';
import { invalid, RuntimeError } from './errors.ts';

export type PackageEntry = { path: string; kind: 'file' | 'folder'; bytes?: Uint8Array };
export type PackageLimits = { maxFileBytes: number; maxExpandedBytes: number; maxPackageBytes: number; maxEntries: number; maxDepth: number; maxPathBytes: number };
export const PACKAGE_LIMITS: Readonly<PackageLimits> = Object.freeze({ maxFileBytes: 20 * 1024 * 1024, maxExpandedBytes: 100 * 1024 * 1024, maxPackageBytes: 100 * 1024 * 1024, maxEntries: 1000, maxDepth: 32, maxPathBytes: 1024 });
type Options = { signal?: AbortSignal; limits?: Partial<PackageLimits> };
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function limitsFor(options: Options = {}): PackageLimits {
  const limits = { ...PACKAGE_LIMITS };
  for (const key of Object.keys(PACKAGE_LIMITS) as (keyof PackageLimits)[]) if (options.limits?.[key] !== undefined) limits[key] = options.limits[key]!;
  for (const key of Object.keys(limits) as (keyof PackageLimits)[]) if (!Number.isSafeInteger(limits[key]) || limits[key] <= 0 || limits[key] > PACKAGE_LIMITS[key]) throw invalid('文件包限制无效。');
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) throw invalid('取消信号无效。');
  options.signal?.throwIfAborted();
  return limits;
}
export function packagePath(value: unknown, limits: PackageLimits = PACKAGE_LIMITS): string {
  if (typeof value !== 'string' || !value || !value.isWellFormed() || value !== value.normalize('NFC') || Buffer.byteLength(value) > limits.maxPathBytes || value.includes('\\')) throw invalid('文件包路径无效。');
  const parts = value.split('/');
  if (parts.length > limits.maxDepth || parts.some(part => !part || part === '.' || part === '..' || /[\x00-\x1f\x7f<>:"|?*]/u.test(part) || /[. ]$/u.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))) throw invalid('文件包路径无效。');
  return value;
}
export function validatePackageEntries(entries: PackageEntry[], options: Options = {}): PackageEntry[] {
  const limits = limitsFor(options);
  if (!Array.isArray(entries) || entries.length > limits.maxEntries) throw new RuntimeError('resource-limit', '文件包条目超过上限。');
  const known = new Map<string, PackageEntry>();
  let total = 0;
  for (const entry of entries) {
    packagePath(entry.path, limits);
    const key = entry.path.toLowerCase();
    if (known.has(key) || !['file', 'folder'].includes(entry.kind)) throw invalid('文件包包含重复、大小写冲突或非法条目。');
    if (entry.kind === 'file') {
      if (!(entry.bytes instanceof Uint8Array) || entry.bytes.byteLength > limits.maxFileBytes) throw new RuntimeError('resource-limit', '文件包单文件超过上限。');
      total += entry.bytes.byteLength;
    } else if (entry.bytes !== undefined) throw invalid('文件夹不能包含文件内容。');
    known.set(key, entry);
  }
  if (total > limits.maxExpandedBytes) throw new RuntimeError('resource-limit', '文件包展开大小超过上限。');
  for (const entry of entries) {
    const parts = entry.path.split('/');
    for (let index = 1; index < parts.length; index++) {
      const parent = known.get(parts.slice(0, index).join('/').toLowerCase());
      if (!parent || parent.kind !== 'folder' || parent.path !== parts.slice(0, index).join('/')) throw invalid('文件包目录清单不完整或存在冲突。');
    }
  }
  return entries;
}
/** Original-byte manifest identity; ZIP bytes and publication labels are separate identities. */
export function packageContentId(entries: PackageEntry[]): string {
  validatePackageEntries(entries);
  const manifest = entries.map(entry => entry.kind === 'folder' ? { kind: 'folder', path: entry.path } : { bytes: entry.bytes!.byteLength, kind: 'file', path: entry.path, sha256: hash(entry.bytes!) })
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return hash(JSON.stringify(manifest));
}
/** Read only ordinary files/directories under this root; never follows links. */
export async function readPackage(directory: string, options: Options = {}): Promise<PackageEntry[]> {
  const limits = limitsFor(options);
  if (!path.isAbsolute(directory) || (await lstat(directory)).isSymbolicLink()) throw invalid('文件包目录无效。');
  const root = await realpath(directory), entries: PackageEntry[] = [];
  let total = 0;
  async function visit(folder: string, prefix = ''): Promise<void> {
    options.signal?.throwIfAborted();
    if ((await lstat(folder)).isSymbolicLink() || await realpath(folder) !== folder) throw invalid('文件包不允许链接。');
    for (const child of await readdir(folder, { withFileTypes: true })) {
      const relative = packagePath(prefix + child.name, limits), file = path.join(folder, child.name);
      if (entries.length >= limits.maxEntries || !child.isDirectory() && !child.isFile()) throw invalid('文件包包含过多条目、链接或特殊文件。');
      if (child.isDirectory()) { entries.push({ path: relative, kind: 'folder' }); await visit(file, relative + '/'); }
      else {
        const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          const info = await handle.stat();
          if (!info.isFile() || info.size > limits.maxFileBytes) throw new RuntimeError('resource-limit', '文件包单文件超过上限。');
          total += info.size;
          if (total > limits.maxExpandedBytes) throw new RuntimeError('resource-limit', '文件包展开大小超过上限。');
          const buffer = Buffer.alloc(info.size + 1);
          let count = 0;
          while (count < buffer.length) {
            options.signal?.throwIfAborted();
            const { bytesRead } = await handle.read(buffer, count, buffer.length - count, count);
            if (!bytesRead) break;
            count += bytesRead;
          }
          if (count !== info.size || (await handle.stat()).mtimeMs !== info.mtimeMs) throw invalid('文件在读取期间改变。');
          entries.push({ path: relative, kind: 'file', bytes: buffer.subarray(0,count) });
        } finally { await handle.close(); }
      }
    }
  }
  await visit(root);
  return validatePackageEntries(entries, options);
}
/** Decode a bounded ZIP without executing or extracting names supplied by the archive. */
export async function readPackageZip(input: Uint8Array, options: Options = {}): Promise<PackageEntry[]> {
  const limits = limitsFor(options);
  if (!(input instanceof Uint8Array) || input.length > limits.maxPackageBytes) throw new RuntimeError('resource-limit', '压缩包超过上限。');
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => yauzl.fromBuffer(Buffer.from(input), { lazyEntries: true, autoClose: false, strictFileNames: true, validateEntrySizes: true }, (error, file) => error ? reject(Object.assign(new RuntimeError('invalid-package', '压缩包无效或无法安全读取。'), {cause:error})) : resolve(file!)));
  const entries: PackageEntry[] = [];
  let total = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      const abort = () => { zip.close(); reject(options.signal?.reason ?? new DOMException('Aborted', 'AbortError')); };
      options.signal?.addEventListener('abort', abort, { once: true });
      const fail = (error: unknown) => { options.signal?.removeEventListener('abort', abort); reject(error); };
      zip.on('error', fail);
      zip.once('end', () => { options.signal?.removeEventListener('abort', abort); resolve(); });
      zip.on('entry', (entry: yauzl.Entry) => {
        void (async () => {
          options.signal?.throwIfAborted();
          const folder = entry.fileName.endsWith('/');
          const file = packagePath(folder ? entry.fileName.slice(0, -1) : entry.fileName, limits);
          const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
          if ((entry.generalPurposeBitFlag & 1) || ![0, 8].includes(entry.compressionMethod) || mode !== 0 && mode !== (folder ? 0o040000 : 0o100000)) throw invalid('压缩包包含加密、链接或特殊文件。');
          if (entries.length >= limits.maxEntries || entry.uncompressedSize > limits.maxFileBytes || folder && entry.uncompressedSize !== 0) throw new RuntimeError('resource-limit', '压缩包条目超过上限。');
          if (folder) entries.push({ path: file, kind: 'folder' });
          else {
            const stream = await new Promise<NodeJS.ReadableStream>((done, failed) => zip.openReadStream(entry, (error, data) => error ? failed(error) : done(data!)));
            const chunks: Buffer[] = [];
            let count = 0;
            for await (const chunk of stream as AsyncIterable<Buffer>) {
              options.signal?.throwIfAborted();
              count += chunk.length; total += chunk.length;
              if (count > limits.maxFileBytes || total > limits.maxExpandedBytes) throw new RuntimeError('resource-limit', '压缩包展开大小超过上限。');
              chunks.push(chunk);
            }
            if (count !== entry.uncompressedSize) throw invalid('压缩包文件长度不匹配。');
            entries.push({ path: file, kind: 'file', bytes: Buffer.concat(chunks) });
          }
          zip.readEntry();
        })().catch(fail);
      });
      if (options.signal?.aborted) abort(); else zip.readEntry();
    });
    return validatePackageEntries(entries, options);
  } catch (cause) {
    if (options.signal?.aborted) throw options.signal.reason;
    if (cause instanceof RuntimeError) throw cause;
    throw Object.assign(new RuntimeError('invalid-package', '压缩包无效或无法安全读取。'), { cause });
  } finally { zip.close(); }
}
/** Write into an owned, empty staging directory. Caller owns cleanup and atomic promotion. */
export async function writePackageFiles(entries: PackageEntry[], directory: string, options: Options = {}): Promise<void> {
  validatePackageEntries(entries, options);
  if (!path.isAbsolute(directory) || (await lstat(directory)).isSymbolicLink() || (await readdir(directory)).length) throw invalid('文件包暂存目录必须为空。');
  for (const entry of [...entries].sort((a, b) => a.path.split('/').length - b.path.split('/').length || (a.path < b.path ? -1 : 1))) {
    options.signal?.throwIfAborted();
    const file = path.join(directory, entry.path);
    if (entry.kind === 'folder') await mkdir(file, { mode: 0o700 });
    else {
      const handle = await open(file, 'wx', 0o600);
      try { await handle.writeFile(entry.bytes!, { signal: options.signal }); await handle.sync(); } finally { await handle.close(); }
    }
  }
}
/** Exclusive ZIP creation with a bounded output and fsync before returning its transport identity. */
export async function writePackageZip(entries: PackageEntry[], file: string, options: Options = {}): Promise<{ bytes: number; sha256: string }> {
  const limits = limitsFor(options);
  validatePackageEntries(entries, options);
  if (!path.isAbsolute(file)) throw invalid('压缩包保存路径必须为绝对路径。');
  const zip = new yazl.ZipFile();
  for (const entry of entries) {
    if (entry.kind === 'folder') zip.addEmptyDirectory(entry.path + '/', { mode: 0o040700 });
    else zip.addBuffer(Buffer.from(entry.bytes!), entry.path, { mode: 0o100600 });
  }
  const digest = createHash('sha256');
  let bytes = 0;
  const bounded = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    bytes += chunk.length;
    if (bytes > limits.maxPackageBytes) callback(new RuntimeError('resource-limit', '压缩包超过上限。'));
    else { digest.update(chunk); callback(null, chunk); }
  } });
  zip.end();
  await pipeline(zip.outputStream, bounded, createWriteStream(file, { flags: 'wx', mode: 0o600 }), { signal: options.signal });
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try { await handle.sync(); } finally { await handle.close(); }
  return { bytes, sha256: digest.digest('hex') };
}
