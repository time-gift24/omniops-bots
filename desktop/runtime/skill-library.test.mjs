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
  await resources.handle('skill_library_write', { id: skill.id, path: 'SKILL.md', data: data('---\nname: Chrome 运维\ndescription: 检查服务\n---\nUpdated instruction'), replace: true });
  assert.match(await resources.handle('agent_instructions', { id: agents[0].id }), /Updated instruction/u);
  assert.match((await resources.handle('skills_list'))[0].files[0].content, /Updated instruction/u);
  assert.ok((await readFile(path.join(directory, 'skills', skill.id, 'SKILL.md'), 'utf8')).includes('Updated instruction'));
}));

test('create commits the edited initial text and rejects invalid bytes without a new package', async () => fixture(async (directory, library) => {
  const content = '---\nname: 初始正文\ndescription: 草稿\n---\n\n# 用户编辑\n精确保存。\n';
  const skill = await library.handle('skill_library_create', { name: '初始正文', content });
  assert.equal(await readFile(path.join(directory, 'skills', skill.id, 'SKILL.md'), 'utf8'), content);
  await assert.rejects(library.handle('skill_library_create', { name: '过大正文', content: '文'.repeat(Math.floor(20 * 1024 * 1024 / 3) + 1) }), { kind: 'resource-limit' });
  await assert.rejects(library.handle('skill_library_create', { name: '错误正文', content: {} }), { kind: 'invalid-request' });
  assert.deepEqual((await library.handle('skill_library_list')).map(value => value.id), [skill.id]);
  assert.deepEqual(await readdir(path.join(directory, 'skills', 'local')), [skill.id.split('/')[1]]);
  const empty = await library.handle('skill_library_create', { name: '空正文', content: '' });
  assert.equal(await readFile(path.join(directory, 'skills', empty.id, 'SKILL.md'), 'utf8'), '');
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


test('saving Skill frontmatter updates durable metadata and invalid edits preserve the saved version', async () => fixture(async (directory, library) => {
  const { id } = await library.handle('skill_library_create', { name: 'Old name', description: 'Old description' });
  const content = "---\nname: '新名称'\ndescription: >-\n  新说明\ncustom: true\n---\n\n# 保留原文\n";
  const saved = await library.handle('skill_library_write', { id, path: 'SKILL.md', data: data(content), replace: true });
  assert.equal(saved.name, '新名称');
  assert.equal(saved.description, '新说明');
  const reopened = createSkillLibrary({ root: path.join(directory, 'skills') });
  assert.equal((await reopened.handle('skill_library_list'))[0].name, '新名称');
  assert.equal((await reopened.handle('skill_library_get', { id })).description, '新说明');
  for (const invalid of ['---\nname: missing-description\n---\n', '---\nname: a\nname: b\ndescription: text\n---\n']) await assert.rejects(library.handle('skill_library_write', { id, path: 'SKILL.md', data: data(invalid), replace: true }), { kind: 'invalid-request' });
  assert.equal((await library.handle('skill_library_read', { id, path: 'SKILL.md' })).data, data(content));
  assert.equal((await library.handle('skill_library_get', { id })).name, '新名称');
}));


test('create publishes the full draft package once and rejects invalid entries before writing', async () => fixture(async (directory, library) => {
  const entries = [
    { path: 'reference/notes.md', kind: 'file', content: '完整草稿\n' },
    { path: 'reference/empty', kind: 'folder' },
    { path: 'scripts', kind: 'folder' },
  ];
  const created = await library.handle('skill_library_create', { name: '完整草稿', content: '入口', entries });
  const reopened = createSkillLibrary({ root: path.join(directory, 'skills') });
  assert.equal((await reopened.handle('skill_library_read', { id: created.id, path: 'reference/notes.md' })).data, data('完整草稿\n'));
  assert.deepEqual(created.entries.map(entry => [entry.path, entry.kind]).sort(), [['SKILL.md', 'file'], ['reference', 'folder'], ['reference/notes.md', 'file'], ['reference/empty', 'folder'], ['scripts', 'folder']].sort());
  for (const invalid of [
    [{ path: 'skill.md', kind: 'file', content: '重复入口' }],
    [{ path: 'docs', kind: 'folder' }, { path: 'DOCS', kind: 'folder' }],
    [{ path: 'docs', kind: 'file', content: '文件' }, { path: 'docs/a.md', kind: 'file', content: '嵌套' }],
    [{ path: 'Docs/a.md', kind: 'file', content: '文件' }, { path: 'docs/b.md', kind: 'file', content: '大小写冲突' }],
    [{ path: '../outside', kind: 'folder' }],
    [{ path: 'docs', kind: 'folder', content: '意外内容' }],
    [{ path: 'docs/a.md', kind: 'file', content: {} }],
    [{ path: 'docs', kind: 'other' }],
    null,
  ]) await assert.rejects(library.handle('skill_library_create', { name: '非法草稿', entries: invalid }));
  await assert.rejects(library.handle('skill_library_create', { name: '文件超限', entries: [{ path: 'large.md', kind: 'file', content: 'x'.repeat(20 * 1024 * 1024 + 1) }] }), { kind: 'resource-limit' });
  await assert.rejects(library.handle('skill_library_create', { name: '目录超限', entries: Array.from({ length: 1000 }, (_, index) => ({ path: `folder-${index}`, kind: 'folder' })) }), { kind: 'resource-limit' });
  assert.deepEqual((await reopened.handle('skill_library_list')).map(skill => skill.id), [created.id]);
  assert.deepEqual(await readdir(path.join(directory, 'skills', 'local')), [created.id.split('/')[1]]);
}));

test('a failed package creation cleans hidden staging files and preserves other metadata', async () => fixture(async (directory, library) => {
  const root = path.join(directory, 'skills');
  await mkdir(path.join(root, 'local'), { recursive: true });
  await writeFile(path.join(root, '.metadata'), 'existing metadata blocker');
  await assert.rejects(library.handle('skill_library_create', { name: '保存失败', entries: [{ path: 'reference/notes.md', kind: 'file', content: '草稿' }, { path: 'empty', kind: 'folder' }] }));
  assert.deepEqual(await readdir(path.join(root, 'local')), []);
  assert.deepEqual(await library.handle('skill_library_list'), []);
  assert.equal(await readFile(path.join(root, '.metadata'), 'utf8'), 'existing metadata blocker');
}));
