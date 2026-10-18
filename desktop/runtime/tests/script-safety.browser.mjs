import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright-core';
import { ChatOpenAI } from '@langchain/openai';
import { createScriptWorkspace } from '../script-workspace.mjs';
import { createBrowserService } from '../browser.mjs';
import { createDesktopRuntime } from '../runtime.mjs';
import { createModelFixture } from './model-fixture.mjs';
import { setTimeout as delay } from 'node:timers/promises';

async function until(check) {
  for (let i = 0; i < 1000; i++) { const value = await check(); if (value) return value; await delay(10); }
  throw new Error('Timed out waiting for local browser test');
}

test('real CDP scripts retain source/hash, filesystem/process/network permissions, cancellation and target isolation', { timeout: 60_000 }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'cognacta-runtime-')));
  const fixture = await createModelFixture();
  let server, control, service, runtime;
  try {
    server = await chromium.launchServer({ channel: 'chromium', headless: true, args: ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1'] });
    const profile = server.process().spawnargs.find(arg => arg.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);
    const [port, path] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).trim().split('\n');
    const endpoint = `ws://127.0.0.1:${port}${path}`;
    control = await chromium.connectOverCDP(endpoint);
    const context = control.contexts()[0];
    const page = context.pages()[0] || await context.newPage();
    const session = await context.newCDPSession(page);
    const { targetInfo } = await session.send('Target.getTargetInfo');
    await session.detach();
    service = createBrowserService({ endpoint, targetId: targetInfo.targetId });
    const events = [];
    const workspace = await createScriptWorkspace({ dataDir: directory, ensureBrowser: service.ensure, signalEvent: event => events.push(event), redact: String });
    const forbidden = join(directory, 'credential.env');
    await writeFile(forbidden, 'must remain private');
    const source = await workspace.save({ name: 'safe.mjs', code: `import {readFile} from 'node:fs/promises';import {spawnSync} from 'node:child_process';export default async({page,parameters,assert})=>{await page.goto(parameters.url,{waitUntil:'domcontentloaded'});await page.getByRole('searchbox').fill('abcd');assert.equal(await page.getByRole('searchbox').inputValue(),'abcd');let fsDenied,childDenied;try{await readFile(parameters.forbidden)}catch(e){fsDenied=e.code}try{spawnSync('echo',['no'])}catch(e){childDenied=e.code}return {input:'abcd',fsDenied,childDenied,key:process.env.OPENAI_API_KEY??null,net:process.permission.has('net')}}` });
    await assert.rejects(workspace.run({ name: source.name, sha256: '0'.repeat(64) }), /源码已改变/);
    const result = await workspace.run({ name: source.name, sha256: source.sha256, parameters: { url: fixture.pageURL, forbidden } });
    assert.equal(result.status, 'passed', result.error);
    assert.deepEqual(result.result, { input: 'abcd', fsDenied: 'ERR_ACCESS_DENIED', childDenied: 'ERR_ACCESS_DENIED', key: null, net: false });
    assert.equal(await readFile(result.scriptPath, 'utf8'), source.code);
    assert.match(result.screenshot, /^data:image\/png;base64,/);
    assert.equal((await workspace.read(source.name)).lastRun.id, result.id);
    await assert.rejects(workspace.save({ name: '../outside.mjs', code: 'x' }), /flat script/);
    await symlink(forbidden, join(workspace.scriptsDir, 'linked.mjs'));
    await assert.rejects(workspace.read('linked.mjs'), /symlink/);
    await assert.rejects(workspace.run({ name: 'linked.mjs' }), /symlink/);
    await workspace.save({ name: 'linked.mjs', code: 'export default async()=>({ok:true})' });
    assert.equal(await readFile(forbidden, 'utf8'), 'must remain private');
    const loop = await workspace.save({ name: 'loop.mjs', code: 'export default async()=>{while(true){}}' });
    const controller = new AbortController();
    const before = events.length;
    const running = workspace.run({ name: loop.name, sha256: loop.sha256 }, controller.signal);
    const child = await until(() => events.slice(before).find(event => event.event === 'runner_started'));
    controller.abort();
    assert.equal((await running).status, 'cancelled');
    assert.throws(() => process.kill(child.pid, 0));
    const timeout = await workspace.run({ name: loop.name, sha256: loop.sha256, timeoutMs: 300 });
    assert.equal(timeout.status, 'timed_out');
    const other = await context.newPage();
    await other.goto('about:blank');
    assert.equal((await service.ensure()).page.url(), fixture.pageURL);
    const wrong = createBrowserService({ endpoint, targetId: 'missing' });
    await assert.rejects(wrong.ensure(), /目标页面/);
    await wrong.close();

    // Full protocol: only the model is synthetic; Deep Agents, HITL and Playwright are real.
    const chat = [];
    runtime = createDesktopRuntime({ browser: service, workspace, modelName: fixture.model, emit: event => chat.push(event), modelFactory: () => new ChatOpenAI({ model: fixture.model, apiKey: 'fixture-key', configuration: { baseURL: fixture.baseURL }, useResponsesApi: false, maxRetries: 0 }) });
    runtime.dispatch('chat_start', { runId: 'real-local', threadId: 'agent-test:local', request: { messages: [{ role: 'user', text: '填写本地搜索框，不提交' }] } });
    let approvals = 0;
    await until(async () => {
      const task = runtime.getState().task;
      if (!task) return true;
      if (task.phase === 'awaiting-approval') { approvals++; await runtime.dispatch('decide', { runId: task.runId, approvalId: task.approval.id, decision: 'approve' }); }
      return false;
    });
    assert.equal(approvals, 2);
    assert.equal(chat.findLast(event => event.event === 'chat_event').data.type, 'completed', JSON.stringify(chat.findLast(event => event.event === 'chat_event')));
    assert.equal(await page.getByRole('searchbox').inputValue(), 'abcd');
    assert.equal(new URL(page.url()).searchParams.has('q'), false);
    await runtime.dispatch('navigate', { url: `${fixture.pageURL}?second=1` });
    assert.equal(runtime.getState().browser.canGoBack, true);
    await runtime.dispatch('back');
    assert.equal(runtime.getState().browser.url, fixture.pageURL);
    assert.equal(runtime.getState().browser.canGoForward, true);
    await runtime.dispatch('forward');
    assert.equal(runtime.getState().browser.url, `${fixture.pageURL}?second=1`);

    runtime.dispatch('chat_start', { runId: 'reject-local', threadId: 'local', request: { messages: [{ role: 'user', text: '检查页面' }] } });
    const first = await until(() => runtime.getState().task?.phase === 'awaiting-approval' && runtime.getState().task.approval);
    await runtime.dispatch('decide', { runId: 'reject-local', approvalId: first.id, decision: 'reject' });
    const alternative = await until(() => runtime.getState().task?.phase === 'awaiting-approval' && runtime.getState().task.approval);
    assert.notEqual(first.id, alternative.id);
    assert.deepEqual(JSON.parse(alternative.parameters), {});
    await runtime.dispatch('decide', { runId: 'reject-local', approvalId: alternative.id, decision: 'approve' });
    await until(() => runtime.getState().task === null);

    runtime.dispatch('chat_start', { runId: 'stop-model', threadId: 'local', request: { messages: [{ role: 'user', text: '[hold-model]' }] } });
    await delay(100);
    assert.equal(runtime.getState().task.phase, 'running');
    await Promise.race([runtime.dispatch('stop', { runId: 'stop-model' }), delay(3000).then(() => { throw new Error('Model cancellation did not complete'); })]);
    assert.equal(runtime.getState().task, null);
  } finally {
    await runtime?.close(); await service?.close(); await control?.close(); await server?.close();
    await fixture.close(); await rm(directory, { recursive: true, force: true });
  }
});
