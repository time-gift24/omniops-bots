import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { FakeToolCallingModel } from 'langchain';
import { createDesktopRuntime } from '../runtime.mjs';
import { chatInput, httpUrl } from '../input.mjs';
import { embeddedBrowserConfig, selectBrowserTarget } from '../browser-target.mjs';
import { safeError } from '../errors.mjs';

const call = (id, args = {}) => ({ id, name: 'inspect_browser', args });
const request = { messages: [{ role: 'user', text: '检查浏览器' }] };
async function until(check) {
  for (let i = 0; i < 500; i++) { const value = check(); if (value) return value; await delay(10); }
  throw new Error('Timed out waiting for runtime state');
}

function fixture(toolCalls, options = {}) {
  const events = [], inspected = [], navigated = [], models = [];
  const model = options.model ?? new FakeToolCallingModel({ toolCalls });
  const files = new Map();
  const workspace = {
    async list() { return [...files.values()]; },
    async save({ name, code }) { const value = { name, code, sha256: createHash('sha256').update(code).digest('hex') }; files.set(name, value); return value; },
    async read(name) { if (!files.has(name)) throw new Error('missing'); return files.get(name); },
    async run({ name, sha256 }) { const source = await this.read(name); assert.equal(source.sha256, sha256); return { status: 'passed', stdout: '', stderr: '', result: { verified: true } }; },
  };
  const browser = {
    getState: () => ({ url: options.browserUrl ?? '', title: '浏览器未打开', status: 'empty', canGoBack: false, canGoForward: false }),
    subscribe() {}, refresh: async () => {}, close: async () => {},
    async inspect(args, signal) { inspected.push(args); return options.inspect ? options.inspect(args, signal) : { title: 'Fixture', url: args.url ?? '' }; },
    async navigation(method, url) { navigated.push({ method, url }); },
  };
  const runtime = createDesktopRuntime({ browser, workspace, modelName: 'fixture', modelFactory: name => { models.push(name); return model; }, emit: event => events.push(event), getAgent: options.getAgent });
  const start = (id = 'run-1', extra = {}) => runtime.dispatch('chat_start', { runId: id, threadId: 'agent-test:test', request, ...extra });
  const approval = () => runtime.getState().task?.phase === 'awaiting-approval' && runtime.getState().task.approval;
  const decide = decision => runtime.dispatch('decide', { runId: runtime.getState().task.runId, approvalId: approval().id, decision });
  return { runtime, events, inspected, navigated, models, workspace, start, approval, decide };
}

test('pending approval owns the slot, auto-reveals first, accepts once, and releases only at completion', async () => {
  const f = fixture([[call('inspect-1', { url: 'https://example.com/' })], []]);
  try {
    assert.deepEqual(f.start(), { runId: 'run-1' });
    assert.equal(f.runtime.getState().task.runId, 'run-1');
    const approval = await until(f.approval);
    assert.equal(f.inspected.length, 0);
    assert.throws(() => f.start('run-2'), /另一项任务/);
    for (const method of ['navigate', 'back', 'forward', 'reload']) await assert.rejects(f.runtime.dispatch(method, { url: 'https://example.com' }), /先停止/);
    const snapshots = f.events.filter(event => event.event === 'desktop_state');
    const reveal = snapshots.findIndex(event => event.state.browserRequest === 1);
    const pending = snapshots.findIndex(event => event.state.task?.phase === 'awaiting-approval');
    assert.ok(reveal < pending);
    assert.equal(approval.callId, 'inspect-1');
    await assert.rejects(f.runtime.dispatch('decide', { runId: 'old', approvalId: approval.id, decision: 'approve' }), /失效/);
    const decisions = await Promise.allSettled([f.decide('approve'), f.decide('approve')]);
    assert.equal(decisions.filter(result => result.status === 'fulfilled').length, 1);
    await until(() => f.runtime.getState().task === null);
    assert.equal(f.inspected.length, 1);
    const terminal = f.events.filter(event => event.event === 'chat_event' && ['completed', 'failed'].includes(event.data.type));
    assert.equal(terminal.length, 1);
    assert.equal(terminal[0].data.type, 'completed');
    const tools = terminal[0].data.response.assistant.parts.filter(part => part.type === 'tool-call');
    assert.equal(tools.length, 1);
    assert.equal(tools[0].call.callId, 'inspect-1');
    await f.runtime.dispatch('navigate', { url: 'example.com' });
    assert.equal(f.navigated[0].url, 'https://example.com/');
  } finally { await f.runtime.close(); }
});

test('stop while awaiting approval terminally invalidates the run without resuming the graph', async () => {
  const f = fixture([[call('pending')], []]);
  try {
    f.start(); const pending = await until(f.approval);
    await f.runtime.dispatch('stop', { runId: 'run-1' });
    assert.equal(f.runtime.getState().task, null);
    assert.equal(f.inspected.length, 0);
    await assert.rejects(f.runtime.dispatch('decide', { runId: 'run-1', approvalId: pending.id, decision: 'approve' }), /失效/);
    assert.equal(f.events.filter(event => event.data?.type === 'failed' && event.data.error.kind === 'aborted').length, 1);
  } finally { await f.runtime.close(); }
});

test('stop acknowledgement waits for an executing tool to drain and stale stop cannot cancel another run', async () => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const f = fixture([[call('slow')], []], { inspect: async () => { entered.resolve(); await release.promise; return { title: 'Finished' }; } });
  try {
    f.start(); await until(f.approval); await f.decide('approve'); await entered.promise;
    let stopped = false;
    const stopping = f.runtime.dispatch('stop', { runId: 'run-1' }).then(() => { stopped = true; });
    await delay(30);
    assert.equal(stopped, false);
    assert.equal(f.runtime.getState().task.phase, 'stopping');
    assert.throws(() => f.start('run-2'), /另一项任务/);
    release.resolve(); await stopping;
    f.start('run-2');
    await assert.rejects(f.runtime.dispatch('stop', { runId: 'run-1' }), /当前任务/);
    assert.equal(f.runtime.getState().task.runId, 'run-2');
  } finally { release.resolve(); await f.runtime.close(); }
});

test('reject affects only its operation; identical retry is auto-rejected and a different plan requires new approval', async () => {
  const f = fixture([[call('first', { url: 'https://example.com/' })], [call('same', { url: 'https://example.com/' })], [call('alternate', {})], []]);
  try {
    f.start(); await until(f.approval); await f.decide('reject');
    const next = await until(() => f.approval()?.callId === 'alternate' && f.approval());
    assert.equal(next.title, '读取当前网页');
    assert.equal(f.runtime.getState().browserRequest, 2);
    assert.equal(f.inspected.length, 0);
    await f.decide('approve'); await until(() => f.runtime.getState().task === null);
    assert.deepEqual(f.inspected, [{}]);
  } finally { await f.runtime.close(); }
});

test('script source changes cannot be approved and rejection can recover', async () => {
  const f = fixture([]);
  const saved = await f.workspace.save({ name: 'proof.mjs', code: 'export default async()=>({ok:true})' });
  const model = new FakeToolCallingModel({ toolCalls: [[{ id: 'script', name: 'run_playwright_script', args: { name: saved.name, sha256: saved.sha256 } }], []] });
  const g = fixture([], { model, browserUrl: 'https://previous-page.test/' });
  await g.workspace.save({ name: saved.name, code: saved.code });
  try {
    g.start(); await until(g.approval);
    assert.equal(g.approval().targetUrl, undefined);
    await g.workspace.save({ name: saved.name, code: 'export default async()=>({changed:true})' });
    await assert.rejects(g.decide('approve'), /源码已改变/);
    assert.equal(g.runtime.getState().task.phase, 'awaiting-approval');
    await g.decide('reject'); await until(() => g.runtime.getState().task === null);
  } finally { await f.runtime.close(); await g.runtime.close(); }
});

test('delegated and sibling browser calls retain per-call approval and execute only the approved call', async () => {
  const f = fixture([
    [{ id: 'delegate', name: 'task', args: { description: 'Inspect two pages', subagent_type: 'general-purpose' } }],
    [call('allow', { url: 'https://allowed.test/' }), call('deny', { url: 'https://denied.test/' })], [], [],
  ]);
  try {
    f.start();
    const seen = [];
    for (let index = 0; index < 2; index++) {
      const approval = await until(() => f.approval() && !seen.includes(f.approval().callId) && f.approval());
      seen.push(approval.callId);
      await f.decide(approval.callId === 'allow' ? 'approve' : 'reject');
    }
    await until(() => f.runtime.getState().task === null);
    assert.deepEqual(seen.toSorted(), ['allow', 'deny']);
    assert.deepEqual(f.inspected, [{ url: 'https://allowed.test/' }]);
  } finally { await f.runtime.close(); }
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
  assert.throws(() => embeddedBrowserConfig({ COGNACTA_BROWSER_CDP_ENDPOINT: 'https://remote.test', COGNACTA_BROWSER_TARGET_ID: 'x' }), /loopback/);
  const page = { isClosed: () => false };
  const browser = { contexts: () => [{ pages: () => [page], newCDPSession: async () => ({ send: async () => ({ targetInfo: { targetId: 'real' } }), detach: async () => {} }) }] };
  await assert.rejects(selectBrowserTarget(browser, 'wrong'), /refusing to select another page/);
  assert.equal((await selectBrowserTarget(browser, 'real')).page, page);
});
