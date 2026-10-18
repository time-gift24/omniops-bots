import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { preparationPlan, runtimeSourceFiles, verifyNodeArchive } from './prepare.mjs';

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

test('sidecar packaging includes root TypeScript modules and excludes tests, credentials and state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omniops-bots-staging-'));
  try {
    for (const name of ['main.mjs', 'langgraph.ts', 'mcp.ts', 'assembly.ts', 'run-store.ts', 'runtime.test.mjs', 'assembly.test.ts', 'test.mjs', 'tsconfig.json', 'model.env', 'state.sqlite', 'dev-runtime-bridge.mjs']) {
      await writeFile(join(directory, name), 'fixture');
    }
    await mkdir(join(directory, 'tests'));
    await writeFile(join(directory, 'tests', 'model-fixture.mjs'), 'fixture');
    if (process.platform !== 'win32') await symlink(join(directory, 'model.env'), join(directory, 'secret.ts'));
    assert.deepEqual(await runtimeSourceFiles(directory), ['assembly.ts', 'langgraph.ts', 'main.mjs', 'mcp.ts', 'run-store.ts']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
