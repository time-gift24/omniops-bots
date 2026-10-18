import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, realpath, rename, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { invalid, RuntimeError } from './errors.mjs';

export type AgentConfiguration = {
  name: string; description: string; instructions: string;
  toolIds: string[]; skillIds: string[]; mcpServerIds: string[];
};
export type AgentEntry = {
  id: string; source: 'local' | 'official'; contentId: string;
  releaseTag?: string; configuration: AgentConfiguration;
};
export type McpConfiguration = { id: string; name: string; description: string; url: string; credentialEnv?: string };
export type SkillSnapshot = { id: string; name: string; contentId: string; releaseTag?: string; mountPath: string };
export type SessionAssembly = {
  sessionId: string; directory: string; assemblyContentId: string; agent: AgentEntry; skills: SkillSnapshot[]; mcpServers: McpConfiguration[];
  experimentSkillId?: string; model?: string; modelParameters?: Record<string, unknown>; desktopVersion?: string;
};
type PackageEntry = { path: string; kind: 'file' | 'folder'; bytes?: Uint8Array };
type SkillPackage = {
  skill: { id: string; name: string; origin: string; contentId?: string; version?: string };
  entries: PackageEntry[];
};
type SkillLibrary = {
  capture(id: string): Promise<SkillPackage>;
  handle(method: string, params?: Record<string, unknown>): Promise<unknown>;
};
type McpCatalog = { list(): unknown | Promise<unknown>; get(id: string): unknown | Promise<unknown> };
type PrepareOptions = {
  sessionId: string; agentId?: string; experimentSkillId?: string;
  model?: string; modelParameters?: Record<string, unknown>; desktopVersion?: string;
};
const HASH = /^[a-f0-9]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const MAX_FILE = 20 * 1024 * 1024;
const MAX_PACKAGE = 100 * 1024 * 1024;
const MAX_ASSEMBLY = 256 * 1024 * 1024;
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('装配数据格式无效。');
  return value as Record<string, unknown>;
};
function text(value: unknown, label: string, max = 256): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) throw invalid(`${label}无效。`);
  return value;
}
function agentId(value: unknown): string {
  const id = text(value, 'Agent ID');
  if (!ID.test(id) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu.test(id)) throw invalid('Agent ID 无效。');
  return id;
}
function configuration(value: unknown): AgentConfiguration {
  const raw = record(value);
  const name = text(raw.name, 'Agent 名称');
  if (typeof raw.description !== 'string' || raw.description.length > 4096 || typeof raw.instructions !== 'string' || !raw.instructions.trim() || raw.instructions.length > 65536 || raw.instructions.includes('\0')) throw invalid('Agent 描述或指令无效。');
  const ids = (key: string): string[] => {
    const list = raw[key];
    if (!Array.isArray(list) || list.length > 256 || new Set(list).size !== list.length) throw invalid('Agent 资源清单无效。');
    return list.map(value => text(value, '资源 ID'));
  };
  return { name, description: raw.description, instructions: raw.instructions, toolIds: ids('toolIds'), skillIds: ids('skillIds'), mcpServerIds: ids('mcpServerIds') };
}
function mcpConfiguration(value: unknown): McpConfiguration {
  const raw = record(value);
  const id = text(raw.id, 'MCP ID'), name = text(raw.name, 'MCP 名称');
  if (typeof raw.description !== 'string' || raw.description.length > 4096) throw invalid('MCP 描述无效。');
  let url: URL;
  try { url = new URL(text(raw.url, 'MCP 地址', 8192)); } catch { throw invalid('MCP 地址无效。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) throw invalid('MCP 地址必须是不含凭据、查询参数或片段的 HTTP(S) 地址。');
  const credentialEnv = raw.credentialEnv === undefined ? undefined : text(raw.credentialEnv, 'MCP 凭据引用');
  if (credentialEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(credentialEnv)) throw invalid('MCP 凭据环境变量名称无效。');
  return { id, name, description: raw.description, url: url.href, ...(credentialEnv ? { credentialEnv } : {}) };
}
function relative(value: unknown): string {
  const valueText = text(value, 'Skill 文件路径', 1024);
  if (valueText !== valueText.normalize('NFC') || valueText.includes('\\') || valueText.split('/').some(segment => !segment || segment === '.' || segment === '..' || /[<>:"|?*]/u.test(segment) || /[. ]$/u.test(segment))) throw invalid('Skill 文件路径无效。');
  return valueText;
}
export function packageContentId(entries: PackageEntry[]): string {
  const manifest = entries.map(entry => {
    const file = relative(entry.path);
    return entry.kind === 'folder' ? { path: file, kind: 'folder' } : { path: file, kind: 'file', bytes: entry.bytes!.byteLength, sha256: hash(entry.bytes!) };
  }).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  if (new Set(manifest.map(entry => entry.path.toLowerCase())).size !== manifest.length) throw invalid('Skill 包存在重复路径或大小写冲突。');
  return hash(canonical(manifest));
}
async function directory(value: string): Promise<string> {
  await mkdir(value, { recursive: true, mode: 0o700 });
  if ((await lstat(value)).isSymbolicLink()) throw invalid('装配目录不能是符号链接。');
  return realpath(value);
}
async function readBytes(file: string, limit = MAX_FILE): Promise<Buffer> {
  if ((await lstat(file)).isSymbolicLink()) throw invalid('装配中不允许符号链接。');
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > limit) throw new RuntimeError('resource-limit', '装配文件超过大小限制。');
    const buffer = Buffer.alloc(info.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > info.size) throw invalid('装配文件在读取期间改变，请重试。');
    return buffer.subarray(0, length);
  } finally { await handle.close(); }
}
async function writeJson(file: string, value: unknown): Promise<void> {
  const temporary = path.join(path.dirname(file), `.pending-${randomUUID()}`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}
async function readJson(file: string): Promise<unknown> { return JSON.parse((await readBytes(file, 2 * 1024 * 1024)).toString('utf8')); }
function metadata(entries: PackageEntry[]): { name: string; description: string } {
  const main = entries.find(entry => entry.path === 'SKILL.md' && entry.kind === 'file');
  if (!main?.bytes || main.bytes.byteLength > 256 * 1024) throw invalid('Skill 缺少有效 SKILL.md，或入口超过 256 KiB。');
  let raw: Record<string, unknown>;
  try {
    const content = new TextDecoder('utf-8', { fatal: true }).decode(main.bytes);
    const header = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u)?.[1];
    raw = record(parseYaml(header ?? '', { maxAliasCount: 0 }));
  } catch { throw invalid('Skill 入口的 YAML 元信息无效，请检查 SKILL.md。'); }
  return { name: text(raw.name, 'Skill 元信息 name', 100), description: text(raw.description, 'Skill 元信息 description', 4096) };
}
async function readPackage(root: string): Promise<PackageEntry[]> {
  const entries: PackageEntry[] = [];
  let bytes = 0;
  async function walk(folder: string, prefix = '', depth = 0): Promise<void> {
    if (depth > 32 || (await lstat(folder)).isSymbolicLink()) throw invalid('Skill 快照目录无效。');
    for (const item of await readdir(folder, { withFileTypes: true })) {
      const relativePath = relative(prefix + item.name), file = path.join(folder, item.name);
      if (entries.length >= 1000 || !item.isFile() && !item.isDirectory()) throw invalid('Skill 快照包含过多文件、链接或特殊文件。');
      if (item.isDirectory()) {
        entries.push({ path: relativePath, kind: 'folder' });
        await walk(file, relativePath + '/', depth + 1);
      } else {
        const content = await readBytes(file);
        bytes += content.byteLength;
        if (bytes > MAX_PACKAGE) throw new RuntimeError('resource-limit', 'Skill 快照超过 100 MiB。');
        entries.push({ path: relativePath, kind: 'file', bytes: content });
      }
    }
  }
  await walk(root);
  return entries;
}

export function createAssemblyStore({ agentsDir, runsDir, skillLibrary, tools, mcpCatalog = { list: () => [], get: () => undefined } }: {
  agentsDir: string; runsDir: string; skillLibrary: SkillLibrary;
  tools: readonly { id: string }[]; mcpCatalog?: McpCatalog;
}) {
  let queue = Promise.resolve<unknown>(undefined);
  const run = <T>(action: () => Promise<T>): Promise<T> => {
    // Serialize local changes and first-session captures; no background queue of executions.
    const result = queue.then(action);
    queue = result.catch(() => {});
    return result.catch((error: unknown) => {
      if (error instanceof RuntimeError) throw error;
      throw new RuntimeError('assembly-unavailable', '装配保存或读取失败；已有数据保留，请检查本地目录后重试。');
    });
  };
  const defaultConfiguration: AgentConfiguration = {
    name: '浏览器助手', description: '在内置浏览器中查阅信息并完成操作。',
    instructions: '你是桌面浏览器助手。使用内置浏览器核实页面信息，按用户要求操作，并如实说明结果。',
    mcpServerIds: [], toolIds: tools.map(tool => tool.id), skillIds: [],
  };
  function entry(id: string, config: AgentConfiguration): AgentEntry {
    return { id, source: 'local', contentId: hash(canonical(config)), configuration: structuredClone(config) };
  }
  async function readAgent(id: string): Promise<AgentEntry> {
    const root = await directory(agentsDir), file = path.join(root, `${agentId(id)}.json`);
    let value: unknown;
    try { value = await readJson(file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (id !== 'browser-assistant') throw invalid('所选 Agent 不存在。');
      const initial = entry(id, defaultConfiguration);
      await writeJson(file, initial);
      return initial;
    }
    const raw = record(value), config = configuration(raw.configuration);
    if (raw.id !== id || !['local', 'official'].includes(String(raw.source)) || raw.contentId !== hash(canonical(config))) throw invalid('Agent 内容摘要或身份无效，请检查配置文件。');
    const releaseTag = raw.releaseTag === undefined ? undefined : text(raw.releaseTag, 'Agent 发布标签');
    if (releaseTag && !/^v\.\d+\.\d+\.\d+$/u.test(releaseTag)) throw invalid('Agent 发布标签无效。');
    return { id, source: raw.source as 'local' | 'official', contentId: raw.contentId as string, configuration: config, ...(releaseTag ? { releaseTag } : {}) };
  }
  async function validateReferences(config: AgentConfiguration): Promise<void> {
    for (const id of config.skillIds) await skillLibrary.handle('skill_library_get', { id });
    for (const id of config.mcpServerIds) {
      const server = await mcpCatalog.get(id);
      if (!server || mcpConfiguration(server).id !== id) throw invalid('Agent 引用了不存在的 MCP。');
    }
  }
  async function restore(file: string, options: PrepareOptions, target: string): Promise<SessionAssembly> {
    const raw = record(await readJson(file));
    const agent = record(raw.agent);
    if (raw.sessionId !== options.sessionId || options.agentId !== undefined && options.agentId !== agent.id || options.experimentSkillId !== undefined && options.experimentSkillId !== raw.experimentSkillId) throw invalid('会话已固定其他装配，请新建会话。');
    configuration(agent.configuration);
    agentId(agent.id);
    if (!['local', 'official'].includes(String(agent.source)) || typeof agent.contentId !== 'string' || !HASH.test(agent.contentId) || !Array.isArray(raw.skills) || raw.skills.length > 256 || !Array.isArray(raw.mcpServers) || raw.mcpServers.length > 256) throw invalid('会话快照无效。');
    const stored = raw as unknown as SessionAssembly;
    if ((await lstat(path.join(target, 'skills'))).isSymbolicLink()) throw invalid('会话 Skill 目录不能是符号链接。');
    const mounts = new Set<string>();
    let total = 0;
    for (const skill of stored.skills) {
      const mount = text(skill.mountPath, 'Skill 挂载路径', 1024);
      if (!/^\/skills\/[A-Za-z0-9_-]+\/$/u.test(mount) || mounts.has(mount) || !HASH.test(skill.contentId)) throw invalid('会话 Skill 快照路径或摘要无效。');
      mounts.add(mount);
      const entries = await readPackage(path.join(target, mount.slice(1)));
      total += entries.reduce((size, item) => size + (item.bytes?.byteLength ?? 0), 0);
      if (total > MAX_ASSEMBLY || packageContentId(entries) !== skill.contentId) throw invalid('会话 Skill 快照已改变，不能继续执行；请新建会话。');
      metadata(entries);
    }
    stored.mcpServers = stored.mcpServers.map(mcpConfiguration);
    if (stored.assemblyContentId !== hash(canonical({ configuration: configuration(agent.configuration), skills: stored.skills.map(({ id, contentId }) => ({ id, contentId })), mcpServers: stored.mcpServers }))) throw invalid('会话 Agent 装配摘要不匹配。');
    return { ...stored, directory: target };
  }
  async function prepare(options: PrepareOptions): Promise<SessionAssembly> {
    text(options.sessionId, '会话 ID');
    const root = await directory(runsDir), target = path.join(root, hash(options.sessionId));
    const manifest = path.join(target, 'assembly.json');
    try {
      if ((await lstat(target)).isSymbolicLink()) throw invalid('会话目录不能是符号链接。');
      return await restore(manifest, options, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // A published directory without its manifest is a damaged snapshot, never a fresh session.
      try { await lstat(target); throw invalid('会话快照不完整，请新建会话。'); }
      catch (missing) { if ((missing as NodeJS.ErrnoException).code !== 'ENOENT') throw missing; }
    }
    const selected = await readAgent(options.agentId ?? 'browser-assistant');
    const config = structuredClone(selected.configuration);
    const missing = config.toolIds.filter(id => !tools.some(tool => tool.id === id));
    if (missing.length) throw new RuntimeError('missing-tools', `当前桌面端缺少内置工具：${missing.join('、')}。请更新桌面端后重新发起任务。`);
    const captured: SkillPackage[] = [];
    let capturedBytes = 0;
    const capture = async (id: string): Promise<SkillPackage> => {
      const value = await skillLibrary.capture(id);
      capturedBytes += value.entries.reduce((size, item) => size + (item.bytes?.byteLength ?? 0), 0);
      if (capturedBytes > MAX_ASSEMBLY) throw new RuntimeError('resource-limit', '本次 Skill 装配超过 256 MiB，请减少所选 Skill。');
      return value;
    };
    for (const id of config.skillIds) captured.push(await capture(id));
    if (options.experimentSkillId) {
      const experiment = await capture(options.experimentSkillId);
      if (experiment.skill.origin !== 'local') throw invalid('实验需要可编辑的本地 Skill 草稿。');
      const matching = captured.flatMap((item, index) => item.skill.id === experiment.skill.id || item.skill.name === experiment.skill.name ? [index] : []);
      if (matching.length > 1) throw invalid('模板中存在多个同名 Skill，无法确定实验替换项。');
      if (matching.length) captured[matching[0]!] = experiment;
      else captured.push(experiment);
      config.skillIds = captured.map(item => item.skill.id);
    }
    const mcpServers: McpConfiguration[] = [];
    for (const id of config.mcpServerIds) {
      const value = await mcpCatalog.get(id);
      if (!value) throw invalid(`找不到所需 MCP：${id}。`);
      const server = mcpConfiguration(value);
      if (server.id !== id) throw invalid('MCP 配置身份不匹配。');
      mcpServers.push(server);
    }
    let total = 0;
    const names = new Set<string>();
    const skills = captured.map(({ skill, entries }): SkillSnapshot => {
      total += entries.reduce((size, item) => size + (item.bytes?.byteLength ?? 0), 0);
      if (total > MAX_ASSEMBLY) throw new RuntimeError('resource-limit', '本次 Skill 装配超过 256 MiB，请减少所选 Skill。');
      const info = metadata(entries), contentId = packageContentId(entries);
      if (names.has(info.name.toLowerCase())) throw invalid('所选 Skill 包含同名入口，不能静默覆盖，请调整装配。');
      names.add(info.name.toLowerCase());
      if (skill.origin === 'official' && skill.contentId !== contentId) throw new RuntimeError('integrity', '官方 Skill 缓存内容摘要不匹配，不能使用此版本。');
      const mountName = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(info.name) && info.name.length <= 64 && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/u.test(info.name)
        ? info.name : `skill-${hash(skill.id).slice(0, 24)}`;
      return { id: skill.id, name: info.name, contentId, ...(skill.version ? { releaseTag: skill.version } : {}), mountPath: `/skills/${mountName}/` };
    });
    if (new Set(skills.map(skill => skill.mountPath)).size !== skills.length) throw invalid('Skill 挂载目录冲突，请调整名称。');
    const assemblyContentId = hash(canonical({ configuration: config, skills: skills.map(({ id, contentId }) => ({ id, contentId })), mcpServers }));
    const agent = { ...selected, configuration: config, contentId: selected.source === 'official' ? selected.contentId : assemblyContentId };
    const assembly: SessionAssembly = { sessionId: options.sessionId, directory: target, assemblyContentId, agent, skills, mcpServers,
      ...(options.experimentSkillId ? { experimentSkillId: options.experimentSkillId } : {}),
      ...(options.model ? { model: text(options.model, '模型') } : {}),
      ...(options.desktopVersion ? { desktopVersion: text(options.desktopVersion, '桌面版本') } : {}),
    };
    if (options.modelParameters !== undefined) {
      const parameters = record(options.modelParameters);
      // Only model tuning values belong in a snapshot, never transport/auth configuration.
      const allowed = new Set(['temperature', 'topP', 'top_p', 'maxTokens', 'max_tokens', 'seed', 'reasoningEffort', 'reasoning_effort']);
      if (Object.keys(parameters).some(key => !allowed.has(key)) || Object.values(parameters).some(value => typeof value !== 'number' && typeof value !== 'string' && typeof value !== 'boolean' || typeof value === 'number' && !Number.isFinite(value))) throw invalid('模型运行参数无效或包含不允许保存的配置。');
      assembly.modelParameters = structuredClone(parameters);
    }
    const staging = path.join(root, `.pending-${randomUUID()}`);
    await mkdir(path.join(staging, 'skills'), { recursive: true, mode: 0o700 });
    try {
      for (const [index, skill] of skills.entries()) {
        const destination = path.join(staging, skill.mountPath.slice(1));
        await mkdir(destination, { mode: 0o700 });
        const folders = [destination];
        for (const item of captured[index]!.entries) {
          const file = path.join(destination, relative(item.path));
          if (item.kind === 'folder') { await mkdir(file, { recursive: true, mode: 0o700 }); folders.push(file); }
          else {
            const handle = await open(file, 'wx', 0o400);
            try { await handle.writeFile(item.bytes!); await handle.sync(); } finally { await handle.close(); }
          }
        }
        for (const folder of folders.reverse()) await chmod(folder, 0o500);
      }
      await writeJson(path.join(staging, 'assembly.json'), assembly);
      await rename(staging, target);
      return structuredClone(assembly);
    } catch (error) {
      // Read-only files are immutable to the graph; restore directory permissions for cleanup.
      for (const folder of await readdir(path.join(staging, 'skills')).catch(() => [])) {
        const restorePermissions = async (location: string): Promise<void> => {
          await chmod(location, 0o700).catch(() => {});
          for (const child of await readdir(location, { withFileTypes: true }).catch(() => [])) if (child.isDirectory()) await restorePermissions(path.join(location, child.name));
        };
        await restorePermissions(path.join(staging, 'skills', folder));
      }
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
  }
  return {
    get: (id: string) => run(() => readAgent(id)),
    list: () => run(async () => {
      await readAgent('browser-assistant');
      const result: AgentEntry[] = [];
      for (const file of (await readdir(await directory(agentsDir))).sort()) if (file.endsWith('.json') && ID.test(file.slice(0, -5))) {
        if (result.length >= 256) throw new RuntimeError('resource-limit', 'Agent 数量超过 256。');
        result.push(await readAgent(file.slice(0, -5)));
      }
      return result;
    }),
    save: (id: string, value: unknown) => run(async () => {
      const current = await readAgent(id);
      if (current.source !== 'local') throw new RuntimeError('read-only', '官方 Agent 只读，请先复制为本地 Agent。');
      const config = configuration(value);
      await validateReferences(config);
      await writeJson(path.join(await directory(agentsDir), `${id}.json`), entry(id, config));
    }),
    create: (options: { configuration?: unknown; copyFrom?: string } = {}) => run(async () => {
      const config = options.configuration === undefined ? (options.copyFrom ? (await readAgent(options.copyFrom)).configuration : defaultConfiguration) : configuration(options.configuration);
      await validateReferences(config);
      const created = entry(`local-${randomUUID()}`, config);
      await writeJson(path.join(await directory(agentsDir), `${created.id}.json`), created);
      return created;
    }),
    prepareSession: (options: PrepareOptions) => run(() => prepare(options)),
    mcpServers: async () => {
      const list = await mcpCatalog.list();
      if (!Array.isArray(list) || list.length > 256) throw invalid('MCP 目录无效。');
      return list.map(mcpConfiguration);
    },
  };
}
