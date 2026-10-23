import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { inspect } from 'node:util';
import { AgentCard, SendMessageRequest, ListTasksRequest } from '@a2a-js/sdk';
import { ServerCallContext } from '@a2a-js/sdk/server';
import { DatabaseTaskStore } from '@a2a-js/sdk/server/database';
import { RequestMalformedError } from '@a2a-js/sdk/errors';
import { createA2AService } from '../a2a/index.ts';
import { principalOwner, RECEIPT_EXTENSION } from '../a2a/store.ts';
import { ExecutionError } from '../execution/index.ts';

const principal = { organizationId: 'org', callerId: 'agent', installationId: 'installation' };
const owner = principalOwner(principal);
const card = AgentCard.fromJSON({ name: 'Failure fixture', version: '1',
  supportedInterfaces: [{ url: 'http://127.0.0.1/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0', tenant: 'fixed' }],
  defaultInputModes: ['application/json'], defaultOutputModes: ['application/json'],
  capabilities: { streaming: true, extensions: [{ uri: RECEIPT_EXTENSION, required: true }] },
});
function context(user = { isAuthenticated: true, userName: owner }, signal) {
  return new ServerCallContext({ requestedVersion: '1.0', requestedExtensions: [RECEIPT_EXTENSION], user,
    state: new Map([['omniops.principal', principal], ...(signal ? [['omniops.waitSignal', signal]] : [])]) });
}
const request = messageId => SendMessageRequest.fromJSON({ tenant: 'fixed', configuration: { returnImmediately: true },
  message: { messageId, role: 'ROLE_USER', parts: [{ data: {} }] } });

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'omniops-a2a-failures-'));
  const jobs = [];
  const runtime = { reserveRun() {
    const done = Promise.withResolvers();
    const job = { done, stopped: 0, fixed: false, started: false, released: false };
    jobs.push(job);
    options.onReserve?.(job);
    return {
      async execute() {
        job.started = true;
        await done.promise;
        job.fixed = true;
        return job.stopped ? { ok: false, error: new ExecutionError('cancelled') } : options.outcome ?? { ok: true, output: options.output ?? false };
      },
      requestStop() {
        if (job.fixed) return 'result-fixed';
        job.stopped++;
        options.onStop?.(job, jobs.indexOf(job));
        return 'requested';
      },
      release() { assert.ok(job.fixed || !job.started, 'started execution must drain before release'); job.released = true; },
    };
  } };
  const serviceOptions = { directory, runtime, limits: {
    maxRequestBytes: 16_000, maxTaskBytes: 32_000, maxJsonDepth: 20, maxWaiters: 2, maxSubscriptions: 2, ...options.limits,
  }, resolveEndpoint: options.resolveEndpoint ?? (async () => ({ agentId: 'fixture', contentId: 'a'.repeat(64), card })) };
  const service = await createA2AService(serviceOptions);
  t.after(async () => {
    for (const job of jobs) job.done.resolve();
    await service.close({ deadline: performance.now() + 1000 }).catch(() => {});
    // A timed-out close retains and completes its owned cleanup after real execution drains.
    await new Promise(resolve => setTimeout(resolve, 20));
    await rm(directory, { recursive: true, force: true });
  });
  async function handler(user, signal) { const c = context(user, signal); const h = await service.protocolFor(c, 'fixed'); c.setTenant('fixed'); return { h, c }; }
  async function get(id) { const { h, c } = await handler(); return h.getTask({ tenant: 'fixed', id }, c); }
  async function terminal(id) {
    for (let i = 0; i < 100; i++) {
      const task = await get(id);
      if ([3, 4, 5, 7].includes(task.status.state)) return task;
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.fail('accepted Task did not settle');
  }
  async function send(id, user) { const { h, c } = await handler(user); return h.sendMessage(request(id), c); }
  return { service, serviceOptions, jobs, handler, send, get, terminal };
}

test('SDK User getter implementations preserve owner identity through background execution', async t => {
  const f = await fixture(t);
  class User {
    get isAuthenticated() { return true; }
    get userName() { return owner; }
  }
  const task = await f.send('getter-user', new User());
  f.jobs[0].done.resolve();
  assert.equal((await f.terminal(task.id)).status.state, 3);
  assert.equal(f.jobs[0].released, true);
});

test('concurrent CancelTask latches one stop before asynchronous persistence', async t => {
  const f = await fixture(t);
  const task = await f.send('concurrent-cancel');
  const a = await f.handler(), b = await f.handler();
  const results = await Promise.all([
    a.h.cancelTask({ tenant: 'fixed', id: task.id }, a.c),
    b.h.cancelTask({ tenant: 'fixed', id: task.id }, b.c),
  ]);
  assert.equal(f.jobs[0].stopped, 1);
  assert.ok(results.every(result => result.status.state === 2));
  f.jobs[0].done.resolve();
  assert.equal((await f.terminal(task.id)).status.state, 5);
});

test('a cancellation that immediately drains still persists one valid frozen terminal', async t => {
  const f = await fixture(t, { onStop: job => job.done.resolve() });
  const task = await f.send('immediate-drain');
  const { h, c } = await f.handler();
  await h.cancelTask({ tenant: 'fixed', id: task.id }, c);
  assert.equal((await f.terminal(task.id)).status.state, 5);
  // A late stopping write must not poison unrelated future admissions.
  const next = await f.send('after-immediate-drain');
  f.jobs[1].done.resolve();
  assert.equal((await f.terminal(next.id)).status.state, 3);
});

test('expired valid shutdown deadline seals the entry and reports timeout even when idle', async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.close({ deadline: 0 }), { kind: 'timeout' });
  await assert.rejects(f.service.protocolFor(context(), 'fixed'), error => error.metadata.category === 'unavailable');
  await assert.rejects(f.service.close({ deadline: performance.now() + 5000 }), { kind: 'timeout' });
});

test('invalid business output settles FAILED and releases only after durable terminal', async t => {
  const f = await fixture(t, { output: new Date() });
  const task = await f.send('invalid-output');
  f.jobs[0].done.resolve();
  const final = await f.terminal(task.id);
  assert.equal(final.status.state, 4);
  assert.equal(final.status.message.parts[1].content.value.reasonCode, 'invalid-output');
  assert.equal(final.artifacts.length, 0);
  assert.equal(f.jobs[0].released, true);
});

test('one broken stop dependency does not skip other jobs or owned storage cleanup', async t => {
  const f = await fixture(t, { onStop(job, index) {
    if (index === 0) throw new Error('secret dependency body');
    job.done.resolve();
  } });
  await f.send('broken-stop');
  await f.send('healthy-stop');
  const closing = f.service.close({ deadline: performance.now() + 1000 });
  f.jobs[0].done.resolve();
  await assert.rejects(closing, error => error.kind === 'storage' && !error.message.includes('secret'));
  assert.deepEqual(f.jobs.map(job => job.stopped), [1, 1]);
  assert.ok(f.jobs.every(job => job.released));
  const reopened = await createA2AService(f.serviceOptions);
  await reopened.close({ deadline: performance.now() + 1000 });
});

test('close during runtime reservation rolls admission back and releases the unstarted reservation', async t => {
  let closing;
  const f = await fixture(t, { onReserve() { closing = f.service.close({ deadline: performance.now() + 1000 }); } });
  await assert.rejects(f.send('close-during-reserve'), error => error.metadata.category === 'unavailable');
  await closing;
  assert.equal(f.jobs[0].started, false);
  assert.equal(f.jobs[0].released, true);
  const reopened = await createA2AService(f.serviceOptions);
  const c = context();
  const h = await reopened.protocolFor(c, 'fixed');
  c.setTenant('fixed');
  const list = await h.listTasks(ListTasksRequest.fromJSON({ tenant: 'fixed', includeArtifacts: true }), c);
  assert.equal(list.totalSize, 0);
  await reopened.close({ deadline: performance.now() + 1000 });
});

test('a finite far-future shutdown deadline does not overflow the native timer limit', async t => {
  const f = await fixture(t);
  await f.service.close({ deadline: Number.MAX_VALUE });
});

test('construction and JSON boundaries reject malformed values with controlled errors', async t => {
  for (const directory of [undefined, null, 123, {}, 'relative']) {
    await assert.rejects(createA2AService({ directory }), { kind: 'invalid-request' });
  }
  await assert.rejects(createA2AService({ directory: '/tmp/unused-a2a-validation', runtime: { reserveRun() {} }, resolveEndpoint: async () => {}, limits: {} }, null), { kind: 'invalid-request' });
  const f = await fixture(t);
  for (const input of [{ text: '\ud800' }, { ['\udfff']: true }]) {
    const { h, c } = await f.handler();
    const p = request('invalid-unicode'); p.message.parts[0].content.value = input;
    await assert.rejects(h.sendMessage(p, c), { reason: 'INVALID_PARAMS' });
  }
  assert.equal(f.jobs.length, 0);
});

test('terminal persistence failure ends existing and later SDK subscriptions without stopping or leaking capacity', async t => {
  const f = await fixture(t, { limits: { maxSubscriptions: 1 } });
  const task = await f.send('failed-terminal');
  const original = DatabaseTaskStore.prototype.save;
  const save = t.mock.method(DatabaseTaskStore.prototype, 'save', async function(value, c) {
    if (value.id === task.id && value.status?.state === 3) throw new Error('private SQLite failure body');
    return original.call(this, value, c);
  });
  try {
    const { h: subscribed, c: sc } = await f.handler(undefined, AbortSignal.timeout(500));
    const existing = subscribed.resubscribe({ tenant: 'fixed', id: task.id }, sc);
    assert.equal((await existing.next()).value.payload.$case, 'task');
    const ended = assert.rejects(existing.next(), error => error.metadata?.category === 'storage');
    const { h, c } = await f.handler();
    const blocking = request('failed-terminal'); blocking.configuration.returnImmediately = false;
    const failed = assert.rejects(h.sendMessage(blocking, c), error => error.metadata?.category === 'storage');
    f.jobs[0].done.resolve();
    await failed; await ended;
    assert.equal((await f.get(task.id)).status.state, 2);
    assert.equal(f.jobs[0].released, false, 'Unsaved fixed results keep their runtime reservation');
    for (const method of ['resubscribe', 'sendMessageStream']) {
      const next = await f.handler(undefined, AbortSignal.timeout(500));
      const stream = method === 'resubscribe'
        ? next.h.resubscribe({ tenant: 'fixed', id: task.id }, next.c)
        : next.h.sendMessageStream(request('failed-terminal'), next.c);
      assert.equal((await stream.next()).value.payload.$case, 'task');
      await assert.rejects(stream.next(), error => error.metadata?.category === 'storage');
      await stream.return();
    }
    assert.equal(f.jobs[0].stopped, 0);
    await assert.rejects(f.send('after-storage-fault'), error => error.metadata?.category === 'storage');
  } finally { save.mock.restore(); }
});

test('CancelTask rechecks the durable terminal after a stale WORKING read races completion', async t => {
  const f = await fixture(t);
  const task = await f.send('cancel-completion-race');
  const { h, c } = await f.handler();
  const read = Promise.withResolvers(), release = Promise.withResolvers();
  const original = DatabaseTaskStore.prototype.load;
  let delayed = false;
  const load = t.mock.method(DatabaseTaskStore.prototype, 'load', async function(id, ctx) {
    const value = await original.call(this, id, ctx);
    if (ctx === c && !delayed && value?.status.state === 2) {
      delayed = true; read.resolve(); await release.promise;
    }
    return value;
  });
  try {
    const canceled = assert.rejects(h.cancelTask({ tenant: 'fixed', id: task.id }, c), { reason: 'TASK_NOT_CANCELABLE' });
    await read.promise;
    f.jobs[0].done.resolve();
    assert.equal((await f.terminal(task.id)).status.state, 3);
    release.resolve(); await canceled;
    assert.equal(f.jobs[0].stopped, 0);
  } finally { release.resolve(); load.mock.restore(); }
});

test('CancelTask rejects a terminal committed while its stopping response is being read', async t => {
  const f = await fixture(t);
  const task = await f.send('cancel-stopping-response-race');
  const { h, c } = await f.handler();
  const reading = Promise.withResolvers(), release = Promise.withResolvers();
  const original = DatabaseTaskStore.prototype.load;
  let reads = 0;
  const load = t.mock.method(DatabaseTaskStore.prototype, 'load', async function(id, ctx) {
    if (ctx === c && ++reads === 2) { reading.resolve(); await release.promise; }
    return original.call(this, id, ctx);
  });
  try {
    const canceled = assert.rejects(h.cancelTask({ tenant: 'fixed', id: task.id }, c), { reason: 'TASK_NOT_CANCELABLE' });
    await reading.promise;
    f.jobs[0].done.resolve();
    assert.equal((await f.terminal(task.id)).status.state, 5);
    release.resolve(); await canceled;
    assert.equal(f.jobs[0].stopped, 1);
  } finally { release.resolve(); load.mock.restore(); }
});

test('service shutdown ends blocking callers and pending stream reads as unavailable', async t => {
  const f = await fixture(t);
  const task = await f.send('close-waiters');
  const { h, c } = await f.handler();
  const blocking = request('close-waiters'); blocking.configuration.returnImmediately = false;
  const ended = assert.rejects(h.sendMessage(blocking, c), error => error.metadata?.category === 'unavailable');
  const { h: sub, c: sc } = await f.handler();
  const stream = sub.resubscribe({ tenant: 'fixed', id: task.id }, sc);
  await stream.next();
  const streamEnded = assert.rejects(stream.next(), error => error.metadata?.category === 'unavailable');
  const closing = f.service.close({ deadline: performance.now() + 1000 });
  await ended; await streamEnded;
  f.jobs[0].done.resolve(); await closing;
  assert.equal(f.jobs[0].released, true);
});

test('stream errors expose only safe SDK fields while dependency causes stay internal', async t => {
  const secret = 'synthetic-private-dependency-body';
  for (const source of [new Error(secret), new RequestMalformedError({ message: secret, cause: new Error(secret) })]) {
    let fail = false;
    const f = await fixture(t, { resolveEndpoint: async () => {
      if (fail) throw source;
      return { agentId: 'fixture', contentId: 'a'.repeat(64), card };
    } });
    const { h, c } = await f.handler();
    fail = true;
    await assert.rejects(h.sendMessageStream(request('safe-error'), c).next(), error => {
      assert.equal(Object.hasOwn(error, 'cause'), false);
      assert.doesNotMatch(inspect(error, { depth: null }), new RegExp(secret));
      return true;
    });
  }
});

test('runtime invalid-output remains a durable invalid-output failure', async t => {
  const f = await fixture(t, { outcome: { ok: false, error: new ExecutionError('invalid-output') } });
  const task = await f.send('runtime-invalid-output');
  f.jobs[0].done.resolve();
  const final = await f.terminal(task.id);
  assert.equal(final.status.state, 4);
  assert.equal(final.status.message.parts[1].content.value.reasonCode, 'invalid-output');
  assert.equal(f.jobs[0].released, true);
});

test('request byte/depth limits reject before admission and oversized output settles invalid-output', async t => {
  const f = await fixture(t, { output: 'x'.repeat(9000), limits: { maxRequestBytes: 512, maxTaskBytes: 8000, maxJsonDepth: 12 } });
  for (const input of [{ text: 'x'.repeat(1000) }, Array.from({ length: 15 }).reduce(value => ({ nested: value }), {})]) {
    const { h, c } = await f.handler();
    const p = request('out-of-bounds'); p.message.parts[0].content.value = input;
    await assert.rejects(h.sendMessage(p, c), { reason: 'INVALID_PARAMS' });
  }
  assert.equal(f.jobs.length, 0);
  const task = await f.send('bounded-input');
  f.jobs[0].done.resolve();
  const final = await f.terminal(task.id);
  assert.equal(final.status.state, 4);
  assert.equal(final.status.message.parts[1].content.value.reasonCode, 'invalid-output');
  assert.equal(f.jobs[0].released, true);
});
