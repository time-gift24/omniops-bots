import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AgentCard, SendMessageRequest, GetTaskRequest, TaskState, Task, ListTasksRequest } from '@a2a-js/sdk';
import { ServerCallContext, JsonRpcTransportHandler } from '@a2a-js/sdk/server';
import { createA2AService } from '../a2a/index.ts';
import { principalOwner, RECEIPT_EXTENSION } from '../a2a/store.ts';
import { RuntimeError } from '../errors.ts';
import { ExecutionError } from '../execution/index.ts';

const principal = { organizationId: 'org', callerId: 'agent', installationId: 'install' };
const card = AgentCard.fromJSON({ name: 'test', version: '1', description: 'Synthetic test card',
  supportedInterfaces: [{ url: 'http://127.0.0.1/a2a', tenant: 'fixed', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
  defaultInputModes: ['application/json'], defaultOutputModes: ['application/json'],
  capabilities: { streaming: true, extensions: [{ uri: RECEIPT_EXTENSION, required: true }] },
});
const context = (signal, identity = principal) => new ServerCallContext({ requestedVersion: '1.0', requestedExtensions: [RECEIPT_EXTENSION],
  user: { isAuthenticated: true, userName: principalOwner(identity) },
  state: new Map([['omniops.principal', identity], ...(signal ? [['omniops.waitSignal', signal]] : [])]),
});
const request = (messageId, value = {}, returnImmediately = true) => SendMessageRequest.fromJSON({ tenant: 'fixed',
  message: { messageId, role: 'ROLE_USER', parts: [{ data: value }] }, configuration: { returnImmediately },
});
async function fixture(t, limitOverrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'omniops-a2a-service-'));
  const tasks = [];
  let active = 0, releases = 0;
  const runtime = { reserveRun() {
    if (active >= 2) throw new RuntimeError('busy', 'full');
    active++;
    const done = Promise.withResolvers();
    const settled = Promise.withResolvers();
    const item = { stopped: 0, request: undefined, done, settled, fixed: false, released: false };
    tasks.push(item);
    return {
      async execute(value) {
        item.request = value;
        await done.promise;
        item.fixed = true;
        const run = { threadId: value.threadId, runId: value.runId, graphThreadId: 'graph-' + value.runId };
        settled.resolve();
        return item.stopped ? { ok: false, run, error: new ExecutionError('cancelled') } : { ok: true, run, output: value.input.output ?? (value.input.output === null ? null : value.input) };
      },
      requestStop() { if (item.fixed) return 'result-fixed'; item.stopped++; return 'requested'; },
      release() { if (item.released) return; assert.ok(!item.request || item.fixed, 'must drain before release'); item.released = true; active--; releases++; },
    };
  } };
  let service = await createA2AService({ directory, runtime,
    limits: { maxRequestBytes: 32_000, maxTaskBytes: 64_000, maxJsonDepth: 20, maxWaiters: 2, maxSubscriptions: 2, ...limitOverrides },
    async resolveEndpoint(c, tenant, { signal }) { signal.throwIfAborted(); if (tenant !== 'fixed') throw new RuntimeError('forbidden', 'sensitive dependency text'); return { agentId: 'published', contentId: 'a'.repeat(64), card }; },
  });
  t.after(async () => { for (const item of tasks) item.done.resolve(); await service.close({ deadline: performance.now() + 3000 }); await rm(directory, { recursive: true, force: true }); });
  async function handler(c = context()) { const h = await service.protocolFor(c, 'fixed'); c.setTenant('fixed'); return { h, c }; }
  async function get(id) { const { h, c } = await handler(); return h.getTask(GetTaskRequest.fromJSON({ id, tenant: 'fixed' }), c); }
  async function terminal(id) { for (let n = 0; n < 100; n++) { const value = await get(id); if ([3, 4, 5, 7].includes(value.status.state)) return value; await new Promise(r => setImmediate(r)); } assert.fail('task did not settle'); }
  return { directory, tasks, runtime, handler, get, terminal, get service() { return service; }, get active() { return active; }, get releases() { return releases; },
    async restart() { await service.close({ deadline: performance.now() + 3000 }); service = await createA2AService({ directory, runtime, limits: { maxRequestBytes: 32_000, maxTaskBytes: 64_000, maxJsonDepth: 20, maxWaiters: 2, maxSubscriptions: 2 }, resolveEndpoint: async () => ({ agentId: 'published', contentId: 'a'.repeat(64), card }) }); },
  };
}

test('SDK RPC acceptance, concurrent dedup before quota, JSON results and durable receipt survive reopen', async t => {
  const f = await fixture(t);
  const send = async (id, value) => { const { h, c } = await f.handler(); return h.sendMessage(request(id, value), c); };
  const [a, duplicate] = await Promise.all([send('first', { output: null }), send('first', { output: null })]);
  assert.equal(a.id, duplicate.id); assert.equal(f.tasks.length, 1); assert.equal(f.active, 1);
  const b = await send('second', { output: false });
  const busy = await send('third', { output: 0 });
  assert.equal(busy.status.state, TaskState.TASK_STATE_REJECTED); assert.equal(f.tasks.length, 2);
  assert.equal((await send('first', { output: null })).id, a.id);
  await assert.rejects(send('first', { output: true }), { reason: 'INVALID_PARAMS' });
  f.tasks[0].done.resolve(); f.tasks[1].done.resolve();
  const final = await f.terminal(a.id), second = await f.terminal(b.id);
  assert.equal(final.artifacts[0].parts[0].content.value, null); assert.equal(second.artifacts[0].parts[0].content.value, false);
  assert.equal(f.releases, 2);
  const receipt = { tenant: 'fixed', taskId: a.id, resultSha256: final.metadata[RECEIPT_EXTENSION].resultSha256, receivedAt: new Date().toISOString() };
  const c = context(); c.setTenant('fixed');
  assert.deepEqual(await f.service.confirmTaskDelivery(receipt, c), { taskId: a.id, resultSha256: receipt.resultSha256 });
  await f.restart(); assert.deepEqual(await f.get(a.id), final);
  const rpcContext = context(); const h = await f.service.protocolFor(rpcContext, 'fixed');
  const rpc = await new JsonRpcTransportHandler(h).handle({ jsonrpc: '2.0', id: 'read', method: 'GetTask', params: { tenant: 'fixed', id: a.id } }, rpcContext);
  assert.equal(rpc.result.artifacts[0].parts[0].data, null);
});

test('iterator return wakes pending SDK next without stopping task; CancelTask waits for real drain', async t => {
  const f = await fixture(t);
  const { h, c } = await f.handler();
  const task = await h.sendMessage(request('cancel'), c);
  const subContext = context(); const { h: sub, c: sc } = await f.handler(subContext);
  const iterator = sub.resubscribe({ tenant: 'fixed', id: task.id }, sc);
  assert.equal((await iterator.next()).value.payload.$case, 'task');
  const pending = iterator.next();
  const rejected = assert.rejects(pending, e => e.metadata?.category === 'aborted');
  await iterator.return(); await rejected;
  assert.equal(f.tasks[0].stopped, 0); assert.equal(f.active, 1);
  const { h: cancel, c: cc } = await f.handler();
  const stopping = await cancel.cancelTask({ tenant: 'fixed', id: task.id }, cc);
  assert.equal(stopping.status.state, TaskState.TASK_STATE_WORKING); assert.equal(f.tasks[0].stopped, 1); assert.equal(f.active, 1);
  const { h: again, c: ac } = await f.handler(); await again.cancelTask({ tenant: 'fixed', id: task.id }, ac);
  assert.equal(f.tasks[0].stopped, 1);
  f.tasks[0].done.resolve(); assert.equal((await f.terminal(task.id)).status.state, TaskState.TASK_STATE_CANCELED);
  const { h: ended, c: ec } = await f.handler(); await assert.rejects(ended.cancelTask({ tenant: 'fixed', id: task.id }, ec), { reason: 'TASK_NOT_CANCELABLE' });
});

test('stream snapshots and terminal results remain bounded; query isolation, malformed input and lifecycle reject safely', async t => {
  const f = await fixture(t, { maxSubscriptions: 1 });
  const { h, c } = await f.handler();
  const neverStarted = h.sendMessageStream(request('never'), c); await neverStarted.return(); assert.equal(f.tasks.length, 0);
  const { h: sh, c: sc } = await f.handler(); const stream = sh.sendMessageStream(request('stream', { output: 0 }), sc);
  const first = await stream.next(); const id = first.value.payload.value.id; assert.equal(first.value.payload.$case, 'task');
  const { h: extra, c: xc } = await f.handler(); const overflow = extra.resubscribe({ tenant: 'fixed', id }, xc);
  await assert.rejects(overflow.next(), e => e.metadata.category === 'resource-limit');
  f.tasks[0].done.resolve(); const events = []; for await (const event of stream) events.push(event.payload);
  assert.deepEqual(events.map(event => event.$case), ['artifactUpdate', 'statusUpdate']);
  const final = await f.get(id);
  assert.deepEqual(events.at(-1).value.metadata[RECEIPT_EXTENSION], final.metadata[RECEIPT_EXTENSION]);
  const { h: terminal, c: tc } = await f.handler();
  await assert.rejects(terminal.resubscribe({ tenant: 'fixed', id }, tc).next(), { reason: 'UNSUPPORTED_OPERATION' });
  const other = context(undefined, { ...principal, callerId: 'other' }); const { h: oh, c: oc } = await f.handler(other);
  await assert.rejects(oh.getTask({ tenant: 'fixed', id }, oc), { reason: 'TASK_NOT_FOUND' });
  const { h: malformed, c: mc } = await f.handler(); const bad = request('bad'); bad.message.parts[0].content.value = [];
  await assert.rejects(malformed.sendMessage(bad, mc), { reason: 'INVALID_PARAMS' });
  const { h: old, c: oldContext } = await f.handler();
  await assert.rejects(f.service.close({ deadline: NaN }), { kind: 'invalid-request' });
  await old.getTask({ tenant: 'fixed', id }, oldContext);
  await f.service.close({ deadline: performance.now() + 1000 });
  await assert.rejects(old.getTask({ tenant: 'fixed', id }, oldContext), e => e.metadata.category === 'unavailable');
  await assert.rejects(old.getAgentCard(), e => e.metadata.category === 'unavailable');
});
