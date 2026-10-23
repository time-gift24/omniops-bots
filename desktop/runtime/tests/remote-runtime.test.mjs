import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { FakeToolCallingModel } from 'langchain';
import { AIMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import { createDesktopRuntime } from '../runtime.ts';
import { createResources } from '../resources.ts';

async function fixture(t, generate) {
  const directory = await mkdtemp(join(tmpdir(), 'a2a-runtime-'));
  const agentsDir = join(directory, 'agents');
  await mkdir(agentsDir);
  const configuration = { name: 'JSON fixture', description: 'Generic JSON', instructions: 'Return JSON.', toolIds: [], skillIds: [], mcpServerIds: [] };
  const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
  const contentId = createHash('sha256').update(canonical(configuration)).digest('hex');
  await writeFile(join(agentsDir, 'fixture-agent.json'), JSON.stringify({ id: 'fixture-agent', source: 'official', contentId, configuration }));
  const resources = createResources({ homeDir: directory, agentsDir, runsDir: join(directory, 'runs'), temporaryDir: join(directory, 'tmp') });
  const snapshot = { url: '', title: '', status: 'empty', canGoBack: false, canGoForward: false };
  const browser = { getState: () => snapshot, subscribe() {}, close: async () => {}, forThread: () => ({ stop: async () => {}, inspect: async () => ({}), refresh: async () => {} }) };
  class Model extends FakeToolCallingModel {
    bindTools() { return this; }
    async _generate(messages, options) {
      const input = JSON.parse(messages.findLast(message => message.getType() === 'human').content);
      return { generations: [{ text: '', message: new AIMessage({ id: randomUUID(), content: await generate(input, options.signal) }) }] };
    }
  }
  const workspace = { list: async () => [], read: async () => { throw new Error('unused'); }, save: async () => { throw new Error('unused'); }, run: async () => { throw new Error('unused'); } };
  const runtime = await createDesktopRuntime({ browser, resources, workspace, runsDir: join(directory, 'runs'), checkpointer: new MemorySaver(), modelName: 'fixture', modelFactory: () => new Model({ toolCalls: [] }), maxConcurrentRuns: 1 });
  t.after(async () => { await runtime.close(); await rm(directory, { recursive: true, force: true }); });
  return { runtime, request: (input = {}, options = {}) => ({ threadId: randomUUID(), runId: randomUUID(), agent: { agentId: 'fixture-agent', contentId }, input, ...options }) };
}

test('real JSON graph preserves scalar outputs and quota is released only explicitly', async t => {
  const { runtime, request } = await fixture(t, input => JSON.stringify(input.output));
  for (const output of [0, false, null, { nested: ['value'] }]) {
    const reservation = runtime.reserveRun();
    assert.throws(() => runtime.reserveRun(), { kind: 'busy' });
    const outcome = await reservation.execute(request({ output }));
    assert.equal(outcome.ok, true, outcome.error?.stack);
    assert.deepEqual(outcome.output, output);
    assert.equal(reservation.requestStop(), 'result-fixed');
    assert.throws(() => runtime.reserveRun(), { kind: 'busy' });
    reservation.release(); reservation.release();
    assert.equal((await reservation.execute(request())).ok, false);
  }
});

test('remote cancellation waits actual model drain and freezes before Run settlement', async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const { runtime, request } = await fixture(t, async (_input, signal) => { entered.resolve(signal); await release.promise; return 'false'; });
  const reservation = runtime.reserveRun(), execution = reservation.execute(request());
  const signal = await entered.promise;
  assert.equal(reservation.requestStop(), 'requested');
  assert.equal(signal.aborted, true);
  assert.throws(() => reservation.release(), { kind: 'invalid-request' });
  let done = false;
  void execution.then(() => { done = true; });
  await delay(25);
  assert.equal(done, false);
  release.resolve();
  const outcome = await execution;
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error.kind, 'cancelled');
  const record = runtime.dispatch('run_get', { runId: outcome.run.runId });
  assert.equal(record.status, 'cancelled');
  reservation.release();
});

test('fixed version and JSON output validation fail without falling back to another Agent', async t => {
  let calls = 0;
  const { runtime, request } = await fixture(t, () => { calls++; return 'not JSON'; });
  const invalidVersion = runtime.reserveRun();
  assert.equal((await invalidVersion.execute(request({}, { agent: { agentId: 'fixture-agent', contentId: 'a'.repeat(64) } }))).ok, false);
  assert.equal(calls, 0);
  invalidVersion.release();
  const invalidOutput = runtime.reserveRun();
  const outcome = await invalidOutput.execute(request());
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error.kind, 'invalid-output');
  assert.equal(calls, 1);
  invalidOutput.release();
});

test('remote reservations share local capacity and stop can latch before execute', async t => {
  let calls = 0;
  const { runtime, request } = await fixture(t, input => { calls++; return JSON.stringify(input.output); });
  const reservation = runtime.reserveRun();
  assert.throws(() => runtime.dispatch('chat_start', { runId: 'local', threadId: 'local', request: { messages: [{ role: 'user', text: '{"output":true}' }] } }), { kind: 'unavailable' });
  assert.equal(reservation.requestStop(), 'requested');
  assert.equal(reservation.requestStop(), 'requested');
  const outcome = await reservation.execute(request({ output: true }));
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error.kind, 'cancelled');
  assert.equal(calls, 0);
  reservation.release();
  runtime.dispatch('chat_start', { runId: 'local', threadId: 'local', request: { messages: [{ role: 'user', text: '{"output":true}' }] } });
  assert.throws(() => runtime.reserveRun(), { kind: 'busy' });
  await runtime.dispatch('stop', { runId: 'local' });
});

test('remote execute copies boundary input and fixed version before asynchronous preparation', async t => {
  const { runtime, request } = await fixture(t, input => JSON.stringify(input));
  const reservation = runtime.reserveRun(), input = request({ value: false });
  const done = reservation.execute(input);
  input.agent.contentId = 'a'.repeat(64);
  input.input.value = true;
  const outcome = await done;
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.output, { value: false });
  reservation.release();
});

test('runtime close uses the caller deadline and retains draining work until actual cleanup', async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const { runtime, request } = await fixture(t, async () => { entered.resolve(); await release.promise; return 'null'; });
  const reservation = runtime.reserveRun(), done = reservation.execute(request());
  await entered.promise;
  try {
    await assert.rejects(runtime.close({ deadline: performance.now() + 20 }), { kind: 'unavailable' });
    await assert.rejects(runtime.close({ deadline: performance.now() - 1 }), { kind: 'unavailable' });
    assert.throws(() => runtime.reserveRun(), { kind: 'unavailable' });
    assert.throws(() => reservation.release(), { kind: 'invalid-request' });
  } finally { release.resolve(); }
  assert.equal((await done).error.kind, 'cancelled');
  await runtime.close({ deadline: performance.now() + 1_000 });
  reservation.release();
});

test('remote JSON boundary rejects values that serialization would silently alter', async t => {
  let calls = 0;
  const { runtime, request } = await fixture(t, () => { calls++; return 'null'; });
  const hidden = Object.defineProperty({}, 'hidden', { value: true });
  const circular = {}; circular.self = circular;
  for (const input of [{ value: undefined }, { value: Array(1) }, hidden, circular]) {
    const reservation = runtime.reserveRun(), outcome = await reservation.execute(request(input));
    assert.equal(outcome.ok, false);
    assert.equal(outcome.error.kind, 'invalid-request');
    reservation.release();
  }
  assert.equal(calls, 0);
});
