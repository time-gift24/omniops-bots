import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { packageContentId } from './assembly.ts';
import { createResources } from './resources.ts';

async function writable(directory) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) return;
  await chmod(directory, 0o700);
  for (const entry of await readdir(directory)) await writable(path.join(directory, entry));
}
async function fixture(action, options = {}) {
  const homeDir = await mkdtemp(path.join(tmpdir(), 'omniops-bots-assembly-'));
  const settings = { homeDir, ...options };
  const resources = createResources(settings);
  try { await action({ homeDir, settings, resources }); }
  finally { await writable(homeDir); await rm(homeDir, { recursive: true, force: true }); }
}
const saveFile = (resources, id, file, bytes) => resources.handle('skill_library_write', { id, path: file, data: Buffer.from(bytes).toString('base64'), replace: true });
async function skill(resources, name = 'ops-check', content = 'Original instructions') {
  const created = await resources.handle('skill_library_create', { name, description: 'Check the local operation.' });
  await saveFile(resources, created.id, 'SKILL.md', `---\nname: ${name}\ndescription: Check the local operation.\n---\n\n${content}\n`);
  return created;
}
async function configured(resources, skillIds = [], extra = {}) {
  const { agents } = await resources.handle('agents_load');
  return resources.handle('agent_create', { configuration: { ...agents[0].configuration, name: 'Local operator', skillIds, ...extra } });
}
const physical = (snapshot, index, file = '') => path.join(snapshot.directory, snapshot.skills[index].mountPath.slice(1), file);

test('local Agent configuration persists, copies remain independent, and missing tools fail before execution', async () => fixture(async ({ homeDir, resources, settings }) => {
  const selected = await skill(resources);
  const created = await configured(resources, [selected.id]);
  assert.equal(created.source, 'local');
  assert.match(created.contentId, /^[a-f0-9]{64}$/);
  assert.equal('requireApproval' in created.configuration, false);
  const copy = await resources.handle('agent_create', { copyFrom: created.id });
  await resources.handle('agent_save', { id: created.id, configuration: { ...created.configuration, instructions: 'Changed instructions', toolIds: ['future_browser_tool'] } });
  const reopened = createResources(settings);
  assert.equal((await reopened.getAgent(created.id)).instructions, 'Changed instructions');
  assert.equal((await reopened.getAgent(copy.id)).instructions, copy.configuration.instructions);
  const { agents } = await reopened.handle('agents_load');
  assert.notEqual(agents.find(agent => agent.id === created.id).contentId, created.contentId);
  await assert.rejects(reopened.prepareSession({ sessionId: 'missing-tool', agentId: created.id }), error => error.kind === 'missing-tools' && /future_browser_tool.*更新桌面端/u.test(error.message));
  await assert.rejects(reopened.getAgent('../outside'));
  const official = { ...copy, source: 'official', releaseTag: 'v.1.0.0' };
  await writeFile(path.join(homeDir, '.omnimind-ops/agents', `${copy.id}.json`), JSON.stringify(official));
  await assert.rejects(reopened.handle('agent_save', { id: copy.id, configuration: copy.configuration }), error => error.kind === 'read-only');
  const localCopy = await reopened.handle('agent_create', { copyFrom: copy.id });
  assert.equal(localCopy.source, 'local');
  assert.equal(localCopy.releaseTag, undefined);
  const officialSnapshot = await reopened.prepareSession({ sessionId: 'official-agent', agentId: copy.id });
  assert.equal(officialSnapshot.agent.contentId, official.contentId);
  assert.match(officialSnapshot.assemblyContentId, /^[a-f0-9]{64}$/);
}));

test('complete session snapshots retain binary files, empty directories, immutable configuration and metadata across restart', async () => fixture(async ({ resources, settings }) => {
  const selected = await skill(resources);
  await resources.handle('skill_library_mkdir', { id: selected.id, path: 'references' });
  await resources.handle('skill_library_mkdir', { id: selected.id, path: 'empty' });
  await saveFile(resources, selected.id, 'references/bytes.bin', Buffer.from([0, 1, 2, 255]));
  await saveFile(resources, selected.id, 'references/readme.md', 'Read this original reference.');
  const agent = await configured(resources, [selected.id]);
  const first = await resources.prepareSession({ sessionId: 'workspace:session/unsafe-on-windows', agentId: agent.id, model: 'fixture-model', modelParameters: { temperature: 0 }, desktopVersion: '0.1.0' });
  assert.equal((await stat(physical(first, 0, 'empty'))).isDirectory(), true);
  assert.deepEqual(await readFile(physical(first, 0, 'references/bytes.bin')), Buffer.from([0, 1, 2, 255]));
  if (process.platform !== 'win32') {
    assert.equal((await stat(physical(first, 0, 'SKILL.md'))).mode & 0o222, 0);
    assert.equal((await stat(physical(first, 0))).mode & 0o222, 0);
  }
  await saveFile(resources, selected.id, 'references/readme.md', 'Changed source reference.');
  await resources.handle('agent_save', { id: agent.id, configuration: { ...agent.configuration, instructions: 'New Agent instructions' } });
  const reopened = createResources(settings);
  const resumed = await reopened.prepareSession({ sessionId: first.sessionId, agentId: agent.id, model: 'new-model' });
  assert.deepEqual(resumed, first);
  assert.equal(await readFile(physical(resumed, 0, 'references/readme.md'), 'utf8'), 'Read this original reference.');
  const later = await reopened.prepareSession({ sessionId: 'new-session', agentId: agent.id });
  assert.notEqual(later.skills[0].contentId, first.skills[0].contentId);
  assert.notEqual(later.agent.contentId, first.agent.contentId);
  assert.equal(later.agent.configuration.instructions, 'New Agent instructions');
  await assert.rejects(reopened.prepareSession({ sessionId: first.sessionId, agentId: 'browser-assistant' }), /固定其他装配/u);
  await chmod(physical(first, 0, 'SKILL.md'), 0o600);
  await writeFile(physical(first, 0, 'SKILL.md'), 'tampered');
  await assert.rejects(reopened.prepareSession({ sessionId: first.sessionId }), /快照已改变/u);
}));

test('official cache content is verified and MCP snapshots retain references without credential values', async () => {
  let server = { id: 'ops', name: 'Ops MCP', description: 'Local fixture', url: 'http://127.0.0.1:4312/mcp', credentialEnv: 'OMNIOPS_TEST_MCP_KEY', token: 'never-save-this-secret' };
  await fixture(async ({ homeDir, resources, settings }) => {
    const entries = [
      { path: 'SKILL.md', kind: 'file', bytes: Buffer.from('---\nname: official-ops\ndescription: An immutable package.\n---\nRead references.\n') },
      { path: 'empty', kind: 'folder' },
      { path: 'asset.bin', kind: 'file', bytes: Buffer.from([255, 0, 19]) },
    ];
    const contentId = packageContentId(entries);
    assert.equal(packageContentId(entries.toReversed()), contentId);
    assert.notEqual(packageContentId(entries.filter(entry => entry.path !== 'empty')), contentId);
    const directory = path.join(homeDir, '.omnimind-ops/skills/releases/official-ops', contentId);
    await mkdir(path.join(directory, 'empty'), { recursive: true });
    for (const entry of entries.filter(item => item.kind === 'file')) await writeFile(path.join(directory, entry.path), entry.bytes);
    await writeFile(path.join(directory, '../tags.json'), JSON.stringify({ 'v.1.0.0': contentId }));
    const id = `official/official-ops/${contentId}`;
    const agent = await configured(resources, [id], { mcpServerIds: ['ops'] });
    const catalog = await resources.handle('agents_load');
    assert.deepEqual(catalog.resources.skills.find(skill => skill.id === id), { id, name: 'official-ops', description: 'An immutable package.', source: 'official', contentId, releaseTag: 'v.1.0.0' });
    const first = await resources.prepareSession({ sessionId: 'official-session', agentId: agent.id });
    assert.equal(first.skills[0].contentId, contentId);
    assert.equal(first.skills[0].releaseTag, 'v.1.0.0');
    const saved = await readFile(path.join(first.directory, 'assembly.json'), 'utf8');
    assert.equal(saved.includes('never-save-this-secret'), false);
    assert.equal(first.mcpServers[0].credentialEnv, 'OMNIOPS_TEST_MCP_KEY');
    server = { ...server, url: 'http://127.0.0.1:9999/changed' };
    await writeFile(path.join(directory, 'asset.bin'), Buffer.from([1, 2, 3]));
    const reopened = createResources(settings);
    assert.equal((await reopened.prepareSession({ sessionId: first.sessionId })).mcpServers[0].url, first.mcpServers[0].url);
    await assert.rejects(reopened.prepareSession({ sessionId: 'corrupt-official', agentId: agent.id }), error => error.kind === 'integrity');
  }, { mcpCatalog: { list: () => [server], get: id => id === 'ops' ? server : undefined } });
});

test('a draft experiment replaces its matching Skill for this session without modifying the template', async () => fixture(async ({ resources }) => {
  const original = await skill(resources, 'experiment-ops', 'Template content');
  const draft = await skill(resources, 'experiment-ops', 'Experimental content');
  await saveFile(resources, draft.id, 'extra.bin', Buffer.from([1, 0, 9]));
  const agent = await configured(resources, [original.id]);
  const experimental = await resources.prepareSession({ sessionId: 'experiment', agentId: agent.id, experimentSkillId: draft.id });
  assert.deepEqual(experimental.agent.configuration.skillIds, [draft.id]);
  assert.deepEqual((await resources.getAgent(agent.id)).skillIds, [original.id]);
  assert.deepEqual(await readFile(physical(experimental, 0, 'extra.bin')), Buffer.from([1, 0, 9]));
  const ordinary = await resources.prepareSession({ sessionId: 'ordinary', agentId: agent.id });
  assert.match(await readFile(physical(ordinary, 0, 'SKILL.md'), 'utf8'), /Template content/u);
  await assert.rejects(resources.prepareSession({ sessionId: 'experiment', experimentSkillId: original.id }), /固定其他装配/u);
  const appended = await resources.prepareSession({ sessionId: 'append-experiment', experimentSkillId: draft.id });
  assert.deepEqual(appended.agent.configuration.skillIds, [draft.id]);
}));

test('an official copy experiments against its entry name instead of its local display name', async () => fixture(async ({ homeDir, resources }) => {
  const bytes = Buffer.from('---\nname: official-ops\ndescription: Immutable operations.\n---\nOriginal instructions.\n');
  const contentId = packageContentId([{ path: 'SKILL.md', kind: 'file', bytes }]);
  const directory = path.join(homeDir, '.omnimind-ops/skills/releases/official-ops', contentId);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'SKILL.md'), bytes);
  const originalId = `official/official-ops/${contentId}`;
  const copy = await resources.handle('skill_library_copy', { id: originalId });
  assert.notEqual(copy.name, 'official-ops');
  assert.deepEqual(await readFile(path.join(homeDir, '.omnimind-ops/skills', copy.id, 'SKILL.md')), bytes);
  await saveFile(resources, copy.id, 'SKILL.md', Buffer.from(bytes.toString().replace('Original instructions.', 'Experimental instructions.')));
  const agent = await configured(resources, [originalId]);
  const snapshot = await resources.prepareSession({ sessionId: 'official-copy-experiment', agentId: agent.id, experimentSkillId: copy.id });
  assert.deepEqual(snapshot.agent.configuration.skillIds, [copy.id]);
  assert.equal(snapshot.skills.length, 1);
  assert.match(await readFile(physical(snapshot, 0, 'SKILL.md'), 'utf8'), /Experimental instructions\./u);
  assert.deepEqual((await resources.getAgent(agent.id)).skillIds, [originalId]);
  assert.deepEqual(await readFile(path.join(directory, 'SKILL.md')), bytes);
}));

test('invalid Skill metadata, duplicate names, symlinks and incomplete snapshots fail instead of dropping capabilities', async () => fixture(async ({ homeDir, resources }) => {
  const first = await skill(resources, 'same-name');
  const second = await skill(resources, 'same-name');
  const duplicate = await configured(resources, [first.id, second.id]);
  await assert.rejects(resources.prepareSession({ sessionId: 'duplicates', agentId: duplicate.id }), /同名入口/u);
  const valid = await configured(resources, [first.id]);
  await saveFile(resources, first.id, 'SKILL.md', '# No metadata');
  await assert.rejects(resources.prepareSession({ sessionId: 'invalid-metadata', agentId: valid.id }), /元信息/u);
  await saveFile(resources, first.id, 'SKILL.md', '---\nname: okay\ndescription: Valid metadata.\n---\nRead only.\n');
  const directory = path.join(homeDir, '.omnimind-ops/skills', first.id);
  await writeFile(path.join(homeDir, 'private.txt'), 'private');
  await symlink(path.join(homeDir, 'private.txt'), path.join(directory, 'linked.txt'));
  await assert.rejects(resources.prepareSession({ sessionId: 'symlink', agentId: valid.id }), /链接/u);
  await rm(path.join(directory, 'linked.txt'));
  const snapshot = await resources.prepareSession({ sessionId: 'incomplete', agentId: valid.id });
  await rm(path.join(snapshot.directory, 'assembly.json'));
  await assert.rejects(resources.prepareSession({ sessionId: snapshot.sessionId, agentId: valid.id }), /不完整/u);
  const snapshots = await readdir(path.join(homeDir, '.omnimind-ops/runs'));
  assert.equal(snapshots.some(file => file.startsWith('.pending-')), false);
  await assert.rejects(resources.prepareSession({ sessionId: 'secret-model', modelParameters: { apiKey: 'secret' } }), /不允许保存/u);
}));

test('new Agents and copies remain unpublished across restart until a successful explicit save', async () => fixture(async ({ resources, settings }) => {
  const { agents: existing } = await resources.handle('agents_load');
  const draft = await resources.handle('agent_create', {});
  const copy = await resources.handle('agent_create', { copyFrom: existing[0].id });
  assert.equal(draft.source, 'local');
  assert.equal(draft.configuration.name, '');
  assert.equal(draft.configuration.instructions, '');
  assert.equal('unpublished' in draft, false);
  assert.equal('unpublished' in copy, false);
  const reopened = createResources(settings);
  const listed = async source => (await source.handle('agents_load')).agents.map(agent => agent.id);
  assert.deepEqual(await listed(reopened), existing.map(agent => agent.id));
  assert.equal((await reopened.getAgent(draft.id)).name, '');
  assert.deepEqual(await reopened.getAgent(copy.id), copy.configuration);
  await assert.rejects(reopened.prepareSession({ sessionId: 'empty-draft', agentId: draft.id }), /Agent 名称/u);
  await assert.rejects(reopened.handle('agent_save', { id: draft.id, configuration: { ...draft.configuration, name: 'Draft Agent' } }), /指令无效/u);
  await assert.rejects(reopened.handle('agent_save', { id: copy.id, configuration: { ...copy.configuration, mcpServerIds: ['missing-mcp'] } }), /不存在的 MCP/u);
  assert.deepEqual(await listed(createResources(settings)), existing.map(agent => agent.id));
  await reopened.handle('agent_save', { id: draft.id, configuration: { ...draft.configuration, name: 'Draft Agent', instructions: 'Do the work.' } });
  const saved = createResources(settings);
  assert.equal((await saved.getAgent(draft.id)).name, 'Draft Agent');
  assert.deepEqual((await listed(saved)).toSorted(), [...existing.map(agent => agent.id), draft.id].toSorted());
  const snapshot = await saved.prepareSession({ sessionId: 'saved-draft', agentId: draft.id });
  assert.equal(snapshot.agent.configuration.name, 'Draft Agent');
  assert.equal('unpublished' in snapshot.agent, false);
  await saved.handle('agent_save', { id: copy.id, configuration: copy.configuration });
  const published = (await createResources(settings).handle('agents_load')).agents;
  assert.deepEqual(published.map(agent => agent.id).toSorted(), [...existing.map(agent => agent.id), draft.id, copy.id].toSorted());
  assert.equal(published.some(agent => 'unpublished' in agent), false);
}));
