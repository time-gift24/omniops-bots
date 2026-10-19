import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { preparationPlan, runtimeSourceFiles, stageRuntimeSources, verifyNodeArchive, verifySqliteAddon } from './prepare.mjs';

test('sidecar preparation supports only matching native targets and the Windows cross build', () => {
  assert.equal(preparationPlan('aarch64-apple-darwin').cross, false);
  assert.equal(preparationPlan('aarch64-apple-darwin', 'x86_64-pc-windows-msvc').cross, true);
  assert.throws(() => preparationPlan('x86_64-pc-windows-msvc', 'aarch64-apple-darwin'));
  assert.throws(() => preparationPlan('x86_64-unknown-linux-gnu'));
});

test('Node archive must match the checksum for the exact requested filename', () => {
  const bytes = Buffer.from('fixture');
  const hash = createHash('sha256').update(bytes).digest('hex');
  const checksums = `${hash}  node.zip\n${'0'.repeat(64)}  other.zip`;
  assert.equal(verifyNodeArchive(bytes, checksums, 'node.zip'), hash);
  assert.throws(() => verifyNodeArchive(Buffer.from('changed'), checksums, 'node.zip'));
  assert.throws(() => verifyNodeArchive(bytes, checksums, 'missing.zip'));
});

test('sidecar packaging recursively includes modules and excludes tests, credentials, state and symlinks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omniops-bots-staging-'));
  try {
    for (const name of ['main.mjs', 'langgraph.ts', 'mcp.ts', 'assembly.ts', 'run-store.ts', 'runtime.test.mjs', 'assembly.test.ts', 'test.mjs', 'tsconfig.json', 'model.env', 'state.sqlite', 'dev-runtime-bridge.mjs']) {
      await writeFile(join(directory, name), 'fixture');
    }
    await mkdir(join(directory, 'tests'));
    await writeFile(join(directory, 'tests', 'model-fixture.mjs'), 'fixture');
    for (const name of ['execution', 'graphs/browser', 'browser', '.private', 'node_modules/pkg', 'credentials', 'state', 'fixtures']) {
      await mkdir(join(directory, name), { recursive: true });
      await writeFile(join(directory, name, 'module.ts'), 'fixture');
    }
    await writeFile(join(directory, 'execution', 'hidden.test.mjs'), 'fixture');
    await writeFile(join(directory, 'browser', 'browser.mjs'), 'fixture');
    await writeFile(join(directory, 'browser', 'fixture.browser.mjs'), 'fixture');
    if (process.platform !== 'win32') await symlink(join(directory, 'model.env'), join(directory, 'secret.ts'));
    assert.deepEqual(await runtimeSourceFiles(directory), ['assembly.ts', join('browser', 'browser.mjs'), join('browser', 'module.ts'), join('execution', 'module.ts'), join('graphs', 'browser', 'module.ts'), 'langgraph.ts', 'main.mjs', 'mcp.ts', 'run-store.ts']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('staged nested TypeScript modules remain importable by the private Node runtime', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omniops-bots-import-'));
  try {
    const source = join(directory, 'source');
    const staged = join(directory, 'staged');
    await mkdir(join(source, 'execution'), { recursive: true });
    await mkdir(join(source, 'browser'));
    await writeFile(join(source, 'package.json'), '{"type":"module"}');
    await writeFile(join(source, 'package-lock.json'), '{}');
    await writeFile(join(source, 'execution', 'value.ts'), 'export const value: number = 42;');
    await writeFile(join(source, 'browser', 'browser.mjs'), "export const browser = 'production';");
    await writeFile(join(source, 'browser', 'safety.browser.mjs'), "throw new Error('Do not package browser tests');");
    await writeFile(join(source, 'main.mjs'), "export { value } from './execution/value.ts'; export { browser } from './browser/browser.mjs';");
    await stageRuntimeSources(source, staged);
    const entry = await import(pathToFileURL(join(staged, 'main.mjs')).href);
    assert.equal(entry.value, 42);
    assert.equal(entry.browser, 'production');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('SQLite native addon validation rejects wrong platform and CPU payloads', () => {
  const mac = Buffer.alloc(64);
  mac.writeUInt32LE(0xfeedfacf); mac.writeUInt32LE(0x0100000c, 4);
  assert.equal(verifySqliteAddon(mac, 'aarch64-apple-darwin'), 'arm64');
  assert.throws(() => verifySqliteAddon(mac, 'x86_64-pc-windows-msvc'));
  const windows = Buffer.alloc(128);
  windows.writeUInt16LE(0x5a4d); windows.writeUInt32LE(64, 60);
  windows.writeUInt32LE(0x4550, 64); windows.writeUInt16LE(0x8664, 68);
  assert.equal(verifySqliteAddon(windows, 'x86_64-pc-windows-msvc'), 'x64');
  windows.writeUInt16LE(0xaa64, 68);
  assert.throws(() => verifySqliteAddon(windows, 'x86_64-pc-windows-msvc'));
  assert.throws(() => verifySqliteAddon(Buffer.alloc(1), 'aarch64-apple-darwin'));
});
