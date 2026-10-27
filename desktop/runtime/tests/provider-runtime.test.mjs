import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import readline from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { MemorySaver } from '@langchain/langgraph';
import { createProviderCatalog } from '../providers.ts';
import { createResources } from '../resources.ts';
import { createDesktopRuntime } from '../runtime.ts';
import { createModelFixture } from './model-fixture.mjs';
import { packageContentId, writePackageFiles } from '../package.ts';
import { createRunFingerprint } from '../fingerprint.ts';
import { createRunRecords } from '../execution/records.ts';

const id = provider => JSON.stringify([provider, 'shared']);
const request = { messages: [{ role: 'user', text: '只回答当前问题。' }] };
const browser = () => ({ getState: () => ({}), forThread() { return this; }, subscribe() {}, async close() {} });
async function until(check) {
  for (let i = 0; i < 500; i++) { const value = await check(); if (value) return value; await delay(10); }
  throw new Error('Runtime did not settle');
}

test('historyRunId starts a new exact formal composition with current credentials and refuses incompatible history', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'provider-history-')), runsDir = join(directory, 'runs');
  const fixture = await createModelFixture({ respond: () => ({ text: '历史组成的新执行。' }) }), keys = new Map();
  const credentials = { async get(ref) { return keys.get(ref) ?? null; }, async set(ref, key) { keys.set(ref, key); }, async delete(ref) { keys.delete(ref); } };
  let catalog, runtime;
  const writable = async file => { if (!(await lstat(file)).isDirectory()) return; await chmod(file, 0o700); for (const name of await readdir(file)) await writable(join(file, name)); };
  t.after(async () => { await runtime?.close(); await fixture.close(); await writable(directory); await rm(directory, { recursive: true, force: true }); });
  const store = async (kind, id, entries) => {
    const contentId = packageContentId(entries), target = join(directory, '.omnimind-ops', kind, 'releases', id, contentId);
    await mkdir(target, { recursive: true }); await writePackageFiles(entries, target); return { contentId, target };
  };
  const skill = await store('skills', 'fixed', [{ path: 'SKILL.md', kind: 'file', bytes: Buffer.from('---\nname: fixed\ndescription: Historical package.\n---\nFixed instructions.\n') }, { path: 'reference.bin', kind: 'file', bytes: Buffer.from([0,255,1]) }]);
  const config = { schemaVersion: 1, name: 'Historical operator', description: 'Exact history', promptFile: 'prompt.md', toolIds: [], mcpServers: [], skills: [{ skillId: 'fixed', contentId: skill.contentId, mountPath: '/skills/fixed/' }] };
  const agent = await store('agents', 'historical', [{ path: 'agent.json', kind: 'file', bytes: Buffer.from(JSON.stringify(config)) }, { path: 'prompt.md', kind: 'file', bytes: Buffer.from('HISTORICAL_PROMPT') }]);
  await store('agents', 'historical', [{ path: 'agent.json', kind: 'file', bytes: Buffer.from(JSON.stringify(config)) }, { path: 'prompt.md', kind: 'file', bytes: Buffer.from('CURRENT_PROMPT') }]);
  const open = async () => {
    catalog = await createProviderCatalog({ file: join(directory, 'providers.json'), credentials });
    runtime = await createDesktopRuntime({ browser: browser(), resources: createResources({ homeDir: directory, runsDir }), runsDir, providers: catalog, workspace: {}, checkpointer: new MemorySaver(), redact: catalog.redact });
  };
  await open();
  await catalog.save({ name: '历史接入', baseURL: fixture.baseURL, models: ['shared'], apiKey: 'old-history-key' });
  await catalog.setDefault({ provider: '历史接入', model: 'shared' });
  const settle = runId => until(() => runtime.getState().tasks.length ? null : runtime.dispatch('run_get', { runId }));
  runtime.dispatch('chat_start', { runId: 'source', threadId: 'old-thread', agentId: 'historical', agentContentId: agent.contentId, request: { messages: [{ role: 'user', text: 'SOURCE_ONLY_INPUT' }] } });
  const source = await settle('source'); assert.equal(source.status, 'completed');
  await catalog.save({ originalName: '历史接入', name: '历史接入', baseURL: fixture.baseURL, models: ['shared'], apiKey: 'rotated-history-key' });
  assert.equal(keys.has(source.snapshot.provider.credentialRef), false, 'old credential reference must no longer resolve');
  await catalog.save({ name: '新默认', baseURL: fixture.baseURL, models: ['shared'] });
  await catalog.setDefault({ provider: '新默认', model: 'shared' });
  const start = (runId, threadId, extra = {}) => runtime.dispatch('chat_start', { runId, threadId, historyRunId: 'source', request: { messages: [{ role: 'user', text: 'NEW_ONLY_INPUT' }] }, ...extra });
  start('restored-history', 'new-history');
  const restored = await settle('restored-history'); assert.equal(restored.status, 'completed', JSON.stringify(restored.error));
  assert.equal(restored.historyRunId, 'source'); assert.notEqual(restored.graphThreadId, source.graphThreadId);
  assert.equal(restored.snapshot.fingerprint, source.snapshot.fingerprint); assert.equal(restored.snapshot.agent.contentId, agent.contentId);
  assert.equal(restored.snapshot.provider.provider, '历史接入'); assert.notEqual(restored.snapshot.provider.credentialRef, source.snapshot.provider.credentialRef);
  assert.deepEqual(await readFile(join(restored.snapshot.directory, 'skills/fixed/reference.bin')), Buffer.from([0,255,1]));
  const wire = JSON.stringify(fixture.requests.at(-1));
  assert.match(wire, /HISTORICAL_PROMPT/); assert.match(wire, /NEW_ONLY_INPUT/); assert.doesNotMatch(wire, /SOURCE_ONLY_INPUT|CURRENT_PROMPT/);
  assert.deepEqual(runtime.dispatch('run_get', { runId: 'source' }), source);
  assert.throws(() => start('existing-thread', 'new-history'), { kind: 'invalid-request' });
  assert.throws(() => start('conflicting-model', 'other-thread', { request: { ...request, model: id('新默认') } }), { kind: 'invalid-request' });
  const count = fixture.requests.length;
  await catalog.save({ originalName: '历史接入', name: '历史接入', baseURL: fixture.baseURL + '/changed', models: ['shared'] });
  start('changed-endpoint', 'changed-endpoint');
  assert.equal((await settle('changed-endpoint')).error.kind, 'unavailable'); assert.equal(fixture.requests.length, count);
  await catalog.save({ originalName: '历史接入', name: '历史接入', baseURL: fixture.baseURL, models: ['shared'] });
  await runtime.close();
  const records = await createRunRecords(runsDir), changed = { ...source.snapshot, modelParameters: { temperature: 1, parallel_tool_calls: false } };
  Object.assign(changed, createRunFingerprint({ agent: changed.agent, skills: changed.skills, provider: changed.provider, modelId: changed.provider.model, parameters: changed.modelParameters }));
  await records.save({ runId: 'prior-parameters', threadId: 'prior-parameters', graphThreadId: 'old-parameters-graph', status: 'completed', startedAt: new Date().toISOString(), details: { snapshot: changed, events: [] } });
  await open();
  start('changed-parameters', 'changed-parameters', { historyRunId: 'prior-parameters' });
  assert.equal((await settle('changed-parameters')).error.kind, 'unavailable'); assert.equal(fixture.requests.length, count);
  await rm(skill.target, { recursive: true });
  start('missing-asset', 'missing-asset');
  assert.equal((await settle('missing-asset')).status, 'failed'); assert.equal(fixture.requests.length, count, 'missing exact Skill cannot fall back to the saved working snapshot');
  runtime.dispatch('chat_start', { runId: 'local-source', threadId: 'local-source', request });
  assert.equal((await settle('local-source')).status, 'completed');
  assert.throws(() => start('local-history', 'local-history', { historyRunId: 'local-source' }), { kind: 'unavailable' });
});

test('real Provider models stay pinned across defaults, failed preparation, settings changes and restart', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'provider-runtime-'));
  const fixture = await createModelFixture({ respond: () => ({ text: '本地模型完成。' }) });
  const keys = new Map();
  const credentials = { async get(ref) { return keys.get(ref) ?? null; }, async set(ref, key) { keys.set(ref, key); }, async delete(ref) { keys.delete(ref); } };
  const file = join(directory, 'providers.json'), runsDir = join(directory, 'runs');
  let runtime, catalog, failPreparation = true;
  const open = async () => {
    catalog = await createProviderCatalog({ file, credentials });
    const resources = createResources({ homeDir: directory, runsDir });
    const original = resources.prepareSession;
    resources.prepareSession = async options => {
      if (options.sessionId === 'preparation' && failPreparation) { failPreparation = false; throw new Error('Fixture preparation failed'); }
      return original(options);
    };
    runtime = await createDesktopRuntime({ browser: browser(), resources, runsDir, checkpointer: new MemorySaver(), providers: catalog, workspace: {}, redact: catalog.redact });
  };
  t.after(async () => { await runtime?.close(); await fixture.close(); await rm(directory, { recursive: true, force: true }); });
  await open();
  await runtime.dispatch('provider_save', { name: '公司', baseURL: fixture.baseURL, models: ['shared'], apiKey: 'private-provider-key' });
  await runtime.dispatch('provider_save', { name: '本地', baseURL: fixture.baseURL, models: ['shared'] });
  await runtime.dispatch('provider_default', { provider: '公司', model: 'shared' });
  const settle = async runId => until(() => {
    if (runtime.getState().tasks.length) return null;
    const run = runtime.dispatch('run_get', { runId });
    return ['completed', 'failed'].includes(run.status) ? run : null;
  });
  const start = (runId, threadId, model) => runtime.dispatch('chat_start', { runId, threadId, request: { ...request, ...(model ? { model } : {}) } });
  start('stopped-before-prepare', 'stopped');
  await runtime.dispatch('stop', { runId: 'stopped-before-prepare' });
  assert.equal((await runtime.dispatch('session_snapshot', { threadId: 'stopped' })).model, id('公司'));
  start('prepare-failed', 'preparation');
  assert.equal((await settle('prepare-failed')).status, 'failed');
  assert.equal((await runtime.dispatch('session_snapshot', { threadId: 'preparation' })).model, id('公司'));
  await runtime.dispatch('provider_default', { provider: '本地', model: 'shared' });
  start('prepare-retried', 'preparation');
  const first = await settle('prepare-retried');
  assert.equal(first.status, 'completed');
  assert.equal(first.snapshot.provider.provider, '公司');
  assert.equal(first.result.metadata.requestedModel, 'shared');
  assert.doesNotMatch(JSON.stringify(first), /private-provider-key/);
  start('new-default', 'new');
  assert.equal((await settle('new-default')).snapshot.provider.provider, '本地');
  await runtime.close();
  await open();
  start('restored', 'preparation');
  const restored = await settle('restored');
  assert.equal(restored.status, 'completed');
  assert.equal(restored.snapshot.model, id('公司'));
  const count = fixture.requests.length;
  start('switch-refused', 'preparation', id('本地'));
  assert.equal((await settle('switch-refused')).status, 'failed');
  assert.equal(fixture.requests.length, count);
  keys.clear();
  start('missing-key', 'preparation');
  const failed = await settle('missing-key');
  assert.equal(failed.error.kind, 'credentials');
  assert.equal(fixture.requests.length, count, 'missing credentials never send history elsewhere');
  assert.equal((await runtime.dispatch('session_snapshot', { threadId: 'preparation' })).provider.provider, '公司');
  await runtime.dispatch('provider_save', { originalName: '公司', name: '公司', baseURL: fixture.baseURL, models: ['shared'], apiKey: 'a' });
  start('key-matches-model', 'short-key', id('公司'));
  const shortKey = await settle('key-matches-model');
  assert.equal(shortKey.status, 'completed');
  assert.equal(shortKey.snapshot.model, id('公司'));
  assert.equal(shortKey.snapshot.provider.model, 'shared');
  start('key-matches-model-next', 'short-key');
  assert.equal((await settle('key-matches-model-next')).status, 'completed');
  start('key-matches-error-kind', 'short-key', id('本地'));
  assert.equal((await settle('key-matches-error-kind')).error.kind, 'invalid-request');
});

test('connection test cancellation owns no task slot and shutdown drains tests', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'provider-test-cancel-'));
  const entered = Promise.withResolvers();
  let stopped = 0;
  const providers = {
    async test(_choice, { signal }) {
      entered.resolve();
      await new Promise((resolve, reject) => {
        const stop = () => { stopped++; reject(signal.reason); };
        if (signal.aborted) stop(); else signal.addEventListener('abort', stop, { once: true });
      });
    },
    async close() {},
  };
  const runtime = await createDesktopRuntime({ browser: browser(), resources: {}, runsDir: directory, providers, checkpointer: new MemorySaver() });
  t.after(async () => { await runtime.close(); await rm(directory, { recursive: true, force: true }); });
  const first = runtime.dispatch('provider_test', { testId: 'manual', provider: '公司', model: 'shared' });
  const failure = assert.rejects(first, { name: 'AbortError' });
  await entered.promise;
  assert.deepEqual(runtime.getState().tasks, []);
  assert.throws(() => runtime.dispatch('provider_test', { testId: 'manual' }), { kind: 'duplicate-test' });
  assert.deepEqual(runtime.dispatch('provider_test_cancel', { testId: 'manual' }), { stopped: true });
  await failure;
  const next = runtime.dispatch('provider_test', { testId: 'on-close' });
  const closingFailure = assert.rejects(next, { name: 'AbortError' });
  await runtime.close();
  await closingFailure;
  assert.equal(stopped, 2);
});

test('restarted Provider redacts first input and reflected remote IDs while preserving tool associations on continuation', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'provider-remote-identities-'));
  const runsDir = join(directory, 'runs'), secret = 'fixture-reflected-provider-credential-long';
  const requests = [], events = [], keys = new Map();
  const server = createServer(async (incoming, response) => {
    try {
      let text = '';
      for await (const chunk of incoming) text += chunk;
      requests.push(JSON.parse(text));
      const tool = requests.length === 1;
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const send = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({
        id: `chatcmpl-${secret}-${requests.length}`, object: 'chat.completion.chunk', created: 1, model: 'shared',
        choices: [{ index: 0, delta, finish_reason }],
      })}\n\n`);
      send({ role: 'assistant' });
      send(tool ? { tool_calls: [{ index: 0, id: `call-${secret}`, type: 'function', function: { name: 'inspect_browser', arguments: '{}' } }] } : { content: '模型请求完成。' });
      send({}, tool ? 'tool_calls' : 'stop');
      response.end('data: [DONE]\n\n');
    } catch {
      response.writeHead(400);
      response.end();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let runtime, inspections = 0;
  t.after(async () => {
    await runtime?.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const credentials = {
    async get(ref) { return keys.get(ref) ?? null; },
    async set(ref, key) { keys.set(ref, key); },
    async delete(ref) { keys.delete(ref); },
  };
  const file = join(directory, 'providers.json');
  let catalog = await createProviderCatalog({ file, credentials });
  await catalog.save({ name: '安全接入', baseURL: `http://127.0.0.1:${server.address().port}/v1`, models: ['shared'], apiKey: secret });
  await catalog.setDefault({ provider: '安全接入', model: 'shared' });
  await catalog.close();
  catalog = await createProviderCatalog({ file, credentials });
  runtime = await createDesktopRuntime({
    browser: { ...browser(), async inspect() { inspections++; return { title: '本地测试页面' }; } },
    resources: createResources({ homeDir: directory, runsDir }), runsDir, workspace: {},
    providers: catalog, checkpointer: new MemorySaver(), redact: catalog.redact, emit: event => events.push(event),
  });
  for (const runId of ['reflected-ids', 'continued']) {
    runtime.dispatch('chat_start', { runId, threadId: 'same-thread', request: runId === 'reflected-ids'
      ? { messages: [{ role: 'user', text: `诊断输入 ${secret}` }] } : request });
    const record = await until(() => runtime.getState().tasks.length ? null : runtime.dispatch('run_get', { runId }));
    assert.equal(record.status, 'completed');
    assert.equal(JSON.stringify(record).includes(secret), false, 'public run records must exclude reflected credentials');
  }
  assert.equal(inspections, 1, 'continuation must preserve the prior tool result without replaying it');
  assert.equal(requests.length, 3);
  for (const body of requests.slice(1)) {
    const calls = body.messages.flatMap(message => message.tool_calls ?? []);
    const outputs = body.messages.filter(message => message.role === 'tool');
    assert.equal(calls.length, 1, JSON.stringify(body.messages.map(message => ({ role: message.role, calls: message.tool_calls?.length ?? 0 }))));
    assert.equal(calls[0].function.name, 'inspect_browser');
    assert.equal(outputs.length, 1);
    assert.equal(outputs[0].tool_call_id, calls[0].id, 'restored tool replies must remain associated with their calls');
  }
  assert.equal(JSON.stringify(events).includes(secret), false, 'runtime events must exclude reflected credentials');
  for (const folder of ['.sessions', '.records']) {
    for (const name of await readdir(join(runsDir, folder))) {
      if (!name.endsWith('.json')) continue;
      assert.equal((await readFile(join(runsDir, folder, name), 'utf8')).includes(secret), false, `${folder} must exclude reflected credentials`);
    }
  }
});

test('packaged Node IPC imports legacy credentials via the host and tests a model without opening a browser', { timeout: 20000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'provider-main-ipc-'));
  const fixture = await createModelFixture({ respond: () => ({ text: 'OK' }) });
  const child = spawn(process.execPath, [new URL('../main.ts', import.meta.url).pathname], { env: { ...process.env,
    OMNIOPS_BOTS_DATA_DIR: directory, OMNIOPS_BOTS_LOCAL_ROOT: join(directory, 'local'),
    OMNIOPS_BOTS_MODEL: 'shared', OPENAI_BASE_URL: fixture.baseURL, OPENAI_API_KEY: 'private-legacy-fixture',
  }, stdio: ['pipe', 'pipe', 'pipe'] });
  const keys = new Map(), pending = new Map(), ready = Promise.withResolvers();
  const lines = readline.createInterface({ input: child.stdout });
  let nextId = 0, stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  lines.on('line', line => {
    const message = JSON.parse(line);
    if (message.event === 'credential_request') {
      assert.match(message.reference, /^[0-9a-f-]{36}$/);
      let result = null;
      if (message.operation === 'set') keys.set(message.reference, message.secret);
      if (message.operation === 'get') result = keys.get(message.reference) ?? null;
      if (message.operation === 'delete') keys.delete(message.reference);
      child.stdin.write(JSON.stringify({ event: 'credential_reply', requestId: message.requestId, result }) + '\n');
    } else if (message.event === 'ready') ready.resolve();
    else if (message.id) {
      const item = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) item?.reject(message.error); else item?.resolve(message.result);
    }
  });
  const call = (method, params) => {
    const id = ++nextId, deferred = Promise.withResolvers();
    pending.set(id, deferred);
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    return deferred.promise;
  };
  t.after(async () => { if (child.exitCode === null) child.kill('SIGKILL'); lines.close(); await fixture.close(); await rm(directory, { recursive: true, force: true }); });
  await Promise.race([ready.promise, once(child, 'exit').then(() => { throw new Error('Node runtime did not become ready: ' + stderr); })]);
  const catalog = await call('providers_get');
  assert.equal(catalog.providers[0].hasKey, true);
  const [model] = await call('models_list');
  assert.equal(model.isDefault, true);
  assert.equal(model.id, JSON.stringify(['默认接入', 'shared']));
  assert.deepEqual(await call('provider_test', { testId: 'ipc-test', provider: '默认接入', model: 'shared' }), { tested: true });
  assert.deepEqual((await call('status')).tasks, []);
  assert.equal(fixture.requests.length, 1);
  assert.doesNotMatch(await readFile(join(directory, 'providers.json'), 'utf8'), /private-legacy-fixture/);
  assert.doesNotMatch(stderr, /private-legacy-fixture/);
  const exited = once(child, 'exit');
  await call('shutdown');
  assert.equal((await exited)[0], 0);
});
