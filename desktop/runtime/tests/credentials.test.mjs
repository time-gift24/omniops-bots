import assert from 'node:assert/strict';
import test from 'node:test';
import { createCredentialClient } from '../credentials.mjs';
import { RuntimeError, safeError } from '../errors.mjs';

const reference = 'b44da25d-0d6f-4a93-89e4-e2b0fb29974a';

test('credential RPC keeps secrets confined to set requests and get replies', async () => {
  const messages = [];
  const client = createCredentialClient({ send: message => messages.push(message) });
  assert.equal(client.receive({ event: 'ready' }), false);
  assert.equal(client.receive({ event: 'credential_reply', requestId: 123, result: 'UNKNOWN_SECRET' }), true);
  const set = client.set(reference, 'FIXTURE_SECRET');
  assert.deepEqual(messages[0], { event: 'credential_request', requestId: 1, operation: 'set', reference, secret: 'FIXTURE_SECRET' });
  client.receive({ event: 'credential_reply', requestId: 1, result: null });
  assert.equal(await set, null);
  const get = client.get(reference);
  assert.equal(messages[1].secret, undefined);
  client.receive({ event: 'credential_reply', requestId: 2, result: 'FIXTURE_SECRET' });
  assert.equal(await get, 'FIXTURE_SECRET');
  const missing = client.get(reference);
  client.receive({ event: 'credential_reply', requestId: 3, result: null });
  assert.equal(await missing, null);
  const remove = client.delete(reference);
  assert.equal(messages[3].secret, undefined);
  client.receive({ event: 'credential_reply', requestId: 4, result: null });
  assert.equal(await remove, null);
  const failed = client.get(reference);
  client.receive({ event: 'credential_reply', requestId: 5, error: { kind: 'credentials', message: 'PRIVATE_SECRET_SOURCE' } });
  await assert.rejects(failed, error => error instanceof RuntimeError && error.kind === 'credentials' && !JSON.stringify(safeError(error)).includes('PRIVATE_SECRET'));
  const malformed = client.set(reference, 'FIXTURE_SECRET');
  client.receive({ event: 'credential_reply', requestId: 6, result: 'PRIVATE_SECRET_SOURCE' });
  await assert.rejects(malformed, /系统凭据响应无效/);
  client.close();
});

test('credential RPC validates references, key sizes, backpressure and lifecycle', async () => {
  let sends = 0;
  const client = createCredentialClient({ send: () => sends++ });
  for (const invalid of [null, '', '../another-app', reference.toUpperCase(), '00000000-0000-0000-0000-000000000000']) {
    await assert.rejects(client.get(invalid), /凭据引用无效/);
  }
  for (const invalid of [null, '', 'private\nkey', 'a'.repeat(2561), '中'.repeat(854)]) {
    await assert.rejects(client.set(reference, invalid), /API Key 无效/);
  }
  assert.equal(sends, 0);
  const pending = Array.from({ length: 64 }, () => client.get(reference).catch(error => error));
  await assert.rejects(client.get(reference), /请求过多/);
  client.close();
  assert.equal((await Promise.all(pending)).every(error => error.kind === 'credentials' && /已关闭/.test(error.message)), true);
  await assert.rejects(client.get(reference), /已关闭/);
  const timeout = createCredentialClient({ send: () => {}, timeoutMs: 5 });
  await assert.rejects(timeout.get(reference), /操作超时/);
  timeout.close();
  const broken = createCredentialClient({ send: () => { throw new Error('PRIVATE_SECRET'); } });
  await assert.rejects(broken.set(reference, 'FIXTURE_SECRET'), error => !error.message.includes('PRIVATE_SECRET'));
  broken.close();
  const asyncBroken = createCredentialClient({ send: async () => { throw new Error('PRIVATE_SECRET'); } });
  await assert.rejects(asyncBroken.get(reference), /连接不可用/);
  asyncBroken.close();
});
