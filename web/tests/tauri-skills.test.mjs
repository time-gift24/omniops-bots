import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { createResources } from '../../desktop/runtime/resources.mjs';

test('desktop Skill adapter preserves binary bytes, readable metadata and conflict errors through RPC', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'omnimind-tauri-skills-'));
  const server = await createServer({ root: fileURLToPath(new URL('../', import.meta.url)), configFile: false, resolve: { alias: { '@': fileURLToPath(new URL('../src', import.meta.url)) } }, server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
  t.after(async () => { await server.close(); await rm(root, { recursive: true, force: true }); });
  const { createTauriSkillLibrary } = await server.ssrLoadModule('/src/adapters/tauri/skills.ts');
  const resources = createResources({ homeDir: root });
  // Simulate the plain JSON RPC envelope, not direct Error object sharing.
  const request = async (method, params) => {
    try { return JSON.parse(JSON.stringify(await resources.handle(method, params))); }
    catch (error) { throw new Error(error.message, { cause: { kind: error.kind, message: error.message } }); }
  };
  const library = await createTauriSkillLibrary(request);
  assert.equal(library.storage.kind, 'desktop');
  assert.equal(library.storage.root, await realpath(path.join(root, '.omnimind-ops', 'skills')));
  const skill = await library.create({ name: 'Library test' });
  const updatedContent = '---\nname: "从 Markdown 改名"\ndescription: "同步到桌面目录"\n---\n\n# 精确保存\n';
  const updated = await library.writeFile(skill.id, 'SKILL.md', new Blob([updatedContent]), { replace: true });
  assert.equal(updated.name, '从 Markdown 改名');
  assert.equal(updated.description, '同步到桌面目录');
  assert.equal((await library.list())[0].name, updated.name);
  assert.equal(await (await library.readFile(skill.id, 'SKILL.md')).text(), updatedContent);
  const bytes = new Uint8Array([0, 1, 128, 254, 255]);
  await library.createDirectory(skill.id, 'assets');
  await library.writeFile(skill.id, 'assets/image.png', new Blob([bytes], { type: 'image/png' }));
  assert.deepEqual(new Uint8Array(await (await library.readFile(skill.id, 'assets/image.png')).arrayBuffer()), bytes);
  assert.ok((await library.get(skill.id)).entries.some(entry => entry.path === 'assets' && entry.kind === 'folder'));
  await assert.rejects(library.writeFile(skill.id, 'assets/image.png', new Blob(['bad'])), { code: 'conflict' });
  await assert.rejects(library.writeFile(skill.id, '../outside', new Blob(['bad'])), { code: 'path-invalid' });
  await library.rename(skill.id, 'assets', 'references');
  await library.remove(skill.id, 'references');
  assert.deepEqual((await library.get(skill.id)).entries.map(entry => entry.path), ['SKILL.md']);
  await library.deleteSkill(skill.id);
  assert.equal((await library.list()).length, 0);
});
