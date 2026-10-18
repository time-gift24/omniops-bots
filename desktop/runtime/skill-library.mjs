import { constants } from 'node:fs';
import { mkdir, readdir, lstat, open, realpath, rename, rm, rmdir, link } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { invalid, RuntimeError } from './errors.mjs';

const MAX_FILE = 20 * 1024 * 1024;
const MAX_PACKAGE = 100 * 1024 * 1024;
const MAX_ENTRIES = 1000;
const METHODS = new Set(['skill_library_info', 'skill_library_list', 'skill_library_get', 'skill_library_create', 'skill_library_copy', 'skill_library_read', 'skill_library_write', 'skill_library_mkdir', 'skill_library_rename', 'skill_library_remove', 'skill_library_delete']);
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const CONTENT_ID = /^[a-f0-9]{64}$/u;
const LABEL = /^v\.\d+\.\d+\.\d+$/u;
const TEXT = /\.(?:md|txt|json|ya?ml|toml|m?[jt]s|[jt]sx|py|sh|css|html|csv|xml|svg|ini|env)$/iu;
const TYPES = { md: 'text/markdown', txt: 'text/plain', json: 'application/json', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf', csv: 'text/csv' };
export const defaultSkillRoot = (homeDir = homedir()) => path.join(homeDir, '.omnimind-ops', 'skills');

function relativePath(value) {
  if (typeof value !== 'string' || value.length > 1024 || !value || value !== value.normalize('NFC') || value.includes('\\')) throw invalid('文件路径无效。');
  const segments = value.split('/');
  if (segments.length > 32 || segments.some(part => !part || part === '.' || part === '..' || /[\u0000-\u001f\u007f<>:"|?*]/u.test(part) || /[. ]$/u.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part) || part.startsWith('.pending-'))) throw invalid('文件路径无效。');
  return segments;
}
function parseId(value) {
  if (typeof value !== 'string') throw invalid('Skill 无效。');
  const parts = value.split('/');
  if (parts.length === 2 && parts[0] === 'local' && ID.test(parts[1])) return { origin: 'local', relative: ['local', parts[1]] };
  if (parts.length === 3 && parts[0] === 'official' && ID.test(parts[1]) && CONTENT_ID.test(parts[2])) return { origin: 'official', relative: ['releases', parts[1], parts[2]], contentId: parts[2], skillId: parts[1] };
  throw invalid('Skill 无效。');
}
function title(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 100 || /[\u0000-\u001f\u007f]/u.test(value)) throw invalid('Skill 名称不能为空，且最多 100 字符。');
  return value.trim();
}
function description(value = '') {
  if (typeof value !== 'string' || value.length > 4096) throw invalid('Skill 描述最多 4096 字符。');
  return value;
}
function mime(file) { return TYPES[path.extname(file).slice(1).toLowerCase()] || (TEXT.test(file) ? 'text/plain' : 'application/octet-stream'); }
function notFound() { return new RuntimeError('file-unavailable', 'Skill 或文件已移除，请刷新列表。'); }
async function infoAt(file) {
  try { return await lstat(file); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}
async function regularBytes(file) {
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_FILE) throw new RuntimeError('resource-limit', '单个 Skill 文件不能超过 20 MiB。');
    const bytes = Buffer.alloc(info.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const result = await handle.read(bytes, size, bytes.length - size, size);
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    if (size > info.size || size > MAX_FILE) throw invalid('读取期间文件已改变，请重试。');
    return bytes.subarray(0, size);
  } finally { await handle.close(); }
}
async function atomicWrite(file, bytes, replace) {
  const temporary = path.join(path.dirname(file), `.pending-${randomUUID()}`);
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); }
  catch (error) { await handle.close(); await rm(temporary, { force: true }); throw error; }
  await handle.close();
  try {
    if (replace) await rename(temporary, file);
    else await link(temporary, file);
  } catch (error) {
    if (error.code === 'EEXIST') throw new RuntimeError('conflict', '同名文件已存在，请确认替换或更改名称。');
    throw error;
  } finally { await rm(temporary, { force: true }); }
}

/** Files are persisted by the desktop service; no browser Blob URLs are stored. */
export function createSkillLibrary({ root = defaultSkillRoot() } = {}) {
  let queue = Promise.resolve();
  let canonical;
  let createdParents = [];
  async function ensureRoot() {
    if (!canonical) {
      await mkdir(root, { recursive: true, mode: 0o700 });
      if ((await lstat(root)).isSymbolicLink()) throw invalid('Skill 根目录不能是符号链接。');
      canonical = await realpath(root);
    }
    return canonical;
  }
  async function resolve(parts, { createParents = false } = {}) {
    let current = await ensureRoot();
    for (const [index, segment] of parts.entries()) {
      current = path.join(current, segment);
      const siblings = await readdir(path.dirname(current)).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
      if (siblings.some(name => name.toLowerCase() === segment.toLowerCase() && name !== segment)) throw new RuntimeError('conflict', '名称与已有文件或目录的大小写冲突。');
      let info = await infoAt(current);
      if (!info && createParents && index < parts.length - 1) {
        await mkdir(current, { mode: 0o700 });
        createdParents.push(current);
        info = await lstat(current);
      }
      if (info?.isSymbolicLink()) throw invalid('Skill 内不允许符号链接。');
      if (info && index < parts.length - 1 && !info.isDirectory()) throw invalid('目标路径的上级不是目录。');
      if (!info && index < parts.length - 1 && !createParents) throw notFound();
    }
    return current;
  }
  async function packageRoot(id, writable = false) {
    const parsed = parseId(id);
    if (writable && parsed.origin !== 'local') throw new RuntimeError('read-only', '官方已发布 Skill 只读，请先复制到本地。');
    const directory = await resolve(parsed.relative);
    if (!(await infoAt(directory))?.isDirectory()) throw notFound();
    return { ...parsed, directory };
  }
  async function entriesAt(directory) {
    const entries = [];
    let total = 0;
    async function walk(folder, prefix = '') {
      for (const entry of (await readdir(folder, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name.startsWith('.pending-')) continue;
        const relative = `${prefix}${entry.name}`;
        relativePath(relative);
        if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) throw invalid('Skill 中包含不受支持的链接或特殊文件。');
        const info = await lstat(path.join(folder, entry.name));
        if (info.isSymbolicLink()) throw invalid('Skill 中包含不受支持的链接。');
        total += entry.isFile() ? info.size : 0;
        if (entries.length >= MAX_ENTRIES || info.isFile() && info.size > MAX_FILE || total > MAX_PACKAGE) throw new RuntimeError('resource-limit', 'Skill 最多 1000 项，单文件 20 MiB、总计 100 MiB。');
        entries.push({ path: relative, kind: entry.isDirectory() ? 'folder' : 'file', size: entry.isFile() ? info.size : 0, modifiedAt: info.mtime.toISOString(), mimeType: entry.isFile() ? mime(relative) : '' });
        if (entry.isDirectory()) await walk(path.join(folder, entry.name), `${relative}/`);
      }
    }
    await walk(directory);
    return entries;
  }
  async function get(id) {
    const location = await packageRoot(id);
    const entries = await entriesAt(location.directory);
    const main = entries.find(entry => entry.path === 'SKILL.md' && entry.kind === 'file');
    let name = location.relative.at(-1), summary = '';
    if (main) {
      const contents = (await regularBytes(path.join(location.directory, 'SKILL.md'))).toString('utf8');
      const frontmatter = contents.match(/^---\r?\n([\s\S]*?)\r?\n---/u)?.[1] ?? '';
      const field = key => {
        const value = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, 'mu'))?.[1]?.trim();
        if (value?.startsWith('"')) { try { return JSON.parse(value); } catch { /* Plain scalar below. */ } }
        return value?.replace(/^['"]|['"]$/gu, '');
      };
      name = field('name') || name;
      summary = field('description') || '';
    }
    if (location.origin === 'local') {
      const metadata = await resolve(['.metadata', location.relative[1] + '.json'], { createParents: true });
      if ((await infoAt(metadata))?.isFile()) {
        const value = JSON.parse((await regularBytes(metadata)).toString('utf8'));
        name = title(value.name);
        summary = description(value.description);
      }
    }
    let version;
    if (location.origin === 'official') {
      const tagsPath = await resolve(['releases', location.skillId, 'tags.json']);
      const info = await infoAt(tagsPath);
      if (info?.isFile()) {
        const tags = JSON.parse((await regularBytes(tagsPath)).toString('utf8'));
        version = Object.entries(tags).filter(([tag, content]) => LABEL.test(tag) && content === location.contentId).map(([tag]) => tag).sort().at(-1);
      }
    }
    return { id, name, description: summary, origin: location.origin, readOnly: location.origin === 'official', ...(version ? { version } : {}), ...(location.contentId ? { contentId: location.contentId } : {}), modifiedAt: entries.map(entry => entry.modifiedAt).sort().at(-1) ?? (await lstat(location.directory)).mtime.toISOString(), entries };
  }
  async function list() {
    const skills = [];
    const base = await ensureRoot();
    for (const category of ['local', 'releases']) {
      const directory = path.join(base, category);
      if (!(await infoAt(directory))) continue;
      await resolve([category]);
      for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (!ID.test(entry.name) || !entry.isDirectory()) continue;
        if (category === 'local') skills.push(await get(`local/${entry.name}`));
        else for (const release of await readdir(path.join(directory, entry.name), { withFileTypes: true })) {
          if (release.isDirectory() && CONTENT_ID.test(release.name)) skills.push(await get(`official/${entry.name}/${release.name}`));
        }
        if (skills.length > 256) throw new RuntimeError('resource-limit', 'Skill 数量超过 256，请整理本地目录。');
      }
    }
    return skills;
  }
  async function create(params) {
    const name = title(params.name), summary = description(params.description);
    const id = `local/${randomUUID()}`;
    const parsed = parseId(id);
    const directory = await resolve(parsed.relative, { createParents: true });
    await mkdir(directory, { mode: 0o700 });
    try {
      await atomicWrite(path.join(directory, 'SKILL.md'), Buffer.from(`---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(summary)}\n---\n\n# ${name}\n\n`), false);
      const metadata = await resolve(['.metadata', parsed.relative[1] + '.json'], { createParents: true });
      await atomicWrite(metadata, Buffer.from(JSON.stringify({ name, description: summary })), false);
      return await get(id);
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      await rm(path.join(await ensureRoot(), '.metadata', parsed.relative[1] + '.json'), { force: true });
      throw error;
    }
  }
  async function copy(params) {
    const source = await get(params.id);
    const sourceLocation = await packageRoot(params.id);
    const created = await create({ name: params.name ?? `${source.name}（副本）`, description: source.description });
    const target = await packageRoot(created.id, true);
    try {
      await rm(path.join(target.directory, 'SKILL.md'));
      for (const entry of source.entries) {
        const file = await resolve([...target.relative, ...relativePath(entry.path)], { createParents: true });
        if (entry.kind === 'folder') await mkdir(file, { recursive: true, mode: 0o700 });
        else await atomicWrite(file, await regularBytes(path.join(sourceLocation.directory, ...relativePath(entry.path))), entry.path === 'SKILL.md');
      }
      // The copy retains package contents byte-for-byte; its local identity is distinct.
      return await get(created.id);
    } catch (error) {
      await rm(target.directory, { recursive: true, force: true });
      await rm(path.join(await ensureRoot(), '.metadata', target.relative[1] + '.json'), { force: true });
      throw error;
    }
  }
  async function dispatch(method, params) {
    if (method === 'skill_library_info') return { kind: 'desktop', root: await ensureRoot() };
    if (method === 'skill_library_list') return list();
    if (method === 'skill_library_get') return get(params.id);
    if (method === 'skill_library_create') return create(params);
    if (method === 'skill_library_copy') return copy(params);
    const location = await packageRoot(params.id, method !== 'skill_library_read');
    if (method !== 'skill_library_read') await get(params.id);
    if (method === 'skill_library_delete') {
      await rm(location.directory, { recursive: true });
      await rm(path.join(await ensureRoot(), '.metadata', location.relative[1] + '.json'), { force: true });
      return null;
    }
    const parts = relativePath(params.path);
    const file = await resolve([...location.relative, ...parts]);
    const info = await infoAt(file);
    if (method === 'skill_library_read') {
      if (!info?.isFile()) throw notFound();
      return { data: (await regularBytes(file)).toString('base64'), mimeType: mime(params.path) };
    }
    if (method === 'skill_library_write') {
      if (typeof params.data !== 'string' || params.data.length > Math.ceil(MAX_FILE / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(params.data)) throw invalid('文件内容无效或超过 20 MiB。');
      const bytes = Buffer.from(params.data, 'base64');
      if (bytes.length > MAX_FILE || bytes.toString('base64') !== params.data) throw invalid('文件内容无效或超过 20 MiB。');
      if (info && !info.isFile()) throw new RuntimeError('conflict', '同名目录已经存在。');
      if (info && params.replace !== true) throw new RuntimeError('conflict', '同名文件已存在，请确认替换或更改名称。');
      const current = await entriesAt(location.directory);
      if (current.reduce((size, entry) => size + entry.size, 0) - (info?.size ?? 0) + bytes.length > MAX_PACKAGE || !info && current.length >= MAX_ENTRIES) throw new RuntimeError('resource-limit', 'Skill 最多 1000 项，总计 100 MiB。');
      await atomicWrite(file, bytes, params.replace === true);
      return get(params.id);
    }
    if (method === 'skill_library_mkdir') {
      if (info) throw new RuntimeError('conflict', '同名文件或目录已经存在。');
      if ((await entriesAt(location.directory)).length >= MAX_ENTRIES) throw new RuntimeError('resource-limit', 'Skill 最多 1000 项。');
      await mkdir(file, { mode: 0o700 });
      return get(params.id);
    }
    if (!info) throw notFound();
    if (method === 'skill_library_rename') {
      const next = relativePath(params.to);
      if (params.path === params.to) return get(params.id);
      if (params.to.startsWith(`${params.path}/`)) throw invalid('不能将目录移入自身。');
      if (params.path.toLowerCase() === params.to.toLowerCase()) throw new RuntimeError('conflict', '名称仅大小写不同，请使用其他名称。');
      for (const entry of await entriesAt(location.directory)) {
        if (entry.path === params.path || entry.path.startsWith(`${params.path}/`)) relativePath(params.to + entry.path.slice(params.path.length));
      }
      const destination = await resolve([...location.relative, ...next]);
      if (await infoAt(destination)) throw new RuntimeError('conflict', '目标名称已经存在。');
      await rename(file, destination);
      return get(params.id);
    }
    if (method === 'skill_library_remove') {
      await rm(file, { recursive: true });
      return get(params.id);
    }
    throw invalid('未知的 Skill 操作。');
  }
  function handle(method, params = {}) {
    if (!METHODS.has(method)) return Promise.reject(invalid('未知的 Skill 操作。'));
    const result = queue.then(async () => {
      createdParents = [];
      try { return await dispatch(method, params); }
      catch (error) {
        for (const directory of createdParents.reverse()) await rmdir(directory).catch(() => {});
        throw error;
      }
    });
    queue = result.catch(() => {});
    return result.catch(error => {
      if (error instanceof RuntimeError) throw error;
      if (error.code === 'ENOENT') throw notFound();
      throw new RuntimeError('skills-unavailable', 'Skill 文件操作未能完成，请刷新确认文件状态并检查目录权限后重试。');
    });
  }
  async function sourceSkills() {
    const result = [];
    let total = 0;
    for (const skill of await handle('skill_library_list')) {
      const files = [];
      for (const entry of skill.entries) {
        if (entry.kind !== 'file' || !TEXT.test(entry.path) || entry.size > 256 * 1024) continue;
        total += entry.size;
        if (total > 32 * 1024 * 1024) throw new RuntimeError('resource-limit', 'Skill 文本目录合计超过 32 MiB，请减少装入客户端的 Skill。');
        const data = await handle('skill_library_read', { id: skill.id, path: entry.path });
        try { files.push({ path: entry.path, content: new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(data.data, 'base64')) }); }
        catch { /* Binary or invalid UTF-8 files remain in the package, outside text previews. */ }
      }
      if (files.some(file => file.path === 'SKILL.md')) result.push({ id: skill.id, name: skill.name, description: skill.description, origin: skill.origin, ...(skill.version ? { version: skill.version } : {}), files });
    }
    return result;
  }
  function capture(id) {
    // Share the mutation queue so one snapshot cannot mix separate UI edits.
    const result = queue.then(async () => {
      const skill = await get(id);
      const location = await packageRoot(id);
      const entries = [];
      for (const entry of skill.entries) {
        const file = await resolve([...location.relative, ...relativePath(entry.path)]);
        entries.push({ path: entry.path, kind: entry.kind, ...(entry.kind === 'file' ? { bytes: await regularBytes(file) } : {}) });
      }
      return { skill, entries };
    });
    queue = result.catch(() => {});
    return result.catch(error => {
      if (error instanceof RuntimeError) throw error;
      if (error.code === 'ENOENT') throw notFound();
      throw new RuntimeError('skills-unavailable', '无法固定完整 Skill 包，请检查文件后重试。');
    });
  }
  return { hasMethod: method => METHODS.has(method), handle, sourceSkills, capture };
}
