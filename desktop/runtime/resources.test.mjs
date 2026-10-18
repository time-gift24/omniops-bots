import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { createResources } from './resources.mjs';

test('real workspace scopes, session baselines and source skills stay isolated', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'omniops-bots-resources-'));
  try {
    const workspace = path.join(root, 'project');
    const skillsDir = path.join(root, 'skills');
    await Promise.all([mkdir(workspace), mkdir(path.join(skillsDir, 'example'), { recursive: true })]);
    await promisify(execFile)('git', ['init', '--quiet', workspace]);
    await writeFile(path.join(workspace, '.gitignore'), 'payload.bin\n');
    await writeFile(path.join(workspace, 'payload.bin'), Buffer.alloc(3 * 1024 * 1024));
    await writeFile(path.join(workspace, 'a.txt'), 'one\ntwo\n');
    await writeFile(path.join(workspace, '.env'), 'private');
    await writeFile(path.join(root, 'outside.txt'), 'outside');
    await symlink(path.join(root, 'outside.txt'), path.join(workspace, 'link.txt'));
    const original = '---\nname: Example\ndescription: Test skill\n---\nUse this skill.';
    await writeFile(path.join(skillsDir, 'example', 'SKILL.md'), original);
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
    await resources.handle('agent_save', { id: agent.id, configuration: { ...agent.configuration, skillIds: ['example'] } });
    assert.match(await resources.handle('agent_instructions', { id: agent.id }), /Use this skill/u);
    assert.equal(await readFile(path.join(skillsDir, 'example', 'SKILL.md'), 'utf8'), original);
    const copied = resources.getAgent(agent.id);
    copied.instructions = 'mutated';
    assert.notEqual(resources.getAgent(agent.id).instructions, copied.instructions);
    await assert.rejects(resources.handle('agent_save', { id: agent.id, configuration: { ...agent.configuration, mcpServerIds: ['fake'] } }));
    const separate = createResources({ homeDir: root, skillsDir });
    await assert.rejects(separate.handle('workspace_file', { scope, path: 'a.txt' }));
    assert.deepEqual(separate.getAgent(agent.id).skillIds, []);
  } finally { await rm(root, { recursive: true, force: true }); }
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
