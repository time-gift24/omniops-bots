import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createSkillLibrary, defaultSkillRoot } from './skill-library.mjs';
import { createResources } from './resources.mjs';

async function fixture(run) {
  const directory = await mkdtemp(path.join(tmpdir(), 'omnimind-skills-'));
  try { await run(directory, createSkillLibrary({ root: path.join(directory, 'skills') })); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
const data = value => Buffer.from(value).toString('base64');

test('file management persists bytes across restart and existing Agent source reads current files', async () => fixture(async (directory, library) => {
  assert.equal(defaultSkillRoot(directory), path.join(directory, '.omnimind-ops', 'skills'));
  const skill = await library.handle('skill_library_create', { name: 'Chrome 运维', description: '检查服务' });
  assert.equal(skill.origin, 'local');
  assert.equal(skill.entries[0].path, 'SKILL.md');
  const binary = Buffer.from([0, 255, 128, 1, 65]);
  await library.handle('skill_library_mkdir', { id: skill.id, path: 'assets' });
  await library.handle('skill_library_write', { id: skill.id, path: 'assets/probe.bin', data: data(binary) });
  await library.handle('skill_library_mkdir', { id: skill.id, path: 'references' });
  await library.handle('skill_library_mkdir', { id: skill.id, path: 'references/empty' });
  const next = createSkillLibrary({ root: path.join(directory, 'skills') });
  assert.equal((await next.handle('skill_library_list'))[0].id, skill.id);
  assert.equal((await next.handle('skill_library_read', { id: skill.id, path: 'assets/probe.bin' })).data, data(binary));
  await next.handle('skill_library_rename', { id: skill.id, path: 'assets', to: 'assets-v2' });
  assert.equal((await next.handle('skill_library_read', { id: skill.id, path: 'assets-v2/probe.bin' })).data, data(binary));
  await next.handle('skill_library_remove', { id: skill.id, path: 'references' });
  assert.ok(!(await next.handle('skill_library_get', { id: skill.id })).entries.some(entry => entry.path.startsWith('references')));
  const resources = createResources({ homeDir: directory, skillsDir: path.join(directory, 'skills') });
  const { agents, resources: catalog } = await resources.handle('agents_load');
  assert.ok(catalog.skills.some(item => item.id === skill.id));
  await resources.handle('agent_save', { id: agents[0].id, configuration: { ...agents[0].configuration, skillIds: [skill.id] } });
  await resources.handle('skill_library_write', { id: skill.id, path: 'SKILL.md', data: data('---\nname: Chrome 运维\n---\nUpdated instruction'), replace: true });
  assert.match(await resources.handle('agent_instructions', { id: agents[0].id }), /Updated instruction/u);
  assert.match((await resources.handle('skills_list'))[0].files[0].content, /Updated instruction/u);
  assert.ok((await readFile(path.join(directory, 'skills', skill.id, 'SKILL.md'), 'utf8')).includes('Updated instruction'));
}));

test('conflicts, traversal, symbolic links and failed writes preserve prior files', async () => fixture(async (directory, library) => {
  const { id } = await library.handle('skill_library_create', { name: 'Safe' });
  await library.handle('skill_library_write', { id, path: 'Notes.txt', data: data('original') });
  await assert.rejects(library.handle('skill_library_write', { id, path: 'Notes.txt', data: data('overwrite') }), { kind: 'conflict' });
  await assert.rejects(library.handle('skill_library_write', { id, path: 'notes.txt', data: data('overwrite'), replace: true }), { kind: 'conflict' });
  for (const unsafe of ['../outside', '/absolute', 'a/../b', 'a\\b', 'CON.txt', 'x:', 'a./b']) await assert.rejects(library.handle('skill_library_write', { id, path: unsafe, data: data('bad') }));
  await assert.rejects(library.handle('skill_library_write', { id, path: 'new/nested.txt', data: data('valid bytes') }), { kind: 'file-unavailable' });
  assert.ok(!(await readdir(path.join(directory, 'skills', id))).includes('new'));
  const outside = path.join(directory, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'secret'), 'unchanged');
  await symlink(outside, path.join(directory, 'skills', id, 'link'));
  await assert.rejects(library.handle('skill_library_write', { id, path: 'link/secret', data: data('bad'), replace: true }));
  await assert.rejects(library.handle('skill_library_read', { id, path: 'link/secret' }));
  assert.equal(await readFile(path.join(outside, 'secret'), 'utf8'), 'unchanged');
  assert.equal((await library.handle('skill_library_read', { id, path: 'Notes.txt' })).data, data('original'));
}));

test('official release versions stay read-only; local copies cannot change the cached version', async () => fixture(async (directory, library) => {
  const contentId = 'a'.repeat(64), skillId = `official/browser/${contentId}`;
  const release = path.join(directory, 'skills', 'releases', 'browser', contentId);
  await mkdir(release, { recursive: true });
  await writeFile(path.join(release, 'SKILL.md'), '---\nname: Official\n---\nFrozen');
  await writeFile(path.join(path.dirname(release), 'tags.json'), JSON.stringify({ 'v.1.0.0': contentId }));
  const official = await library.handle('skill_library_get', { id: skillId });
  assert.equal(official.readOnly, true);
  assert.equal(official.version, 'v.1.0.0');
  for (const method of ['skill_library_write', 'skill_library_mkdir', 'skill_library_remove', 'skill_library_rename', 'skill_library_delete']) await assert.rejects(library.handle(method, { id: skillId, path: 'SKILL.md', to: 'OTHER.md', data: data('Changed'), replace: true }), { kind: 'read-only' });
  const copied = await library.handle('skill_library_copy', { id: skillId, name: 'My copy' });
  assert.equal(copied.name, 'My copy');
  assert.equal(copied.origin, 'local');
  assert.equal(copied.version, undefined);
  await library.handle('skill_library_write', { id: copied.id, path: 'SKILL.md', data: data('Local edit'), replace: true });
  assert.match(await readFile(path.join(release, 'SKILL.md'), 'utf8'), /Frozen/u);
  await library.handle('skill_library_delete', { id: copied.id });
  assert.equal((await library.handle('skill_library_list')).length, 1);
}));

test('copy preserves an incomplete draft and stale upload directories are not recreated', async () => fixture(async (directory, library) => {
  const original = await library.handle('skill_library_create', { name: 'Draft' });
  await library.handle('skill_library_remove', { id: original.id, path: 'SKILL.md' });
  await library.handle('skill_library_mkdir', { id: original.id, path: 'assets' });
  await library.handle('skill_library_write', { id: original.id, path: 'assets/a.txt', data: data('reference') });
  const copy = await library.handle('skill_library_copy', { id: original.id, name: 'Incomplete copy' });
  assert.deepEqual(copy.entries.map(entry => entry.path), ['assets', 'assets/a.txt']);
  await library.handle('skill_library_remove', { id: original.id, path: 'assets' });
  await assert.rejects(library.handle('skill_library_write', { id: original.id, path: 'assets/new.txt', data: data('new') }), { kind: 'file-unavailable' });
  assert.deepEqual((await library.handle('skill_library_get', { id: original.id })).entries, []);
  await library.handle('skill_library_delete', { id: copy.id });
  assert.ok(!(await readdir(path.join(directory, 'skills', '.metadata'))).includes(`${copy.id.split('/')[1]}.json`));
}));
