import { constants } from 'node:fs';
import { access, lstat, mkdtemp, open, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { RuntimeError, invalid } from './errors.mjs';
import { createSkillLibrary, defaultSkillRoot } from './skill-library.mjs';

const exec = promisify(execFile);
const MAX_FILE = 2 * 1024 * 1024;
const MAX_TOTAL = 32 * 1024 * 1024;
const MAX_FILES = 5000;
const IGNORED = new Set(['.git', '.svn', 'node_modules', 'target', 'dist', 'build', '.scratch', '.next', '.venv', '__pycache__']);
const TOOLS = [
  { id: 'inspect_browser', name: '查看网页', description: '读取内置浏览器当前页面。' },
  { id: 'list_playwright_scripts', name: '列出脚本', description: '查看当前自动化脚本。' },
  { id: 'read_playwright_script', name: '读取脚本', description: '读取自动化脚本源码。' },
  { id: 'write_playwright_script', name: '编写脚本', description: '准备在内置浏览器中运行的脚本。' },
  { id: 'run_playwright_script', name: '执行脚本', description: '经逐次审批后操作内置浏览器。' },
];
const METHODS = new Set(['agents_load', 'agent_save', 'agent_instructions', 'skills_list', 'workspace_directories', 'workspace_resolve', 'workspace_bind', 'workspace_files', 'workspace_file', 'workspace_changes']);

function string(value, label, max = 4096) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) throw invalid(`${label}无效。`);
  return value;
}
function contained(root, file) {
  const relative = path.relative(root, file);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
function excluded(name) {
  return IGNORED.has(name) || name === '.env' || name.startsWith('.env.') || /\.(?:pem|key|p12|pfx)$/iu.test(name);
}
function hash(buffer) { return createHash('sha256').update(buffer).digest('hex'); }
function sizeLabel(bytes) { return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`; }

async function readBounded(root, relative, max = MAX_FILE) {
  string(relative, '文件路径');
  if (path.isAbsolute(relative) || relative.split(/[\\/]/u).some(excluded)) throw invalid('文件不在可读取的工作区范围内。');
  const candidate = path.resolve(root, relative);
  if (!contained(root, candidate)) throw invalid('文件不在当前工作区内。');
  let canonical;
  try { canonical = await realpath(candidate); } catch { throw new RuntimeError('file-unavailable', '文件已移除或无法读取。'); }
  if (!contained(root, canonical) || path.relative(root, canonical).split(path.sep).some(excluded)) throw invalid('不能读取指向工作区外或受限位置的文件。');
  const handle = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw invalid('请选择普通文件。');
    if (info.size > max) throw new RuntimeError('resource-limit', `文件超过 ${sizeLabel(max)}，无法预览。`);
    const buffer = Buffer.alloc(Math.min(max + 1, info.size + 1));
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > max || length > info.size) throw new RuntimeError('resource-limit', '文件在读取过程中变大，请重试。');
    return buffer.subarray(0, length);
  } finally { await handle.close(); }
}

async function filesIn(root) {
  const files = [];
  let tracked;
  try {
    // Git already understands nested ignore files and generated desktop payloads.
    tracked = (await exec('git', ['-C', root, '-c', 'core.fsmonitor=false', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], { timeout: 10000, maxBuffer: 4 * 1024 * 1024 })).stdout.split('\0').filter(Boolean);
  } catch { /* Non-Git workspaces use the ordinary directory walk below. */ }
  if (tracked) {
    for (const relative of [...new Set(tracked)].sort()) {
      if (relative.split(/[\\/]/u).some(excluded)) continue;
      const absolute = path.resolve(root, relative);
      if (!contained(root, absolute)) continue;
      let info;
      try { info = await lstat(absolute); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (!info.isFile() || !contained(root, await realpath(absolute))) continue;
      if (files.length >= MAX_FILES) throw new RuntimeError('resource-limit', '工作区文件过多，请选择更具体的目录。');
      files.push({ name: path.basename(relative), path: relative.split(path.sep).join('/'), size: sizeLabel(info.size), bytes: info.size });
    }
    return files;
  }
  async function visit(directory, depth) {
    if (depth > 32) throw new RuntimeError('resource-limit', '目录层级过深，请选择更具体的工作区。');
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (excluded(entry.name) || entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute, depth + 1);
      else if (entry.isFile()) {
        if (files.length >= MAX_FILES) throw new RuntimeError('resource-limit', '工作区文件过多，请选择更具体的目录。');
        const info = await stat(absolute);
        files.push({ name: entry.name, path: path.relative(root, absolute).split(path.sep).join('/'), size: sizeLabel(info.size), bytes: info.size });
      }
    }
  }
  await visit(root, 0);
  return files;
}

async function snapshot(root, budget = MAX_TOTAL) {
  const result = new Map();
  let total = 0;
  for (const file of await filesIn(root)) {
    // ponytail: bounded in-memory session baselines; very large workspaces require a narrower selected directory.
    if (file.bytes > MAX_FILE || total + file.bytes > Math.min(MAX_TOTAL, budget)) throw new RuntimeError('resource-limit', '会话文件基线超过内存预算，或单文件超过 2 MB，请选择更具体的工作区。');
    const content = await readBounded(root, file.path);
    total += content.length;
    if (total > Math.min(MAX_TOTAL, budget)) throw new RuntimeError('resource-limit', '文件读取期间超过会话内存预算，请选择更具体的工作区。');
    result.set(file.path, { content, hash: hash(content) });
  }
  return result;
}

async function changedLines(before, after) {
  if (before.includes(0) || after.includes(0)) return { added: 0, removed: 0 };
  const directory = await mkdtemp(path.join(tmpdir(), 'omniops-bots-diff-'));
  try {
    const oldFile = path.join(directory, 'before');
    const newFile = path.join(directory, 'after');
    await Promise.all([writeFile(oldFile, before), writeFile(newFile, after)]);
    let output;
    try { output = (await exec('git', ['diff', '--no-index', '--numstat', '--no-renames', '--no-ext-diff', '--no-textconv', '--', oldFile, newFile], { timeout: 10000, maxBuffer: 1024 * 1024, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_EXTERNAL_DIFF: '' } })).stdout; }
    catch (error) {
      if (error.code !== 1 || typeof error.stdout !== 'string') throw new RuntimeError('diff-unavailable', '无法统计文件变更，请确认已安装 Git。');
      output = error.stdout;
    }
    const [added, removed] = output.trim().split('\t');
    return { added: Number(added) || 0, removed: Number(removed) || 0 };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export function createResources({ homeDir = homedir(), skillsDir = defaultSkillRoot(homeDir) } = {}) {
  const skillLibrary = createSkillLibrary({ root: skillsDir });
  const roots = new Set();
  const sessions = new Map();
  let baselineBytes = 0;
  let baselineQueue = Promise.resolve();
  const agents = new Map([['browser-assistant', {
    name: '浏览器助手', description: '在内置浏览器中查阅信息并完成操作。',
    instructions: '你是桌面浏览器助手。使用内置浏览器核实页面信息，清楚说明将执行的操作。被拒绝后调整方案，不要原样重试。',
    mcpServerIds: [], toolIds: TOOLS.map(tool => tool.id), skillIds: [], requireApproval: true,
  }]]);
  const loadSkills = () => skillLibrary.sourceSkills();
  function getAgent(id) {
    const configuration = agents.get(string(id, 'Agent', 256));
    if (!configuration) throw invalid('找不到这个 Agent。');
    return structuredClone(configuration);
  }
  async function instructionsFor(configuration) {
    const skills = await loadSkills();
    const instructions = [configuration.instructions, ...configuration.skillIds.map(id => {
      const skill = skills.find(item => item.id === id);
      if (!skill) throw invalid('Agent 引用的 Skill 已移除或缺少有效 SKILL.md，请重新装配。');
      return `\n<skill name=${JSON.stringify(skill.name)}>\n${skill.files.find(file => file.path === 'SKILL.md').content}\n</skill>`;
    })].join('\n');
    if (instructions.length > 256 * 1024) throw new RuntimeError('resource-limit', 'Agent 指令与所选技能合计过长，请减少技能后保存。');
    return instructions;
  }
  async function resolveDirectory(value) {
    const input = string(value, '工作区路径');
    const expanded = input === '~' ? homeDir : input.startsWith('~/') ? path.join(homeDir, input.slice(2)) : input;
    if (!path.isAbsolute(expanded)) throw invalid('请输入绝对目录路径。');
    let canonical;
    try {
      canonical = await realpath(expanded);
      if (!(await stat(canonical)).isDirectory()) throw invalid('请选择目录。');
      await access(canonical, constants.R_OK);
    } catch (error) { if (error instanceof RuntimeError) throw error; throw new RuntimeError('directory-unavailable', '目录不存在或没有读取权限。'); }
    roots.add(canonical);
    return { path: canonical, name: path.basename(canonical) || canonical };
  }
  async function scopeRoot(scope) {
    if (!scope || typeof scope !== 'object') throw invalid('工作区上下文缺失。');
    string(scope.workspaceId, '工作区', 256); string(scope.sessionId, '会话', 256);
    const root = string(scope.workspacePath, '工作区路径');
    if (!roots.has(root) || await realpath(root) !== root) throw invalid('请先选择有效的工作区目录。');
    return root;
  }
  async function bind(scope) {
    const root = await scopeRoot(scope);
    const key = JSON.stringify([scope.workspaceId, scope.sessionId]);
    let session = sessions.get(key);
    if (session && session.root !== root) throw invalid('会话工作区路径发生变化。');
    if (!session) {
      if (sessions.size >= 128) throw new RuntimeError('resource-limit', '会话数量达到上限，请重新打开应用。');
      // ponytail: serialize captures and cap retained session baselines at 64 MB.
      const baseline = baselineQueue.then(async () => {
        const value = await snapshot(root, 2 * MAX_TOTAL - baselineBytes);
        baselineBytes += [...value.values()].reduce((sum, file) => sum + file.content.length, 0);
        return value;
      });
      baselineQueue = baseline.then(() => {}, () => {});
      session = { root, baseline };
      sessions.set(key, session);
      session.baseline.catch(() => { if (sessions.get(key) === session) sessions.delete(key); });
    }
    await session.baseline;
    return session;
  }
  async function handle(method, params = {}) {
    if (skillLibrary.hasMethod(method)) return skillLibrary.handle(method, params);
    switch (method) {
      case 'workspace_directories': {
        const result = [];
        for (const candidate of [path.join(homeDir, 'Projects'), path.join(homeDir, 'Documents'), homeDir]) {
          try { result.push(await resolveDirectory(candidate)); } catch { /* Unavailable default folders are not offered. */ }
        }
        return result;
      }
      case 'workspace_resolve': return resolveDirectory(params.path);
      case 'workspace_bind': await bind(params.scope); return null;
      case 'workspace_files': return (await filesIn(await scopeRoot(params.scope))).map(({ bytes: _bytes, ...file }) => file);
      case 'workspace_file': {
        const root = await scopeRoot(params.scope);
        const content = await readBounded(root, params.path);
        if (content.includes(0)) throw invalid('该文件为二进制格式，无法显示文本预览。');
        return { path: params.path, lines: content.toString('utf8').split(/\r?\n/u) };
      }
      case 'workspace_changes': {
        const session = await bind(params.scope);
        const before = await session.baseline;
        const after = await snapshot(session.root);
        const files = [];
        for (const file of [...new Set([...before.keys(), ...after.keys()])].sort()) {
          if (before.get(file)?.hash === after.get(file)?.hash) continue;
          files.push({ path: file, ...await changedLines(before.get(file)?.content ?? Buffer.alloc(0), after.get(file)?.content ?? Buffer.alloc(0)) });
        }
        return { files, fileCount: files.length, added: files.reduce((sum, file) => sum + file.added, 0), removed: files.reduce((sum, file) => sum + file.removed, 0) };
      }
      case 'skills_list': return structuredClone(await loadSkills());
      case 'agents_load': return { agents: [...agents].map(([id, configuration]) => ({ id, configuration: structuredClone(configuration) })), resources: { mcpServers: [], tools: structuredClone(TOOLS), skills: (await loadSkills()).map(({ id, name, description }) => ({ id, name, description })) } };
      case 'agent_save': {
        getAgent(params.id);
        const configuration = params.configuration;
        if (!configuration || typeof configuration !== 'object') throw invalid('Agent 配置无效。');
        string(configuration.name, '名称', 256);
        if (typeof configuration.description !== 'string' || configuration.description.length > 4096 || typeof configuration.instructions !== 'string' || !configuration.instructions.trim() || configuration.instructions.length > 65536 || typeof configuration.requireApproval !== 'boolean') throw invalid('Agent 配置无效。');
        const knownSkills = new Set((await loadSkills()).map(skill => skill.id));
        for (const [key, known] of [['mcpServerIds', new Set()], ['toolIds', new Set(TOOLS.map(tool => tool.id))], ['skillIds', knownSkills]]) {
          if (!Array.isArray(configuration[key]) || configuration[key].length > 256 || new Set(configuration[key]).size !== configuration[key].length || configuration[key].some(id => !known.has(id))) throw invalid('Agent 引用了不可用的资源。');
        }
        await instructionsFor(configuration);
        agents.set(params.id, structuredClone(configuration));
        return null;
      }
      case 'agent_instructions': return instructionsFor(getAgent(params.id));
      default: throw invalid('未知的资源操作。');
    }
  }
  return { hasMethod: method => METHODS.has(method) || skillLibrary.hasMethod(method), handle, getAgent };
}
