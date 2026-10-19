import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { chmod, lstat, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { FakeToolCallingModel } from 'langchain';
import { MemorySaver } from '@langchain/langgraph';
import { openSqliteCheckpointer } from '../execution/sqlite.ts';
import { createDesktopRuntime } from '../runtime.mjs';
import { createResources } from '../resources.mjs';
import { createRunRecords } from '../execution/records.ts';
import { storageId, writeJson } from '../json-store.mjs';
import { chatRecord } from '../chat/adapter.mjs';
import { chatInput, httpUrl } from '../input.mjs';
import { embeddedBrowserConfig, selectBrowserTarget } from '../browser/browser-target.mjs';
import { safeError } from '../errors.mjs';

const call = (id, args = {}) => ({ id, name: 'inspect_browser', args });
const request = { messages: [{ role: 'user', text: '检查浏览器' }] };
async function until(check) {
  for (let i = 0; i < 500; i++) { const value = await check(); if (value) return value; await delay(10); }
  throw new Error('Timed out waiting for runtime state');
}
async function writable(directory) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) return;
  await chmod(directory, 0o700);
  for (const entry of await readdir(directory)) await writable(join(directory, entry));
}

async function fixture(t, toolCalls = [], options = {}) {
  const homeDir = await mkdtemp(join(tmpdir(), 'omniops-bots-runtime-test-'));
  const runsDir = join(homeDir, 'runs');
  const events = [], inspected = [], navigated = [], models = [], modelInputs = [], terminalRecords = [];
  const files = new Map();
  const workspace = {
    async list() { return [...files.values()]; },
    async save({ name, code }) { const value = { name, code, sha256: createHash('sha256').update(code).digest('hex') }; files.set(name, value); return value; },
    async read(name) { if (!files.has(name)) throw new Error('missing'); return files.get(name); },
    async run({ name, sha256 }) { const source = await this.read(name); assert.equal(source.sha256, sha256); return { status: 'passed', stdout: '', stderr: '', result: { verified: true } }; },
  };
  const browser = {
    getState: () => ({ url: '', title: '浏览器未打开', status: 'empty', canGoBack: false, canGoForward: false }),
    subscribe() {}, refresh: async () => {}, close: async () => {},
    async inspect(args, signal) { inspected.push(args); return options.inspect ? options.inspect(args, signal) : { title: 'Fixture', url: args.url ?? '' }; },
    async navigation(method, url) { navigated.push({ method, url }); },
  };
  class Model extends FakeToolCallingModel {
    bindTools(tools) {
      const bound = new Model({ toolCalls: this.toolCalls, toolStyle: this.toolStyle, structuredResponse: this.structuredResponse, indexRef: this.indexRef });
      bound.tools = [...this.tools, ...tools];
      return bound;
    }
    async _generate(messages, ...args) {
      modelInputs.push(messages);
      await options.beforeGenerate?.({ messages, index: this.index, run: models.length });
      const result = await super._generate(messages, ...args);
      // A new model instance must not reuse IDs from a persisted conversation.
      result.generations[0].message.id = randomUUID();
      return result;
    }
  }
  let resources, runtime, checkpoints;
  const settings = { modelName: 'fixture', timeoutMs: options.timeoutMs, ...options.runtime };
  async function open(overrides = {}) {
    Object.assign(settings, overrides);
    resources = createResources({ homeDir, runsDir });
    if (options.persistent) checkpoints = await openSqliteCheckpointer(join(homeDir, 'checkpoints.sqlite'));
    runtime = await createDesktopRuntime({ browser, workspace, resources, runsDir, checkpointer: checkpoints?.checkpointer ?? new MemorySaver(), ...settings,
      modelFactory: name => { models.push(name); return new Model({ toolCalls: options.callsForRun?.(models.length) ?? toolCalls }); },
      emit: event => {
        events.push(event);
        if (event.event === 'chat_event' && ['completed', 'failed'].includes(event.data.type)) {
          try { terminalRecords.push(chatRecord(JSON.parse(readFileSync(join(runsDir, '.records', `${storageId(event.runId)}.json`), 'utf8')))); }
          catch (error) { terminalRecords.push(error); }
        }
      },
    });
  }
  t.after(async () => { await runtime?.close(); await checkpoints?.close(); await writable(homeDir); await rm(homeDir, { recursive: true, force: true }); });
  await open();
  const start = (id = 'run-1', extra = {}) => runtime.dispatch('chat_start', { runId: id, threadId: 'agent-test:test', request, ...extra });
  return {
    get runtime() { return runtime; }, get resources() { return resources; }, get checkpoints() { return checkpoints; },
    homeDir, runsDir, events, inspected, navigated, models, modelInputs, terminalRecords, workspace, start,
    async reopen(overrides) { await runtime.close(); await checkpoints?.close(); await open(overrides); },
    async settled(id = 'run-1') { await until(() => runtime.getState().task === null); return runtime.dispatch('run_get', { runId: id }); },
  };
}

test('tools execute without approval, busy owns the slot and completion is durable before its event', async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const f = await fixture(t, [[call('inspect-1', { url: 'https://example.com/' })], []], {
    inspect: async () => { entered.resolve(); await release.promise; return { title: 'Fixture' }; },
  });
  try {
    assert.deepEqual(f.start(), { runId: 'run-1' });
    assert.equal(f.runtime.getState().task.phase, 'preparing');
    assert.throws(() => f.start('run-2'), /另一项任务/);
    await entered.promise;
    assert.equal(f.runtime.getState().task.phase, 'running');
    for (const method of ['navigate', 'back', 'forward', 'reload']) await assert.rejects(f.runtime.dispatch(method, { url: 'https://example.com' }), /先停止/);
    assert.throws(() => f.runtime.dispatch('decide', { decision: 'approve' }), /不支持/);
    assert.equal(f.runtime.getState().browserRequest, 1);
    assert.equal(f.events.some(event => event.state?.task?.approval || event.state?.task?.phase === 'awaiting-approval'), false);
    release.resolve();
    const record = await f.settled();
    assert.equal(record.status, 'completed', JSON.stringify(record.error));
    assert.ok(record.startedAt <= record.endedAt);
    assert.equal(f.inspected.length, 1);
    const terminal = f.events.filter(event => event.event === 'chat_event' && ['completed', 'failed'].includes(event.data.type));
    assert.equal(terminal.length, 1);
    assert.equal(terminal[0].data.type, 'completed');
    assert.deepEqual(f.terminalRecords[0].result, terminal[0].data.response);
    assert.equal(f.terminalRecords[0].status, 'completed');
    assert.equal(record.events.at(-1).type, 'completed');
    const tools = record.result.assistant.parts.filter(part => part.type === 'tool-call');
    assert.equal(tools.length, 1);
    assert.equal(tools[0].call.callId, 'inspect-1');
    assert.deepEqual(tools[0].call.output, { title: 'Fixture' });
    assert.throws(() => f.start(), error => error.kind === 'duplicate-run');
    await f.runtime.dispatch('navigate', { url: 'example.com' });
    assert.deepEqual(f.navigated, [{ method: 'navigate', url: 'https://example.com/' }]);
  } finally { release.resolve(); }
});

test('chat uses persistent native checkpoints while every explicit continuation gets a fresh graph identity', async t => {
  const f = await fixture(t, [], { persistent: true, callsForRun: index => index === 1 ? [[call('persistent-once')], []] : [] });
  f.start('sqlite-first');
  const first = await f.settled('sqlite-first');
  assert.equal(first.status, 'completed', JSON.stringify(first.error));
  assert.notEqual(first.graphThreadId, first.threadId);
  const saved = await f.checkpoints.checkpointer.getTuple({ configurable: { thread_id: first.graphThreadId } });
  assert.ok(saved.checkpoint.channel_values.messages.some(message => message.tool_call_id === 'persistent-once'));
  await f.reopen();
  const reopened = await f.checkpoints.checkpointer.getTuple({ configurable: { thread_id: first.graphThreadId } });
  assert.equal(reopened.checkpoint.id, saved.checkpoint.id);
  f.start('sqlite-continued');
  const continued = await f.settled('sqlite-continued');
  assert.equal(continued.status, 'completed', JSON.stringify(continued.error));
  assert.notEqual(continued.graphThreadId, first.graphThreadId);
  assert.equal(f.inspected.length, 1, 'saved graph tasks must never replay on continuation');
});

test('stop during preparation persists cancellation without invoking the model or browser', async t => {
  const f = await fixture(t, [[call('must-not-run')], []]);
  f.start();
  assert.deepEqual(await f.runtime.dispatch('stop', { runId: 'run-1' }), { stopped: true });
  const record = await f.settled();
  assert.equal(record.status, 'cancelled');
  assert.equal(record.error.kind, 'aborted');
  assert.equal(f.models.length, 0);
  assert.equal(f.inspected.length, 0);
  assert.equal(f.events.filter(event => event.data?.type === 'failed').length, 1);
  assert.throws(() => f.start(), error => error.kind === 'duplicate-run');
});

test('stop acknowledgement waits for tool drain and stale stop cannot cancel the next run', async t => {
  const releases = [Promise.withResolvers(), Promise.withResolvers()];
  let entered = 0;
  const f = await fixture(t, [[call('slow')], []], {
    inspect: async () => { const pending = releases[entered++]; await pending.promise; return { title: 'Finished' }; },
  });
  try {
    f.start(); await until(() => entered === 1);
    let stopped = false;
    const stopping = f.runtime.dispatch('stop', { runId: 'run-1' }).then(() => { stopped = true; });
    await delay(30);
    assert.equal(stopped, false);
    assert.equal(f.runtime.getState().task.phase, 'stopping');
    assert.throws(() => f.start('run-2'), /另一项任务/);
    releases[0].resolve(); await stopping;
    assert.equal((await f.settled()).status, 'cancelled');
    f.start('run-2'); await until(() => entered === 2);
    await assert.rejects(f.runtime.dispatch('stop', { runId: 'run-1' }), /当前任务/);
    assert.equal(f.runtime.getState().task.runId, 'run-2');
    releases[1].resolve();
    assert.equal((await f.settled('run-2')).status, 'completed');
    assert.equal(f.events.filter(event => event.data?.type === 'failed' && event.data.error.kind === 'aborted').length, 1);
  } finally { for (const release of releases) release.resolve(); }
});

test('the whole-run deadline aborts work once and persists the distinct timeout outcome', async t => {
  let aborted = false;
  const f = await fixture(t, [[call('timeout')], []], { timeoutMs: 250, inspect: async (_args, signal) => {
    signal.throwIfAborted();
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true }));
  } });
  f.start();
  const record = await f.settled();
  assert.equal(aborted, true);
  assert.equal(record.status, 'timed-out');
  assert.equal(record.error.kind, 'timeout');
  assert.equal(f.models.length, 1);
  assert.equal(f.inspected.length, 1);
  assert.equal(f.events.filter(event => event.data?.type === 'failed').length, 1);
  assert.equal(f.terminalRecords[0].status, 'timed-out');
});

function assertTerminationContext(messages, { requestText, evidence, status, reason, pendingCall }) {
  const users = messages.filter(message => message.getType() === 'human');
  assert.equal(users.filter(message => message.content === requestText).length, 1, 'the terminated request must survive exactly once');
  const summaries = messages.filter(message => message.getType() === 'ai').map(message => JSON.stringify(message.content));
  const summary = summaries.find(value => value.includes(evidence) && value.includes(status));
  assert.ok(summary, 'continuation must include the confirmed tool result and terminal status');
  assert.ok(summary.includes(reason), 'continuation must include the actual terminal reason');
  if (pendingCall) {
    assert.ok(summary.includes(pendingCall));
    assert.match(summary, /未知|unknown/iu, 'an unfinished call must be recorded as an unknown outcome');
  }
  assert.equal(messages.some(message => message.getType() === 'ai' && message.tool_calls?.length), false, 'termination recovery must not restore pending graph tasks');
}

test('a model failure after a completed operation preserves its request, evidence and reason across restart', async t => {
  const requestText = 'FAILED_REQUEST_CONTEXT_MARKER', evidence = 'CONFIRMED_BEFORE_MODEL_FAILURE';
  const f = await fixture(t, [], {
    callsForRun: run => run === 1 ? [[call('completed-before-failure')], []] : [],
    beforeGenerate: ({ run, index }) => { if (run === 1 && index === 1) throw new Error('fixture model failed after the completed action'); },
    inspect: async () => ({ receipt: evidence }),
  });
  f.start('failed-with-evidence', { request: { messages: [{ role: 'user', text: requestText }] } });
  const failed = await f.settled('failed-with-evidence');
  assert.equal(failed.status, 'failed');
  assert.equal(f.inspected.length, 1);
  assert.ok(JSON.stringify(failed.events).includes(evidence));
  await f.reopen();
  f.start('after-model-failure', { request: { messages: [{ role: 'user', text: 'Explain the previous result without performing it again.' }] } });
  assert.equal((await f.settled('after-model-failure')).status, 'completed');
  assertTerminationContext(f.modelInputs.at(-1), { requestText, evidence, status: failed.status, reason: failed.error.message });
  assert.equal(f.inspected.length, 1, 'continuing the conversation must not replay the completed action');
});

test('history committed before an interrupted terminal record retains work and adds the later outcome once', async t => {
  const requestText = 'BEFORE_TERMINAL_COMMIT', evidence = 'COMMITTED_ACTION';
  const f = await fixture(t, [], { callsForRun: run => run === 1 ? [[call('committed-tool')], []] : [], inspect: async () => ({ receipt: evidence }) });
  f.start('commit-gap', { request: { messages: [{ role: 'user', text: requestText }] } });
  assert.equal((await f.settled('commit-gap')).status, 'completed');
  await f.runtime.close();
  const path = join(f.runsDir, '.records', `${storageId('commit-gap')}.json`);
  const record = JSON.parse(await readFile(path, 'utf8'));
  // A crash after history commit but before terminal commit leaves a running record.
  record.status = 'running'; delete record.endedAt;
  await writeJson(path, record);
  await f.reopen();
  f.start('after-commit-gap');
  assert.equal((await f.settled('after-commit-gap')).status, 'completed');
  const messages = f.modelInputs.at(-1);
  assert.equal(messages.filter(message => message.getType() === 'human' && message.content === requestText).length, 1);
  assert.equal(messages.filter(message => message.getType() === 'tool' && message.tool_call_id === 'committed-tool').length, 1);
  const summaries = messages.filter(message => message.getType() === 'ai' && typeof message.content === 'string' && message.content.startsWith('运行时终止记录'));
  assert.equal(summaries.length, 1);
  assert.ok(summaries[0].content.includes('interrupted'));
  assert.ok(summaries[0].content.includes(evidence));
  assert.equal(f.inspected.length, 1);
});

test('history storage failure after an action reports storage and never suggests repeating the task', async t => {
  let f;
  f = await fixture(t, [[call('before-storage-failure')], []], { beforeGenerate: async ({ index }) => {
    if (index !== 1) return;
    const sessions = join(f.runsDir, '.sessions');
    await rename(sessions, sessions + '-preserved');
    await writeFile(sessions, 'blocked history directory');
  } });
  f.start('storage-failure');
  const failed = await f.settled('storage-failure');
  assert.equal(f.inspected.length, 1);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error.kind, 'storage');
  assert.match(failed.error.message, /不要直接重跑/u);
  const terminal = f.events.findLast(event => event.event === 'chat_event');
  assert.equal(terminal.data.error.kind, 'storage');
  assert.match(terminal.data.error.message, /不要直接重跑/u);
});

test('cancelling a later operation preserves completed evidence and marks the in-flight outcome unknown', async t => {
  const requestText = 'CANCELLED_REQUEST_CONTEXT_MARKER', evidence = 'CONFIRMED_BEFORE_CANCELLATION';
  const entered = Promise.withResolvers();
  const f = await fixture(t, [], {
    callsForRun: run => run === 1 ? [[call('completed-before-stop', { url: 'https://completed.example/' })], [call('pending-at-stop', { url: 'https://pending.example/' })], []] : [],
    inspect: async ({ url }, signal) => {
      if (url === 'https://completed.example/') return { receipt: evidence };
      entered.resolve();
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    },
  });
  f.start('cancelled-with-evidence', { request: { messages: [{ role: 'user', text: requestText }] } });
  await entered.promise;
  await f.runtime.dispatch('stop', { runId: 'cancelled-with-evidence' });
  const cancelled = await f.settled('cancelled-with-evidence');
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(f.inspected.length, 2);
  await f.reopen();
  f.start('after-cancellation', { request: { messages: [{ role: 'user', text: 'Summarize what completed and what remains unknown.' }] } });
  assert.equal((await f.settled('after-cancellation')).status, 'completed');
  assertTerminationContext(f.modelInputs.at(-1), { requestText, evidence, status: cancelled.status, reason: cancelled.error.message, pendingCall: 'https://pending.example/' });
  assert.equal(f.inspected.length, 2, 'neither completed nor interrupted calls may be replayed');
});

test('startup restores interrupted context from the last durable tool events without replaying graph tasks', async t => {
  const requestText = 'INTERRUPTED_REQUEST_CONTEXT_MARKER', evidence = 'DURABLE_RESULT_BEFORE_PROCESS_EXIT';
  const entered = Promise.withResolvers();
  const f = await fixture(t, [], {
    callsForRun: run => run === 1 ? [[call('durable-completed', { url: 'https://completed.example/' })], [call('durable-pending', { url: 'https://pending.example/' })], []] : [],
    inspect: async ({ url }, signal) => {
      if (url === 'https://completed.example/') return { receipt: evidence };
      entered.resolve();
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    },
  });
  f.start('process-interrupted', { request: { messages: [{ role: 'user', text: requestText }] } });
  await entered.promise;
  const recordFile = join(f.runsDir, '.records', `${storageId('process-interrupted')}.json`);
  const sessionFile = join(f.runsDir, '.sessions', `${storageId('agent-test:test')}.json`);
  const running = await until(async () => {
    const record = JSON.parse(await readFile(recordFile, 'utf8'));
    const saved = JSON.stringify(record.details.events);
    return saved.includes(evidence) && saved.includes('https://pending.example/') ? record : undefined;
  });
  assert.equal(running.status, 'running');
  const session = JSON.parse(await readFile(sessionFile, 'utf8'));
  // Restore the actual on-disk state captured while running, as if the process
  // exited before its terminal save. This keeps the fixture in one process.
  await f.runtime.dispatch('stop', { runId: 'process-interrupted' });
  await f.runtime.close();
  await writeJson(recordFile, running);
  await writeJson(sessionFile, session);
  const modelCount = f.models.length, actionCount = f.inspected.length;
  await f.reopen();
  assert.equal(f.models.length, modelCount);
  assert.equal(f.inspected.length, actionCount);
  const interrupted = f.runtime.dispatch('run_get', { runId: 'process-interrupted' });
  assert.equal(interrupted.status, 'interrupted');
  f.start('after-process-exit', { request: { messages: [{ role: 'user', text: 'Explain the interrupted task without retrying.' }] } });
  assert.equal((await f.settled('after-process-exit')).status, 'completed');
  assertTerminationContext(f.modelInputs.at(-1), { requestText, evidence, status: interrupted.status, reason: interrupted.error.message, pendingCall: 'https://pending.example/' });
  assert.equal(f.inspected.length, actionCount);
  await f.reopen();
  f.start('after-process-exit-again', { request: { messages: [{ role: 'user', text: 'Continue discussing the saved result.' }] } });
  assert.equal((await f.settled('after-process-exit-again')).status, 'completed');
  const history = f.modelInputs.at(-1);
  assert.equal(history.filter(message => message.getType() === 'human' && message.content === requestText).length, 1);
  assert.equal(history.filter(message => message.getType() === 'ai' && typeof message.content === 'string' && message.content.startsWith('运行时终止记录') && message.content.includes('process-interrupted')).length, 1);
  assert.equal(f.inspected.length, actionCount);
});

test('a session keeps its Agent, full Skill files and model snapshot across edits and restart', async t => {
  const f = await fixture(t, []);
  const skill = await f.resources.handle('skill_library_create', { name: 'fixed-package', description: 'Snapshot fixture.' });
  const write = (path, value) => f.resources.handle('skill_library_write', { id: skill.id, path, data: Buffer.from(value).toString('base64'), replace: true });
  await write('SKILL.md', '---\nname: fixed-package\ndescription: Snapshot fixture.\n---\nOriginal Skill instructions.\n');
  await write('reference.bin', Buffer.from([0, 19, 255]));
  const { agents } = await f.resources.handle('agents_load');
  const configuration = { ...agents[0].configuration, instructions: 'Original Agent instructions.', skillIds: [skill.id] };
  const agent = await f.resources.handle('agent_create', { configuration });
  f.start('first', { agentId: agent.id });
  const first = await f.settled('first');
  assert.equal(first.status, 'completed');
  const snapshot = await f.runtime.dispatch('session_snapshot', { threadId: first.threadId });
  assert.equal(snapshot.agent.id, agent.id);
  assert.equal(snapshot.model, 'fixture');
  assert.deepEqual(snapshot.modelParameters, { temperature: 0 });
  assert.deepEqual(await readFile(join(snapshot.directory, snapshot.skills[0].mountPath.slice(1), 'reference.bin')), Buffer.from([0, 19, 255]));
  await write('reference.bin', Buffer.from([4, 5, 6]));
  await f.resources.handle('agent_save', { id: agent.id, configuration: { ...configuration, instructions: 'Changed Agent instructions.' } });
  await f.reopen({ modelName: 'later-model', desktopVersion: '9.0.0', modelParameters: { temperature: 0.8 } });
  f.start('continued', { agentId: agent.id, request: { messages: [{ role: 'user', text: 'Continue the original session.' }] } });
  const continued = await f.settled('continued');
  assert.equal(continued.status, 'completed');
  assert.deepEqual(continued.snapshot, snapshot);
  assert.deepEqual(f.models, ['fixture', 'fixture']);
  assert.equal(f.modelInputs.at(-1).some(message => JSON.stringify(message.content).includes('Original Agent instructions.')), true);
  assert.equal(f.modelInputs.at(-1).some(message => JSON.stringify(message.content).includes('Changed Agent instructions.')), false);
  assert.deepEqual(await readFile(join(snapshot.directory, snapshot.skills[0].mountPath.slice(1), 'reference.bin')), Buffer.from([0, 19, 255]));
  f.start('new-session', { threadId: 'fresh', agentId: agent.id });
  const next = await f.settled('new-session');
  assert.equal(next.status, 'completed');
  assert.equal(next.snapshot.agent.configuration.instructions, 'Changed Agent instructions.');
  assert.equal(next.snapshot.model, 'later-model');
  assert.notEqual(next.snapshot.skills[0].contentId, snapshot.skills[0].contentId);
});

test('a missing assembly cannot silently replace an existing session with edited Skill bytes', async t => {
  const f = await fixture(t, [[call('would-run-after-drift')], []]);
  const skill = await f.resources.handle('skill_library_create', { name: 'drift-fixture', description: 'Retain this exact package.' });
  const write = value => f.resources.handle('skill_library_write', { id: skill.id, path: 'reference.txt', data: Buffer.from(value).toString('base64'), replace: true });
  await write('ORIGINAL_ASSEMBLY_BYTES');
  const { agents } = await f.resources.handle('agents_load');
  const agent = await f.resources.handle('agent_create', { configuration: { ...agents[0].configuration, skillIds: [skill.id] } });
  f.start('before-assembly-loss', { agentId: agent.id });
  const first = await f.settled('before-assembly-loss');
  assert.equal(first.status, 'completed');
  const snapshot = first.snapshot;
  await writable(snapshot.directory);
  await rm(snapshot.directory, { recursive: true });
  await write('CHANGED_ASSEMBLY_BYTES');
  await f.reopen();
  const modelCount = f.models.length, actionCount = f.inspected.length;
  f.start('after-assembly-loss', { agentId: agent.id });
  const rejected = await f.settled('after-assembly-loss');
  assert.equal(rejected.status, 'failed');
  assert.match(rejected.error.message, /快照|装配/u);
  assert.equal(f.models.length, modelCount, 'assembly identity drift must fail before model creation');
  assert.equal(f.inspected.length, actionCount, 'assembly identity drift must fail before browser calls');
  assert.equal(f.events.some(event => event.runId === 'after-assembly-loss' && event.data?.type === 'started'), false);
  assert.deepEqual(await f.runtime.dispatch('session_snapshot', { threadId: first.threadId }), snapshot, 'the historical session identity must remain unchanged');
});

test('restart retains terminal results, marks unfinished runs interrupted and never replays prior actions', async t => {
  const f = await fixture(t, [], { callsForRun: index => index === 1 ? [[call('once')], []] : [] });
  f.start('completed');
  const completed = await f.settled('completed');
  assert.equal(completed.status, 'completed', JSON.stringify(completed.error));
  const records = await createRunRecords(f.runsDir);
  for (const status of ['preparing', 'running']) await records.save({
    runId: status, threadId: `interrupted-${status}`, graphThreadId: `graph-${status}`, status,
    startedAt: new Date().toISOString(), details: { title: 'Interrupted fixture', inputMessages: [{ role: 'user', text: 'Do not replay.' }], events: [] },
  });
  const calls = f.models.length, actions = f.inspected.length, events = f.events.length;
  await f.reopen();
  assert.equal(f.models.length, calls);
  assert.equal(f.inspected.length, actions);
  assert.equal(f.events.length, events);
  assert.equal(f.runtime.getState().task, null);
  assert.deepEqual(f.runtime.dispatch('run_get', { runId: 'completed' }), completed);
  for (const runId of ['preparing', 'running']) {
    const recovered = f.runtime.dispatch('run_get', { runId });
    assert.equal(recovered.status, 'interrupted');
    assert.equal(recovered.error.kind, 'interrupted');
    assert.match(recovered.error.message, /执行中断、结果未知/);
    assert.equal(recovered.events.filter(event => event.type === 'failed').length, 1);
    assert.throws(() => f.start(runId), error => error.kind === 'duplicate-run');
  }
  assert.throws(() => f.start('completed'), error => error.kind === 'duplicate-run');
  f.start('continue', { request: { messages: [{ role: 'user', text: 'Summarize the previous result.' }] } });
  assert.equal((await f.settled('continue')).status, 'completed');
  assert.equal(f.inspected.length, 1);
  const conversation = f.modelInputs.at(-1);
  assert.equal(conversation.filter(message => message.getType() === 'tool' && message.tool_call_id === 'once').length, 1);
  await f.reopen();
  assert.equal(f.runtime.dispatch('run_get', { runId: 'running' }).events.filter(event => event.type === 'failed').length, 1);
});

test('input history/instructions/model and supported attachments survive without silent loss', () => {
  const input = chatInput({ messages: [{ role: 'user', text: 'current', attachments: [{ name: 'notes.txt', mediaType: 'text/plain', data: Buffer.from('事实').toString('base64') }] }], history: [{ role: 'user', text: 'before' }, { role: 'assistant', text: 'answer' }], instructions: 'be concise', model: 'fixture' }, 'fixture');
  assert.deepEqual(input.messages.slice(0, 2), [{ role: 'user', content: 'before' }, { role: 'assistant', content: 'answer' }]);
  assert.equal(input.instructions, 'be concise');
  assert.match(input.messages[2].content[1].text, /事实/);
  assert.throws(() => chatInput({ ...request, model: 'other' }, 'fixture'), /未配置/);
  assert.throws(() => chatInput({ messages: [{ role: 'user', text: 'x', attachments: [{ name: 'a.pdf', mediaType: 'application/pdf', data: '' }] }] }, 'fixture'), /暂不支持/);
  assert.throws(() => chatInput({ messages: [{ role: 'user', text: 'x', attachments: [{ name: 'a.txt', mediaType: 'text/plain', data: '!!!' }] }] }, 'fixture'), /附件内容/);
  assert.throws(() => httpUrl('https://user:secret@example.com'), /登录信息/);
  assert.throws(() => httpUrl('file:///etc/passwd'), /HTTP/);
  assert.deepEqual(safeError(new Error('API key secret')), { kind: 'unknown', message: '本地执行失败，请检查配置或重试。' });
});

test('browser configuration and target selection never fall back to another page', async () => {
  assert.throws(() => embeddedBrowserConfig({}), /provided together/);
  assert.throws(() => embeddedBrowserConfig({ OMNIOPS_BOTS_BROWSER_CDP_ENDPOINT: 'https://remote.test', OMNIOPS_BOTS_BROWSER_TARGET_ID: 'x' }), /loopback/);
  const page = { isClosed: () => false };
  const browser = { contexts: () => [{ pages: () => [page], newCDPSession: async () => ({ send: async () => ({ targetInfo: { targetId: 'real' } }), detach: async () => {} }) }] };
  await assert.rejects(selectBrowserTarget(browser, 'wrong'), /refusing to select another page/);
  assert.equal((await selectBrowserTarget(browser, 'real')).page, page);
});
