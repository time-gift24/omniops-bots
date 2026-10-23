import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { chmod, lstat, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

const receiptUri = 'urn:omniops:a2a:extension:delivery-receipt:v1';
const state = task => task.status.state;
const output = task => task.artifacts[0].parts[0].data;
async function until(check) {
  for (let attempt = 0; attempt < 400; attempt++) { const value = await check(); if (value) return value; await delay(20); }
  throw new Error('External A2A validation did not settle');
}
async function writable(directory) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) return;
  await chmod(directory, 0o700);
  for (const name of await readdir(directory)) await writable(join(directory, name));
}
function launch(name, args) {
  const process = fork(new URL(`./fixtures/${name}`, import.meta.url), args, { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const pending = new Map(), ready = Promise.withResolvers(), exited = Promise.withResolvers();
  let sequence = 0, diagnostics = '';
  process.stdout.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-64_000); });
  process.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-64_000); });
  process.on('message', message => {
    if (message.ready) { ready.resolve(message); return; }
    pending.get(message.id)?.resolve(message);
  });
  process.once('error', error => ready.reject(error));
  process.once('exit', (code, signal) => {
    const error = new Error(`${name} exited (${code ?? signal}): ${diagnostics}`);
    ready.reject(error);
    for (const request of pending.values()) request.reject(error);
    exited.resolve();
  });
  return { process, ready: ready.promise, exited: exited.promise, get diagnostics() { return diagnostics; },
    async request(command) {
      const id = ++sequence, result = Promise.withResolvers();
      pending.set(id, result);
      const timer = setTimeout(() => result.reject(new Error(`Timed out: ${JSON.stringify(command)}\n${diagnostics}`)), 20_000);
      try { process.send({ id, command }); return await result.promise; }
      finally { clearTimeout(timer); pending.delete(id); }
    },
    async stop(signal = 'SIGKILL') { if (process.exitCode === null && process.signalCode === null) process.kill(signal); await exited.promise; },
  };
}

test('independent SDK Agent executes, cancels, disconnects, confirms and recovers durable Tasks through standard A2A', { timeout: 90_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'omniops-a2a-external-'));
  const peers = [];
  t.after(async () => { await Promise.all(peers.map(peer => peer.stop())); await writable(directory); await rm(directory, { recursive: true, force: true }); });
  let harness, agent;
  async function open() {
    harness = launch('a2a-harness.mjs', [directory]); peers.push(harness);
    const { url } = await harness.ready;
    agent = launch('a2a-agent.mjs', [url]); peers.push(agent); await agent.ready;
  }
  const call = async command => { const result = await agent.request(command); assert.equal(result.error, undefined, JSON.stringify(result.error)); return result.value; };
  const stats = async () => { const result = await harness.request('stats'); assert.equal(result.error, undefined); return result.value; };
  const settled = async taskId => until(async () => {
    const value = await call({ operation: 'get', taskId });
    return ['TASK_STATE_COMPLETED', 'TASK_STATE_CANCELED', 'TASK_STATE_FAILED', 'TASK_STATE_REJECTED'].includes(state(value.task)) ? value : null;
  });
  const confirmStreamResult = async (event, label) => {
    const resultSha256 = event.metadata?.[receiptUri]?.resultSha256;
    assert.match(resultSha256 ?? '', /^[a-f0-9]{64}$/u, 'The final stream event publishes its durable receipt digest');
    const { task } = await call({ operation: 'get', taskId: event.taskId });
    assert.equal(resultSha256, task.metadata[receiptUri].resultSha256);
    const receipt = await call({ operation: 'receipt', id: label, taskId: task.id, resultSha256, receivedAt: '2026-10-23T12:00:00Z' });
    assert.deepEqual(receipt.result, { taskId: task.id, resultSha256 });
    assert.equal(receipt.responseExtensions, receiptUri);
  };
  await open();
  assert.notEqual(agent.process.pid, harness.process.pid);
  const card = await call({ operation: 'card' });
  assert.equal(card.supportedInterfaces[0].protocolBinding, 'JSONRPC');
  assert.equal(card.supportedInterfaces[0].protocolVersion, '1.0');
  const privateFailure = await agent.request({ operation: 'open-stream', streamId: 'private-failure', messageId: 'private-failure', input: {}, credential: 'Bearer fixture-sensitive' });
  assert.equal(privateFailure.error.reason, 'INTERNAL_ERROR');
  assert.equal(JSON.stringify(privateFailure).includes('synthetic-private-dependency-body'), false);

  const completed = [];
  for (const value of [0, false, null]) {
    const result = await call({ operation: 'send', messageId: `scalar-${value}`, input: { case: `scalar-${value}`, value } });
    assert.equal(state(result.task), 'TASK_STATE_COMPLETED');
    const stored = await call({ operation: 'get', taskId: result.task.id });
    if (value === null) {
      // SDK 1.3.0 Part.fromJSON drops null oneofs; the standard wire must retain it.
      assert.equal(result.wire.result.task.artifacts[0].parts[0].data, null);
      assert.equal(stored.wire.result.artifacts[0].parts[0].data, null);
      assert.equal(Object.hasOwn(stored.task.artifacts[0].parts[0], 'data'), false);
    } else { assert.equal(output(result.task), value); assert.equal(output(stored.task), value); }
    completed.push(stored.task);
  }

  const streaming = await call({ operation: 'stream', messageId: 'streaming', input: { case: 'streaming', value: { done: true }, delay: 50 } });
  assert.ok(streaming[0].task);
  assert.ok(streaming.some(event => event.artifactUpdate?.artifact.parts[0].data.done === true));
  assert.equal(streaming.at(-1).statusUpdate.status.state, 'TASK_STATE_COMPLETED');
  await confirmStreamResult(streaming.at(-1).statusUpdate, 'stream-receipt');
  const immediate = await call({ operation: 'send', messageId: 'subscribed', input: { case: 'subscribed', value: ['ok'], delay: 500 }, immediate: true });
  assert.ok(['TASK_STATE_SUBMITTED', 'TASK_STATE_WORKING'].includes(state(immediate.task)));
  const initial = await call({ operation: 'open-stream', streamId: 'subscription', taskId: immediate.task.id });
  assert.equal(initial.task.id, immediate.task.id);
  const updates = await call({ operation: 'read-stream', streamId: 'subscription' });
  assert.equal(updates.at(-1).statusUpdate.status.state, 'TASK_STATE_COMPLETED');
  await confirmStreamResult(updates.at(-1).statusUpdate, 'subscription-receipt');

  const invalidOutput = await call({ operation: 'send', messageId: 'invalid-output', input: { case: 'invalid-output' } });
  assert.equal(state(invalidOutput.task), 'TASK_STATE_FAILED');
  assert.equal(invalidOutput.task.status.message.parts.find(part => part.data)?.data.reasonCode, 'invalid-output');
  assert.deepEqual(invalidOutput.task.artifacts ?? [], []);
  assert.ok((await stats()).records.some(record => record.error?.kind === 'invalid-output'));

  const duplicate = { operation: 'send', messageId: 'deduplicated', input: { case: 'deduplicated', value: 17, delay: 200 }, immediate: true };
  const [first, second] = await Promise.all([call(duplicate), call(duplicate)]);
  assert.equal(first.task.id, second.task.id);
  await settled(first.task.id);
  assert.equal((await stats()).events.filter(event => event.event === 'start' && event.case === 'deduplicated').length, 1);
  assert.equal((await agent.request({ ...duplicate, input: { case: 'different' } })).error.reason, 'INVALID_PARAMS');
  assert.equal((await agent.request({ operation: 'get', taskId: first.task.id, credential: 'Bearer fixture-other' })).error.reason, 'TASK_NOT_FOUND');
  assert.equal((await agent.request({ operation: 'get', taskId: first.task.id, tenant: 'other' })).error.reason, 'INVALID_PARAMS');
  const unauthenticated = (await agent.request({ operation: 'get', taskId: first.task.id, credential: 'wrong' })).error;
  assert.equal(unauthenticated.data?.[0].metadata.category, 'authentication', JSON.stringify(unauthenticated));
  assert.equal((await agent.request({ operation: 'get', taskId: first.task.id, extensions: false })).error.reason, 'EXTENSION_SUPPORT_REQUIRED');
  assert.equal((await agent.request({ operation: 'unsupported-card' })).error.reason, 'UNSUPPORTED_OPERATION');
  assert.equal((await agent.request({ operation: 'unsupported-push', taskId: first.task.id })).error.reason, 'PUSH_NOTIFICATION_NOT_SUPPORTED');
  assert.equal((await agent.request({ operation: 'wrong-version', taskId: first.task.id })).error.reason, 'VERSION_NOT_SUPPORTED');
  const listed = await call({ operation: 'list', params: { pageSize: 100, includeArtifacts: true } });
  assert.ok(listed.tasks.some(task => task.id === first.task.id));
  const confirmed = completed[0];
  const receipt = { operation: 'receipt', id: 'receipt-first', taskId: confirmed.id, resultSha256: confirmed.metadata[receiptUri].resultSha256, receivedAt: '2026-10-22T12:00:00Z' };
  const receiptFirst = await call(receipt);
  assert.deepEqual(receiptFirst.result, { taskId: confirmed.id, resultSha256: receipt.resultSha256 });
  assert.equal(receiptFirst.responseExtensions, receiptUri);
  assert.deepEqual((await call({ ...receipt, id: 'receipt-repeat', receivedAt: '2026-10-23T12:00:00Z' })).result, receiptFirst.result);
  assert.equal((await call({ ...receipt, id: 'receipt-wrong', resultSha256: '0'.repeat(64) })).error.code, -32602);

  const capacityRequests = Array.from({ length: 4 }, (_, index) => ({ operation: 'send', messageId: `capacity-${index}`, input: { case: `capacity-${index}`, hold: true }, immediate: true }));
  const capacityTasks = await Promise.all(capacityRequests.map(call));
  await until(async () => (await stats()).events.filter(event => event.event === 'start' && event.case.startsWith('capacity-')).length === 4);
  const busy = await call({ operation: 'send', messageId: 'capacity-busy', input: { case: 'must-not-start' }, immediate: true });
  assert.equal(state(busy.task), 'TASK_STATE_REJECTED');
  assert.match(JSON.stringify(busy.task.status), /busy/);
  assert.equal((await call(capacityRequests[0])).task.id, capacityTasks[0].task.id, 'Duplicate lookup precedes full capacity');
  assert.equal((await stats()).events.some(event => event.case === 'must-not-start'), false);
  await Promise.all(capacityTasks.map(async ({ task }) => {
    assert.equal(state(await call({ operation: 'cancel', taskId: task.id })), 'TASK_STATE_WORKING');
    assert.equal(state((await settled(task.id)).task), 'TASK_STATE_CANCELED');
  }));

  const cancel = await call({ operation: 'send', messageId: 'cancel', input: { case: 'cancel' }, immediate: true });
  await until(async () => (await stats()).events.some(event => event.case === 'cancel' && event.event === 'start'));
  assert.equal(state(await call({ operation: 'cancel', taskId: cancel.task.id })), 'TASK_STATE_WORKING');
  assert.equal(state((await call({ operation: 'get', taskId: cancel.task.id })).task), 'TASK_STATE_WORKING');
  assert.equal(state((await settled(cancel.task.id)).task), 'TASK_STATE_CANCELED');
  const afterCancel = await stats();
  assert.ok(afterCancel.events.some(event => event.case === 'cancel' && event.event === 'drained'));
  assert.ok(afterCancel.records.some(record => record.status === 'cancelled'));
  assert.equal((await agent.request({ operation: 'cancel', taskId: cancel.task.id })).error.reason, 'TASK_NOT_CANCELABLE');

  const detached = await call({ operation: 'open-stream', streamId: 'detached', messageId: 'detached', input: { case: 'detached', value: { survived: true }, delay: 300 } });
  await call({ operation: 'disconnect-stream', streamId: 'detached' });
  assert.deepEqual(output((await settled(detached.task.id)).task), { survived: true });

  const interrupted = await call({ operation: 'send', messageId: 'interrupted', input: { case: 'interrupted' }, immediate: true });
  await until(async () => (await stats()).events.some(event => event.case === 'interrupted' && event.event === 'start'));
  await harness.stop('SIGKILL'); await agent.stop();
  await open();
  const retained = await call({ operation: 'get', taskId: confirmed.id });
  assert.deepEqual(retained.task, confirmed);
  assert.deepEqual((await call({ operation: 'get', taskId: invalidOutput.task.id })).task, invalidOutput.task);
  assert.deepEqual((await call({ ...receipt, id: 'receipt-after-restart' })).result, receiptFirst.result);
  const recovered = await call({ operation: 'get', taskId: interrupted.task.id });
  assert.equal(state(recovered.task), 'TASK_STATE_FAILED');
  assert.match(JSON.stringify(recovered.task.status), /interrupted-unknown/);
  const recoveryMessage = recovered.task.status.message;
  assert.equal(recoveryMessage.taskId, recovered.task.id);
  assert.equal(recoveryMessage.contextId, recovered.task.contextId);
  assert.ok(recoveryMessage.parts.some(part => typeof part.text === 'string' && part.text.length > 0));
  assert.equal(recoveryMessage.parts.find(part => part.data)?.data.reasonCode, 'interrupted-unknown');
  assert.deepEqual(recovered.task.history.at(-1), recoveryMessage);
  const retried = await call({ operation: 'send', messageId: 'interrupted', input: { case: 'interrupted' }, immediate: true });
  assert.equal(retried.task.id, interrupted.task.id);
  assert.equal(state(retried.task), 'TASK_STATE_FAILED');
  assert.deepEqual((await stats()).events, [], 'Restart and duplicate delivery must not invoke the model');
  assert.deepEqual((await harness.request('close')).value, { closed: true });
  await harness.exited;
  assert.ok(peers.every(peer => !peer.diagnostics.includes('synthetic-private-dependency-body')), 'SDK host diagnostics never expose a raw dependency cause');
});
