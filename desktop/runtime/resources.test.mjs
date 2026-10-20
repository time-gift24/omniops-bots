import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { createResources } from './resources.mjs';
import { createChatHistory } from './chat/history.mjs';
import { createScriptWorkspace } from './browser/script-workspace.mjs';
import { storageId } from './json-store.mjs';

async function git(args) {
  const exec = promisify(execFile), env = { ...process.env };
  const { stdout } = await exec('git', ['rev-parse', '--local-env-vars']);
  for (const name of stdout.trim().split('\n')) delete env[name];
  return exec('git', args, { env });
}

test('real workspace scopes, session baselines and source skills stay isolated', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'omniops-bots-resources-'));
  try {
    const workspace = path.join(root, 'project');
    const skillsDir = path.join(root, 'skills');
    await Promise.all([mkdir(workspace), mkdir(path.join(skillsDir, 'local', 'example'), { recursive: true })]);
    await git(['init', '--quiet', workspace]);
    await writeFile(path.join(workspace, '.gitignore'), 'payload.bin\n');
    await writeFile(path.join(workspace, 'payload.bin'), Buffer.alloc(3 * 1024 * 1024));
    await writeFile(path.join(workspace, 'a.txt'), 'one\ntwo\n');
    await writeFile(path.join(workspace, '.env'), 'private');
    await writeFile(path.join(root, 'outside.txt'), 'outside');
    await symlink(path.join(root, 'outside.txt'), path.join(workspace, 'link.txt'));
    const original = '---\nname: Example\ndescription: Test skill\n---\nUse this skill.';
    await writeFile(path.join(skillsDir, 'local', 'example', 'SKILL.md'), original);
    const resources = createResources({ homeDir: root, skillsDir });
    const scope = { workspaceId: 'w', sessionId: 's1', workspacePath: workspace };
    await assert.rejects(resources.handle('workspace_files', { scope }), /请先选择有效/u);
    const directory = await resources.handle('workspace_resolve', { path: workspace });
    scope.workspacePath = directory.path;
    await resources.handle('workspace_bind', { scope });
    assert.deepEqual((await resources.handle('workspace_files', { scope })).map(file => file.path), ['.gitignore', 'a.txt']);
    for (const file of ['../outside.txt', 'link.txt', '.env']) await assert.rejects(resources.handle('workspace_file', { scope, path: file }));
    await writeFile(path.join(workspace, 'a.txt'), 'one\nchanged\n');
    await writeFile(path.join(workspace, 'b.txt'), 'new\n');
    const changes = await resources.handle('workspace_changes', { scope });
    assert.equal(changes.fileCount, 2);
    assert.equal(changes.added, 2);
    assert.equal(changes.removed, 1);
    const nextScope = { ...scope, sessionId: 's2' };
    await resources.handle('workspace_bind', { scope: nextScope });
    assert.equal((await resources.handle('workspace_changes', { scope: nextScope })).fileCount, 0);
    assert.deepEqual((await resources.handle('workspace_file', { scope, path: 'a.txt' })).lines, ['one', 'changed', '']);
    const { agents, resources: catalog } = await resources.handle('agents_load');
    assert.equal(catalog.mcpServers.length, 0);
    const agent = agents[0];
    await resources.handle('agent_save', { id: agent.id, configuration: { ...agent.configuration, skillIds: ['local/example'] } });
    assert.match(await resources.handle('agent_instructions', { id: agent.id }), /Use this skill/u);
    assert.equal(await readFile(path.join(skillsDir, 'local', 'example', 'SKILL.md'), 'utf8'), original);
    const copied = await resources.getAgent(agent.id);
    copied.instructions = 'mutated';
    assert.notEqual((await resources.getAgent(agent.id)).instructions, copied.instructions);
    await assert.rejects(resources.handle('agent_save', { id: agent.id, configuration: { ...agent.configuration, mcpServerIds: ['fake'] } }));
    const separate = createResources({ homeDir: root, skillsDir });
    await assert.rejects(separate.handle('workspace_file', { scope, path: 'a.txt' }));
    assert.deepEqual((await separate.getAgent(agent.id)).skillIds, ['local/example']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('workspace Git ignores inherited hook repository and index locations', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'omniops-bots-hook-env-'));
  const inherited = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE, GIT_INDEX_FILE: process.env.GIT_INDEX_FILE, GIT_COMMON_DIR: process.env.GIT_COMMON_DIR };
  try {
    const workspace = path.join(root, 'workspace'), foreign = path.join(root, 'foreign');
    await mkdir(workspace); await mkdir(foreign);
    await git(['init', '--quiet', workspace]); await git(['init', '--quiet', foreign]);
    await writeFile(path.join(foreign, 'foreign-only.txt'), 'foreign');
    await git(['-C', foreign, 'add', 'foreign-only.txt']);
    await writeFile(path.join(workspace, '.gitignore'), 'ignored.txt\n');
    await writeFile(path.join(workspace, 'ignored.txt'), 'ignored');
    await writeFile(path.join(workspace, 'real.txt'), 'before\n');
    Object.assign(process.env, { GIT_DIR: path.join(foreign, '.git'), GIT_WORK_TREE: foreign, GIT_INDEX_FILE: path.join(foreign, '.git', 'index'), GIT_COMMON_DIR: path.join(foreign, '.git') });
    const resources = createResources({ homeDir: root });
    const directory = await resources.handle('workspace_resolve', { path: workspace });
    const scope = { workspaceId: 'w', sessionId: 'hook-session', workspacePath: directory.path };
    await resources.handle('workspace_bind', { scope });
    assert.deepEqual((await resources.handle('workspace_files', { scope })).map(file => file.path), ['.gitignore', 'real.txt']);
    await writeFile(path.join(workspace, 'real.txt'), 'after\n');
    assert.deepEqual(await resources.handle('workspace_changes', { scope }), { files: [{ path: 'real.txt', added: 1, removed: 1 }], fileCount: 1, added: 1, removed: 1 });
  } finally {
    for (const [name, value] of Object.entries(inherited)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    await rm(root, { recursive: true, force: true });
  }
});

test('concurrent session captures share a bounded baseline budget', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'omniops-bots-baselines-'));
  try {
    await writeFile(path.join(root, 'data.txt'), Buffer.alloc(2 * 1024 * 1024, 97));
    const resources = createResources({ homeDir: root, skillsDir: path.join(root, 'missing-skills') });
    const directory = await resources.handle('workspace_resolve', { path: root });
    const captures = await Promise.allSettled(Array.from({ length: 33 }, (_, index) => resources.handle('workspace_bind', { scope: { workspaceId: 'w', workspacePath: directory.path, sessionId: `s${index}` } })));
    assert.equal(captures.filter(result => result.status === 'fulfilled').length, 32);
    const rejected = captures.find(result => result.status === 'rejected');
    assert.equal(rejected.reason.kind, 'resource-limit');
    // Reaching the history budget must not prevent ordinary file access.
    assert.equal((await resources.handle('workspace_files', { scope: { workspaceId: 'w', workspacePath: directory.path, sessionId: 's32' } })).length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('workspace-free scopes use isolated real thread directories and retain file boundaries', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'omniops-bots-temporary-'));
  try {
    const resources = createResources({ homeDir: root });
    const scope = { sessionId: 'session-123' };
    const temporaryDir = path.join(await realpath(root), '.omniops-bots', 'tmp');
    const directory = path.join(temporaryDir, scope.sessionId);
    await resources.handle('workspace_bind', { scope });
    assert.equal((await stat(directory)).isDirectory(), true);
    assert.deepEqual(await resources.handle('workspace_files', { scope }), []);
    await writeFile(path.join(directory, 'answer.txt'), 'one\ntwo\n');
    await writeFile(path.join(directory, '.env'), 'secret');
    await writeFile(path.join(root, 'outside.txt'), 'outside');
    await symlink(path.join(root, 'outside.txt'), path.join(directory, 'linked.txt'));
    assert.deepEqual((await resources.handle('workspace_files', { scope })).map(file => file.path), ['answer.txt']);
    assert.deepEqual((await resources.handle('workspace_file', { scope, path: 'answer.txt' })).lines, ['one', 'two', '']);
    assert.equal((await resources.handle('workspace_changes', { scope })).added, 2);
    assert.deepEqual(await resources.handle('workspace_files', { scope: { sessionId: 'other-session' } }), []);
    for (const file of ['../session-123/answer.txt', '../outside.txt', 'linked.txt', '.env']) {
      const target = file.startsWith('../session-123') ? { sessionId: 'other-session' } : scope;
      await assert.rejects(resources.handle('workspace_file', { scope: target, path: file }));
    }
    const reopened = createResources({ homeDir: root });
    assert.equal((await reopened.handle('workspace_file', { scope, path: 'answer.txt' })).lines[0], 'one');
    for (const sessionId of ['../../escaped', '..', 'agent-test:browser-assistant', 'CON', '会'.repeat(128)]) {
      await resources.handle('workspace_files', { scope: { sessionId } });
    }
    assert.equal((await stat(path.join(temporaryDir, '%2E%2E%2F%2E%2E%2Fescaped'))).isDirectory(), true);
    await assert.rejects(stat(path.join(root, 'escaped')), error => error.code === 'ENOENT');
    await symlink(directory, path.join(temporaryDir, 'redirected'));
    await assert.rejects(resources.handle('workspace_files', { scope: { sessionId: 'redirected' } }), /符号链接/u);
    await assert.rejects(resources.handle('workspace_files', { scope: { sessionId: 'partial', workspaceId: 'w' } }), /工作区路径/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('legacy sessions retain existing scripts and files through thread-only and explicit workspace restores', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'omniops-bots-legacy-root-'));
  try {
    const sessionId = 'legacy-session';
    const runsDir = path.join(root, '.omnimind-ops', 'runs');
    const options = { homeDir: root, runsDir };
    const first = await createResources(options).prepareSession({ sessionId });
    const { workingDirectory: _workingDirectory, workspacePath: _workspacePath, ...legacy } = first;
    const name = 'existing.mjs', code = 'export default async () => ({ retained: true });';
    const scriptWorkspace = dataDir => createScriptWorkspace({ dataDir, ensureBrowser: async () => {}, signalEvent() {}, redact: String });
    await (await scriptWorkspace(legacy.directory)).save({ name, code });
    await writeFile(path.join(legacy.directory, 'answer.txt'), 'legacy answer\n');
    const history = await createChatHistory(runsDir);
    await history.save(sessionId, { snapshot: legacy, messages: [] });
    const historyFile = path.join(runsDir, '.sessions', `${storageId(sessionId)}.json`);
    const historyBytes = await readFile(historyFile);
    const workspace = path.join(root, 'project');
    await mkdir(workspace);
    await writeFile(path.join(workspace, 'unrelated.txt'), 'new workspace');

    for (const upgraded of [false, true]) {
      if (upgraded) await history.save(sessionId, { snapshot: { ...legacy, workingDirectory: legacy.directory }, messages: [] });
      const stored = await readFile(historyFile);
      const resources = createResources(options);
      const directory = await resources.handle('workspace_resolve', { path: workspace });
      for (const scope of [{ sessionId }, { sessionId, workspaceId: 'w', workspacePath: directory.path }]) {
        const restored = await resources.prepareSession({ sessionId, ...(scope.workspacePath ? { workspacePath: scope.workspacePath } : {}) });
        assert.equal(restored.workingDirectory, legacy.directory);
        assert.deepEqual((await (await scriptWorkspace(restored.workingDirectory)).list()).map(script => script.name), [name]);
        assert.equal((await (await scriptWorkspace(restored.workingDirectory)).read(name)).code, code);
        await resources.handle('workspace_bind', { scope });
        const files = await resources.handle('workspace_files', { scope });
        assert.ok(files.some(file => file.path === `automation/scripts/${name}`));
        assert.ok(files.some(file => file.path === 'answer.txt'));
        assert.ok(!files.some(file => file.path === 'unrelated.txt'));
        assert.deepEqual((await resources.handle('workspace_file', { scope, path: 'answer.txt' })).lines, ['legacy answer', '']);
        assert.equal((await resources.handle('workspace_changes', { scope })).fileCount, 0);
      }
      assert.deepEqual(await readFile(historyFile), stored, 'directory recovery must not rewrite history');
    }
    assert.deepEqual(JSON.parse(historyBytes).snapshot, legacy);
    assert.equal(await readFile(path.join(legacy.directory, 'automation', 'scripts', name), 'utf8'), code);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('legacy history cannot redirect the work root or follow symlinked session directories', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'omniops-bots-legacy-boundary-'));
  try {
    const sessionId = 'legacy-session';
    const runsDir = path.join(root, '.omnimind-ops', 'runs');
    const options = { homeDir: root, runsDir };
    const { workingDirectory: _workingDirectory, ...legacy } = await createResources(options).prepareSession({ sessionId });
    const history = await createChatHistory(runsDir);
    const outside = path.join(root, 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, 'private.txt'), 'outside data');
    for (const directory of [outside, path.join(runsDir, 'another-session'), undefined]) {
      await history.save(sessionId, { snapshot: { ...legacy, directory }, messages: [] });
      const resources = createResources(options);
      await assert.rejects(resources.prepareSession({ sessionId }));
      await assert.rejects(resources.handle('workspace_files', { scope: { sessionId } }));
    }
    await history.save(sessionId, { snapshot: legacy, messages: [] });
    const moved = `${legacy.directory}-retained`;
    await rename(legacy.directory, moved);
    await symlink(outside, legacy.directory);
    await assert.rejects(createResources(options).handle('workspace_files', { scope: { sessionId } }), /符号链接|会话目录/u);
    await assert.rejects(createResources(options).prepareSession({ sessionId }), /符号链接/u);
    await rm(legacy.directory);
    await rename(moved, legacy.directory);
    const movedRuns = `${runsDir}-retained`;
    await rename(runsDir, movedRuns);
    await symlink(movedRuns, runsDir);
    await assert.rejects(createResources(options).handle('workspace_files', { scope: { sessionId } }), /符号链接|会话目录/u);
    assert.equal(await readFile(path.join(outside, 'private.txt'), 'utf8'), 'outside data');
  } finally { await rm(root, { recursive: true, force: true }); }
});
