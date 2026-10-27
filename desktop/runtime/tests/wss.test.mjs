import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { createServer } from 'node:https';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import { createHash } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { AgentCard, Task, TaskState } from '@a2a-js/sdk';
import { A2AError, RequestMalformedError } from '@a2a-js/sdk/errors';
import { connectA2AWss, DEFAULT_WSS_LIMITS, WSS_BINDING, DELIVERY_RECEIPT_EXTENSION as receipt } from '../a2a/wss.ts';
import { createA2AService } from '../a2a/index.ts';
import { ExecutionError } from '../execution/index.ts';

const certificates = await mkdtemp(join(tmpdir(), 'omniops-wss-certs-'));
await promisify(execFile)('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
  '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-keyout', join(certificates, 'key.pem'), '-out', join(certificates, 'cert.pem')]);
const key = await readFile(join(certificates, 'key.pem'));
const cert = await readFile(join(certificates, 'cert.pem'), 'utf8');
const originalTrust = getCACertificates('default');
setDefaultCACertificates([...originalTrust, cert]);
after(async () => { setDefaultCACertificates(originalTrust); await rm(certificates, { recursive: true, force: true }); });

const principal = { organizationId: 'org', callerId: 'caller', installationId: 'installation' };
const credentials = () => ({ authorization: 'Bearer fixture-secret', principal, expiresAt: new Date(Date.now() + 60_000).toISOString() });
const fast = { ...DEFAULT_WSS_LIMITS, connectTimeoutMs: 1000, callTimeoutMs: 1500, reconnectMinMs: 20, reconnectMaxMs: 50, closeTimeoutMs: 200 };
const input = (messageId = 'message') => ({ tenant: 'fixed', message: { messageId, role: 'ROLE_USER', parts: [{ data: { input: true } }] } });
const task = (state = 'TASK_STATE_COMPLETED', value = false) => {
  const result = Task.fromJSON({ id: 'task', contextId: 'context', status: { state, timestamp: '2026-10-26T00:00:00.000Z' }, artifacts: [{ artifactId: 'result', parts: [{ data: value }] }] });
  // SDK 1.3's fromJSON treats data:null as absent; use the real internal value so wire output is checked.
  result.artifacts[0].parts[0].content = { $case: 'data', value };
  return result;
};
const card = (binding = WSS_BINDING) => AgentCard.fromJSON({ name: 'fixture', version: '1', description: 'WSS test',
  supportedInterfaces: [{ url: 'wss://localhost/api/clients/connect', protocolBinding: binding, protocolVersion: '1.0', tenant: 'fixed' }],
  defaultInputModes: ['application/json'], defaultOutputModes: ['application/json'], capabilities: { streaming: true, extensions: [{ uri: receipt, required: true }] } });
function service(overrides = {}) {
  const handler = {
    getAgentCard: async () => card(),
    getTask: async () => task(),
    listTasks: async () => ({ tasks: [task()], pageSize: 1, nextPageToken: '', totalSize: 1 }),
    sendMessage: async () => task(),
    cancelTask: async () => task('TASK_STATE_WORKING'),
    ...overrides,
  };
  return {
    protocolFor: async () => handler,
    confirmTaskDelivery: async request => ({ taskId: request.taskId, resultSha256: request.resultSha256 }),
    close: () => { assert.fail('adapter must never close the borrowed service'); },
  };
}
function observed(socket) {
  const values = [], waits = [];
  socket.on('message', bytes => {
    const value = JSON.parse(bytes.toString());
    const index = waits.findIndex(wait => wait.filter(value));
    if (index >= 0) { const [wait] = waits.splice(index, 1); clearTimeout(wait.timer); wait.resolve(value); }
    else values.push(value);
  });
  return {
    socket,
    next(filter = () => true) {
      const index = values.findIndex(filter);
      if (index >= 0) return Promise.resolve(values.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const wait = { filter, resolve, timer: setTimeout(() => { waits.splice(waits.indexOf(wait), 1); reject(new Error('WSS response deadline')); }, 3000) };
        waits.push(wait);
      });
    },
    rpc(method, params, id = crypto.randomUUID()) {
      const result = this.next(value => value.id === id);
      socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      return result;
    },
    close: () => new Promise(resolve => socket.readyState === 3 ? resolve() : socket.once('close', resolve)),
    values,
  };
}
async function gateway(t, headers = ['A2A-Version: 1.0', `A2A-Extensions: ${receipt}`]) {
  const server = createServer({ key, cert }, (_request, response) => { response.writeHead(404); response.end(); });
  const ws = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
  ws.on('headers', list => list.push(...headers));
  const peers = [], waiting = [];
  ws.on('connection', (socket, request) => {
    const peer = { ...observed(socket), transport: request.socket }; peers.push(peer);
    waiting.shift()?.(peer);
  });
  server.on('upgrade', (request, socket, head) => {
    if (request.url !== '/api/clients/connect' || request.headers.authorization !== 'Bearer fixture-secret') { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return; }
    assert.equal(request.headers['a2a-version'], '1.0');
    assert.equal(request.headers['a2a-extensions'], receipt);
    ws.handleUpgrade(request, socket, head, upgraded => ws.emit('connection', upgraded, request));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `wss://127.0.0.1:${server.address().port}/api/clients/connect`;
  const channels = [];
  t.after(async () => {
    await Promise.allSettled(channels.map(channel => channel.close({ deadline: performance.now() + 500 })));
    for (const peer of peers) peer.socket.terminate();
    await new Promise(resolve => ws.close(resolve));
    await new Promise(resolve => server.close(resolve));
  });
  return {
    url, peers,
    peer: () => new Promise(resolve => waiting.push(resolve)),
    async connect(backend = service(), overrides = {}, getCredentials = credentials) {
      const next = this.peer();
      const channel = await connectA2AWss({ url, service: backend, getCredentials, limits: { ...fast, ...overrides } });
      channels.push(channel);
      return { channel, peer: await next };
    },
  };
}

test('WSS negotiates TLS and standard SDK JSON-RPC; identity, errors, falsy values and receipt stay safe', async t => {
  const f = await gateway(t);
  let context, seen;
  const backend = service({ sendMessage: async (request, c) => { context = c; seen = request; return task('TASK_STATE_COMPLETED', null); },
    getTask: async () => { throw new A2AError({ message: 'fixture-secret must not leak', metadata: { category: 'storage', private: 'fixture-secret' } }); } });
  const { channel, peer } = await f.connect(backend);
  assert.deepEqual(channel.getStatus(), { state: 'connected' });
  const states = []; const unsubscribe = channel.subscribe(state => { states.push(state.state); throw new Error('observer only'); });
  const response = await peer.rpc('SendMessage', input());
  assert.equal(response.result.task.artifacts[0].parts[0].data, null);
  assert.equal(seen.message.messageId, 'message');
  assert.equal(context.user.userName, 'omniops-v1:' + createHash('sha256').update(JSON.stringify(['org', 'caller', 'installation'])).digest('hex'));
  assert.deepEqual(context.state.get('omniops.principal'), principal);
  assert.ok(context.state.get('omniops.waitSignal') instanceof AbortSignal);
  assert.equal(context.state.has('headers'), false);
  const error = await peer.rpc('GetTask', { tenant: 'fixed', id: 'task' });
  assert.equal(error.error.code, -32603);
  assert.equal(JSON.stringify(error).includes('fixture-secret'), false);
  assert.equal(error.error.data[0].metadata.category, 'storage');
  const confirmed = await peer.rpc('omniops/ConfirmTaskDelivery', { tenant: 'fixed', taskId: 'task', resultSha256: 'a'.repeat(64), receivedAt: new Date().toISOString() });
  assert.deepEqual(confirmed.result, { taskId: 'task', resultSha256: 'a'.repeat(64) });
  const unknown = await peer.rpc('NotAMethod', { tenant: 'fixed' });
  assert.equal(unknown.error.code, -32601);
  unsubscribe();
  await channel.close({ deadline: performance.now() + 500 });
  assert.deepEqual(channel.getStatus(), { state: 'closed' });
  assert.deepEqual(states, ['connected']);
});

test('raw message validation precedes SDK coercion and duplicate active IDs seal the connection', async t => {
  const f = await gateway(t);
  let executed = 0;
  const { peer } = await f.connect(service({ sendMessage: async () => { executed++; return task(); } }));
  peer.socket.send('{oops');
  assert.equal((await peer.next()).error.code, -32700);
  for (const invalid of [[], { jsonrpc: '2.0', method: 'SendMessage', params: input() }, { jsonrpc: '2.0', id: null, method: 'SendMessage', params: input() }]) {
    peer.socket.send(JSON.stringify(invalid)); assert.equal((await peer.next()).error.code, -32600);
  }
  const invalid = input(); invalid.configuration = { returnImmediately: 'false' };
  assert.equal((await peer.rpc('SendMessage', invalid)).error.code, -32602);
  const wrongId = input(); wrongId.message.messageId = 123;
  assert.equal((await peer.rpc('SendMessage', wrongId)).error.code, -32602);
  assert.equal(executed, 0);
  const [number, string] = await Promise.all([peer.rpc('ListTasks', { tenant: 'fixed' }, 1), peer.rpc('ListTasks', { tenant: 'fixed' }, '1')]);
  assert.equal(number.id, 1); assert.equal(string.id, '1');

  const suspended = Promise.withResolvers();
  const second = await f.connect(service({ getTask: async () => suspended.promise }));
  second.peer.socket.send(JSON.stringify({ jsonrpc: '2.0', id: 'same', method: 'GetTask', params: { tenant: 'fixed', id: 'task' } }));
  second.peer.socket.send(JSON.stringify({ jsonrpc: '2.0', id: 'same', method: 'GetTask', params: { tenant: 'fixed', id: 'task' } }));
  await second.peer.close();
  assert.deepEqual(second.channel.getStatus(), { state: 'blocked', reason: 'protocol' });
  suspended.resolve(task());
});

test('stream waits are concurrent, bounded, end on a real terminal and do not emit an extra done frame', async t => {
  const f = await gateway(t);
  const finish = Promise.withResolvers();
  let calls = 0, closed = 0;
  const backend = service({
    async *sendMessageStream() {
      calls++;
      try {
        yield { payload: { $case: 'task', value: task('TASK_STATE_WORKING') } };
        await finish.promise;
        yield { payload: { $case: 'statusUpdate', value: { taskId: 'task', contextId: 'context', status: task().status } } };
      } finally { closed++; }
    },
  });
  const { peer } = await f.connect(backend, { maxStreams: 1, maxInFlightRequests: 3 });
  const first = await peer.rpc('SendStreamingMessage', input(), 'stream');
  assert.equal(first.result.task.status.state, 'TASK_STATE_WORKING');
  const query = await peer.rpc('GetTask', { tenant: 'fixed', id: 'task' });
  assert.equal(query.result.id, 'task');
  const overflow = await peer.rpc('SendStreamingMessage', input('overflow'), 'overflow');
  assert.equal(overflow.error.data[0].metadata.category, 'resource-limit');
  assert.equal(calls, 1);
  finish.resolve();
  const last = await peer.next(value => value.id === 'stream');
  assert.equal(last.result.statusUpdate.status.state, 'TASK_STATE_COMPLETED');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, 1);
  assert.equal(peer.values.some(value => value.id === 'stream'), false);
  assert.equal((await peer.rpc('GetTask', { tenant: 'fixed', id: 'task' }, 'stream')).result.id, 'task');
});

test('RPC timeout aborts only waiting and returns a safe error, while nonterminal EOF is never success', async t => {
  const f = await gateway(t);
  let disposed = 0;
  const backend = service({ async *sendMessageStream(_p, context) {
    try {
      yield { payload: { $case: 'task', value: task('TASK_STATE_WORKING') } };
      const signal = context.state.get('omniops.waitSignal');
      await new Promise(resolve => signal.aborted ? resolve() : signal.addEventListener('abort', resolve, { once: true }));
      throw new RequestMalformedError('private fixture-secret');
    } finally { disposed++; }
  } });
  const { peer } = await f.connect(backend, { callTimeoutMs: 40 });
  await peer.rpc('SendStreamingMessage', input(), 'timeout');
  const ended = await peer.next(value => value.id === 'timeout');
  assert.ok(ended.error);
  assert.equal(JSON.stringify(ended).includes('fixture-secret'), false);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(disposed, 1);
  assert.equal((await peer.rpc('GetTask', { tenant: 'fixed', id: 'task' })).result.id, 'task');

  const eof = await f.connect(service({ async *sendMessageStream() { yield { payload: { $case: 'task', value: task('TASK_STATE_WORKING') } }; } }));
  await eof.peer.rpc('SendStreamingMessage', input(), 'eof');
  assert.equal((await eof.peer.next(value => value.id === 'eof')).error.code, -32603);
});

test('disconnect aborts a pending next before return and reconnects with a fresh credential snapshot', async t => {
  const f = await gateway(t);
  let disposed = 0, credentialCalls = 0;
  const backend = service({ async *sendMessageStream(_p, context) {
    try {
      yield { payload: { $case: 'task', value: task('TASK_STATE_WORKING') } };
      const signal = context.state.get('omniops.waitSignal');
      await new Promise(resolve => signal.aborted ? resolve() : signal.addEventListener('abort', resolve, { once: true }));
    } finally { disposed++; }
  } });
  const { peer, channel } = await f.connect(backend, {}, ({ origin, signal }) => { assert.equal(new URL(origin).protocol, 'https:'); assert.ok(signal instanceof AbortSignal); credentialCalls++; return credentials(); });
  await peer.rpc('SendStreamingMessage', input(), 'left');
  const nextPeer = f.peer();
  peer.socket.terminate();
  const replacement = await nextPeer;
  assert.equal((await replacement.rpc('GetTask', { tenant: 'fixed', id: 'task' }, 'left')).result.id, 'task');
  assert.equal(credentialCalls, 2); assert.equal(disposed, 1);
  assert.equal(channel.getStatus().state, 'connected');
  assert.equal(replacement.values.some(value => value.id === 'left'), false);
});

test('paused TLS consumption bounds Task responses, preserves execution and isolates a late old-generation send callback', { timeout: 10000 }, async t => {
  const f = await gateway(t), directory = await mkdtemp(join(tmpdir(), 'omniops-wss-pressure-'));
  const runs = [], entered = Promise.withResolvers(), release = Promise.withResolvers(), pressured = Promise.withResolvers(), completion = Promise.withResolvers();
  const bounded = async (promise, stage) => {
    let timer;
    try { return await Promise.race([promise, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`Controlled WSS backpressure deadline: ${stage}`)), 3000); })]); }
    finally { clearTimeout(timer); }
  };
  const backend = await createA2AService({ directory, limits: { maxRequestBytes: 256 * 1024, maxTaskBytes: 1024 * 1024, maxJsonDepth: 32, maxWaiters: 64, maxSubscriptions: 16 },
    resolveEndpoint: async () => ({ agentId: 'official', contentId: 'a'.repeat(64), card: card() }),
    runtime: { reserveRun() {
      const run = { stopped: 0, finish: Promise.withResolvers(), started: Promise.withResolvers(), released: Promise.withResolvers() }; runs.push(run);
      return {
        async execute(request) { run.started.resolve(); const output = await run.finish.promise; return { ok: true, output, run: { threadId: request.threadId, runId: request.runId, graphThreadId: 'graph' } }; },
        requestStop() { run.stopped++; return 'requested'; },
        release() { run.released.resolve(); },
      };
    } },
  });
  t.after(async () => { release.resolve(); for (const run of runs) run.finish.resolve(false); await backend.close({ deadline: performance.now() + 1000 }); await rm(directory, { recursive: true, force: true }); });
  let loaded = 0, pressureTaskId;
  const gated = { ...backend, async protocolFor(...args) {
    const handler = await backend.protocolFor(...args), getTask = handler.getTask.bind(handler);
    handler.getTask = async (request, context) => {
      const value = await getTask(request, context);
      if (request.id === pressureTaskId && request.historyLength === 0) { if (++loaded === 4) entered.resolve(); await release.promise; }
      return value;
    };
    return handler;
  } };
  // Delay delivery of an actual public send-completion callback. Bytes still use the real TLS
  // transport; retaining this completion deterministically exposes the old-generation race.
  const originalSend = WebSocket.prototype.send;
  let held = false, pressureSends = 0, pressureBytes = 0;
  WebSocket.prototype.send = function(data, options, callback) {
    let value; try { if (typeof data === 'string') value = JSON.parse(data); } catch { /* Control frames are not JSON. */ }
    const done = typeof options === 'function' ? options : callback;
    if (value?.result && typeof value.id === 'string' && value.id.startsWith('pressure-')) {
      pressureSends++; pressureBytes += Buffer.byteLength(data);
      if (!held) {
        held = true;
        const capture = error => completion.resolve({ done, error });
        return typeof options === 'function' ? originalSend.call(this, data, capture) : originalSend.call(this, data, options, capture);
      }
    }
    return originalSend.call(this, data, options, callback);
  };
  t.after(() => { WebSocket.prototype.send = originalSend; });
  const { peer, channel } = await f.connect(gated, { maxMessageBytes: 1024 * 1024 + 8192, maxOutboundMessages: 1, maxOutboundBytes: 2 * 1024 * 1024, maxInFlightRequests: 8, maxStreams: 4 });
  channel.subscribe(state => { if (state.reason === 'backpressure') pressured.resolve(state); });
  const first = input('large-result'); first.configuration = { returnImmediately: true };
  const accepted = await peer.rpc('SendMessage', first);
  pressureTaskId = accepted.result.task.id;
  await bounded(runs[0].started.promise, 'large run start');
  runs[0].finish.resolve({ text: 'x'.repeat(900 * 1024) }); await bounded(runs[0].released.promise, 'large run terminal persistence');
  const second = input('still-running'); second.configuration = { returnImmediately: true };
  const active = await peer.rpc('SendMessage', second); await bounded(runs[1].started.promise, 'active run start');
  const sealed = new Promise(resolve => peer.socket.once('close', code => resolve(code)));
  peer.transport.pause();
  assert.equal(peer.transport.isPaused(), true);
  const nextPeer = f.peer();
  await Promise.all(Array.from({ length: 4 }, (_, index) => new Promise((resolve, reject) => peer.socket.send(JSON.stringify({ jsonrpc: '2.0', id: `pressure-${index}`, method: 'GetTask', params: { tenant: 'fixed', id: accepted.result.task.id, historyLength: 0 } }), error => error ? reject(error) : resolve()))));
  await bounded(entered.promise, 'gated Task loads'); release.resolve();
  assert.equal((await bounded(pressured.promise, 'bounded queue seal')).state, 'reconnecting');
  assert.equal(pressureSends, 1, 'the configured one-frame queue must seal before sending another large response');
  assert.ok(pressureBytes > 900 * 1024 && pressureBytes <= 1024 * 1024, 'the Task is legal and bounded, rather than an oversized-response rejection');
  assert.equal(peer.values.some(value => typeof value.id === 'string' && value.id.startsWith('pressure-')), false, 'the TLS peer has not consumed Task bytes while paused');
  peer.transport.resume();
  assert.equal(await bounded(sealed, '1013 backpressure close'), 1013);
  const stale = await bounded(completion.promise, 'real TLS send completion'), replacement = await bounded(nextPeer, 'replacement peer');
  const pending = await replacement.rpc('GetTask', { tenant: 'fixed', id: active.result.task.id }, 'pressure-0');
  assert.equal(pending.result.status.state, 'TASK_STATE_WORKING');
  assert.equal(runs.length, 2); assert.deepEqual(runs.map(run => run.stopped), [0, 0]);
  stale.done(stale.error);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(channel.getStatus().state, 'connected');
  assert.ok(peer.values.filter(value => typeof value.id === 'string' && value.id.startsWith('pressure-')).length <= 1);
  assert.equal(replacement.values.some(value => typeof value.id === 'string' && value.id.startsWith('pressure-')), false, 'late frames must not migrate to the new connection');
  runs[1].finish.resolve(false); await bounded(runs[1].released.promise, 'active run terminal persistence');
  assert.equal((await replacement.rpc('GetTask', { tenant: 'fixed', id: active.result.task.id }, 'after-stale-callback')).result.status.state, 'TASK_STATE_COMPLETED');
  assert.deepEqual(runs.map(run => run.stopped), [0, 0]);
});

test('missing negotiation, unsupported binding, invalid credentials and constructor cancellation do not execute', async t => {
  const bad = await gateway(t, ['A2A-Version: 1.0']);
  await assert.rejects(connectA2AWss({ url: bad.url, service: service(), getCredentials: credentials, limits: fast }), { kind: 'protocol' });
  const f = await gateway(t);
  await assert.rejects(connectA2AWss({ url: f.url, service: service(), getCredentials: () => ({ ...credentials(), authorization: 'Bearer bad\r\nX: unsafe' }), limits: fast }), { kind: 'authentication' });
  await assert.rejects(connectA2AWss({ url: f.url.replace('wss:', 'ws:'), service: service(), getCredentials: credentials, limits: fast }), { kind: 'invalid-request' });
  await assert.rejects(connectA2AWss({ url: f.url, service: service(), getCredentials: credentials, limits: { ...fast, maxStreams: fast.maxInFlightRequests } }), { kind: 'invalid-request' });
  const control = new AbortController();
  const creating = connectA2AWss({ url: f.url, service: service(), getCredentials: ({ signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('credential source canceled')), { once: true })), limits: fast }, { signal: control.signal });
  control.abort();
  await assert.rejects(creating, { kind: 'aborted' });
  const { peer } = await f.connect(service({ getAgentCard: async () => card('JSONRPC') }));
  assert.equal((await peer.rpc('GetTask', { tenant: 'fixed', id: 'task' })).error.code, -32009);
});

test('session expiry blocks the connection, oversized results fail safely, and close is idempotent', async t => {
  const f = await gateway(t);
  const oversized = await f.connect(service({ listTasks: async () => ({ tasks: [task('TASK_STATE_COMPLETED', 'z'.repeat(3 * 1024 * 1024))], pageSize: 1, nextPageToken: '', totalSize: 1 }) }));
  const limited = await oversized.peer.rpc('ListTasks', { tenant: 'fixed', includeArtifacts: true });
  assert.equal(limited.error.data[0].metadata.category, 'resource-limit');
  assert.equal(oversized.channel.getStatus().state, 'connected');
  const expires = await f.connect(service(), {}, () => ({ ...credentials(), expiresAt: new Date(Date.now() + 100).toISOString() }));
  await expires.peer.close();
  assert.deepEqual(expires.channel.getStatus(), { state: 'blocked', reason: 'authentication' });
  const closed = oversized.channel.close({ deadline: performance.now() + 500 });
  assert.equal(oversized.channel.close({ deadline: performance.now() + 1000 }), closed);
  await closed;
  assert.deepEqual(oversized.channel.getStatus(), { state: 'closed' });
});

test('real A2AService task survives WSS loss, cancellation drains, and result receipt is persisted', async t => {
  const f = await gateway(t);
  const directory = await mkdtemp(join(tmpdir(), 'omniops-wss-service-'));
  const runs = [];
  let releases = 0;
  const backend = await createA2AService({ directory, limits: { maxRequestBytes: 256 * 1024, maxTaskBytes: 1024 * 1024, maxJsonDepth: 32, maxWaiters: 64, maxSubscriptions: 16 },
    resolveEndpoint: async () => ({ agentId: 'official', contentId: 'a'.repeat(64), card: card() }),
    runtime: { reserveRun() {
      const finish = Promise.withResolvers();
      const run = { stopped: 0, finish, started: Promise.withResolvers() }; runs.push(run);
      return {
        async execute(request) { run.started.resolve(); await finish.promise; return { ok: false, run: { threadId: request.threadId, runId: request.runId, graphThreadId: 'graph' }, error: new ExecutionError('cancelled') }; },
        requestStop() { run.stopped++; return 'requested'; },
        release() { releases++; },
      };
    } },
  });
  t.after(async () => { for (const run of runs) run.finish.resolve(); await backend.close({ deadline: performance.now() + 1000 }); await rm(directory, { force: true, recursive: true }); });
  const { peer } = await f.connect(backend);
  const p = input('durable'); p.configuration = { returnImmediately: true };
  const accepted = await peer.rpc('SendMessage', p);
  assert.equal(accepted.result.task.status.state, 'TASK_STATE_WORKING');
  await runs[0].started.promise;
  const nextPeer = f.peer(); peer.socket.terminate();
  const replacement = await nextPeer;
  const same = await replacement.rpc('SendMessage', p);
  assert.equal(same.result.task.id, accepted.result.task.id); assert.equal(runs.length, 1); assert.equal(runs[0].stopped, 0);
  const stopping = await replacement.rpc('CancelTask', { tenant: 'fixed', id: accepted.result.task.id });
  assert.equal(stopping.result.status.state, 'TASK_STATE_WORKING'); assert.equal(releases, 0);
  runs[0].finish.resolve();
  let final;
  for (let n = 0; n < 100; n++) {
    final = await replacement.rpc('GetTask', { tenant: 'fixed', id: accepted.result.task.id });
    if (final.result.status.state === 'TASK_STATE_CANCELED') break;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(final.result.status.state, 'TASK_STATE_CANCELED'); assert.equal(releases, 1);
  const confirmation = { tenant: 'fixed', taskId: accepted.result.task.id, resultSha256: final.result.metadata[receipt].resultSha256, receivedAt: new Date().toISOString() };
  const first = await replacement.rpc('omniops/ConfirmTaskDelivery', confirmation);
  const duplicate = await replacement.rpc('omniops/ConfirmTaskDelivery', confirmation);
  assert.deepEqual(first.result, duplicate.result);
  assert.equal(first.result.taskId, accepted.result.task.id);
  assert.equal(runs.length, 1);
});
