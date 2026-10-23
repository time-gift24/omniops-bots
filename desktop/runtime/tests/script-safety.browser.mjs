import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, lstat, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright-core';
import { ChatOpenAI } from '@langchain/openai';
import { MemorySaver } from '@langchain/langgraph';
import { createScriptWorkspace } from '../browser/script-workspace.ts';
import { createBrowserService } from '../browser/browser.ts';
import { createDesktopRuntime } from '../runtime.ts';
import { createResources } from '../resources.ts';
import { createModelFixture } from './model-fixture.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { browserHostFixture } from './browser-host-fixture.mjs';

async function writable(directory) {
  if (!(await lstat(directory)).isDirectory()) return;
  await chmod(directory, 0o700);
  for (const name of await readdir(directory)) await writable(join(directory, name));
}

async function until(check) {
  for (let i = 0; i < 1000; i++) { const value = await check(); if (value) return value; await delay(10); }
  throw new Error('Timed out waiting for local browser test');
}

test('real CDP scripts retain source/hash, filesystem/process/network permissions, cancellation and target isolation', { timeout: 60_000 }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'omniops-bots-runtime-')));
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
    const host = browserHostFixture(context, endpoint);
    service = createBrowserService(host);
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
    const wrong = createBrowserService({ request: async () => ({ endpoint, targetId: 'missing' }), close: async () => {} });
    await assert.rejects(wrong.ensure(), /目标页面/);
    await wrong.close();

    // Only the model is synthetic; LangGraph, immutable assembly and Playwright execute locally.
    const chat = [];
    runtime = await createDesktopRuntime({ browser: service, workspace,
      workspaceFactory: (_session, boundBrowser) => createScriptWorkspace({ dataDir: directory, ensureBrowser: boundBrowser.ensure, signalEvent: event => events.push(event), redact: String }),
      resources: createResources({ homeDir: directory }), runsDir: join(directory, '.omnimind-ops/runs'), checkpointer: new MemorySaver(), modelName: fixture.model, emit: event => chat.push(event), modelFactory: () => new ChatOpenAI({ model: fixture.model, apiKey: 'fixture-key', configuration: { baseURL: fixture.baseURL }, useResponsesApi: false, maxRetries: 0 }) });
    runtime.dispatch('chat_start', { runId: 'real-local', threadId: 'agent-test:local', request: { messages: [{ role: 'user', text: '填写本地搜索框，不提交' }] } });
    await until(() => runtime.getState().tasks.length === 0);
    assert.equal(chat.some(event => event.state?.task?.phase === 'awaiting-approval'), false);
    assert.equal(runtime.dispatch('run_get', { runId: 'real-local' }).status, 'completed');
    assert.equal(chat.findLast(event => event.event === 'chat_event').data.type, 'completed', JSON.stringify(chat.findLast(event => event.event === 'chat_event')));
    const taskPage = host.pages.get('agent-test:local');
    assert.notEqual(taskPage, page);
    assert.equal(await taskPage.getByRole('searchbox').inputValue(), 'abcd');
    assert.equal(new URL(taskPage.url()).searchParams.has('q'), false);
    await runtime.dispatch('browser_select', { threadId: 'agent-test:local' });
    await runtime.dispatch('navigate', { url: `${fixture.pageURL}?second=1` });
    assert.equal(runtime.getState().browser.canGoBack, true);
    await runtime.dispatch('back');
    assert.equal(runtime.getState().browser.url, fixture.pageURL);
    assert.equal(runtime.getState().browser.canGoForward, true);
    await runtime.dispatch('forward');
    assert.equal(runtime.getState().browser.url, `${fixture.pageURL}?second=1`);

    await taskPage.setContent('<label>Password<input type="password"></label>');
    await assert.rejects(service.inspect({}, new AbortController().signal), error => error.kind === 'human-required');
    await taskPage.goto(fixture.pageURL);

    runtime.dispatch('chat_start', { runId: 'stop-model', threadId: 'local', request: { messages: [{ role: 'user', text: '[hold-model]' }] } });
    await delay(100);
    assert.equal(runtime.getState().tasks[0].phase, 'running');
    await Promise.race([runtime.dispatch('stop', { runId: 'stop-model' }), delay(3000).then(() => { throw new Error('Model cancellation did not complete'); })]);
    assert.equal(runtime.getState().tasks.length, 0);
  } finally {
    await runtime?.close(); await service?.close(); await control?.close(); await server?.close();
    await fixture.close(); await writable(directory); await rm(directory, { recursive: true, force: true });
  }
});
