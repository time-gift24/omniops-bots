import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { preparationPlan, verifyNodeArchive } from './prepare.mjs';

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
