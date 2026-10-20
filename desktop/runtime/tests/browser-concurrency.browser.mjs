import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { FakeToolCallingModel } from 'langchain';
import { MemorySaver } from '@langchain/langgraph';
import { createBrowserService } from '../browser/browser.mjs';
import { createScriptWorkspace } from '../browser/script-workspace.mjs';
import { createDesktopRuntime } from '../runtime.mjs';
import { createResources } from '../resources.mjs';
import { browserHostFixture } from './browser-host-fixture.mjs';

async function until(check) {
  for (let i = 0; i < 1000; i++) { if (await check()) return; await delay(10); }
  throw new Error('Concurrent browser tasks did not settle');
}

test('real concurrent tasks retain their pages, shared login and independent cancellation across UI selections', { timeout: 40_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omniops-tabs-'));
  const entered = Promise.withResolvers();
  let slowResponse, server, control, runtime, service;
  const http = createServer((request, response) => {
    if (request.url === '/slow') { slowResponse = response; entered.resolve(); return; }
    if (request.url === '/manual') { response.end('<title>Manual</title>Keep this page'); return; }
    response.end('<title>Task B</title><label>Value<input></label>');
  });
  try {
    await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
    const baseURL = `http://127.0.0.1:${http.address().port}`;
    server = await chromium.launchServer({ channel: 'chromium', headless: true, args: ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1'] });
    const profile = server.process().spawnargs.find(arg => arg.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);
    const [port, path] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).trim().split('\n');
    const endpoint = `ws://127.0.0.1:${port}${path}`;
    control = await chromium.connectOverCDP(endpoint);
    const context = control.contexts()[0];
    const manual = context.pages()[0] || await context.newPage();
    await manual.setContent('<title>Manual</title>Keep this page');
    const host = browserHostFixture(context, endpoint);
    service = createBrowserService(host);
    const code = "export default async({page,assert})=>{await page.getByLabel('Value').fill('only-b');assert.equal(await page.getByLabel('Value').inputValue(),'only-b');return {value:'only-b'}}";
    const sha256 = createHash('sha256').update(code).digest('hex');
    let model = 0;
    runtime = await createDesktopRuntime({ browser: service, resources: createResources({ homeDir: directory }),
      runsDir: join(directory, 'runs'), checkpointer: new MemorySaver(), modelName: 'fixture',
      workspaceFactory: (snapshot, boundBrowser) => createScriptWorkspace({ dataDir: snapshot.directory, ensureBrowser: boundBrowser.ensure, signalEvent: () => {}, redact: String }),
      modelFactory: () => new FakeToolCallingModel({ toolCalls: ++model === 1
        ? [[{ id: 'a-inspect', name: 'inspect_browser', args: { url: `${baseURL}/slow` } }], []]
        : [[{ id: 'b-inspect', name: 'inspect_browser', args: { url: baseURL } }],
          [{ id: 'b-write', name: 'write_playwright_script', args: { name: 'fill.mjs', code } }],
          [{ id: 'b-run', name: 'run_playwright_script', args: { name: 'fill.mjs', sha256 } }], []] }),
    });
    const request = { messages: [{ role: 'user', text: 'Use only your own browser page' }] };
    runtime.dispatch('chat_start', { runId: 'a', threadId: 'thread-a', request });
    await entered.promise;
    await assert.rejects(runtime.dispatch('navigate', { threadId: 'thread-a', url: baseURL }), /先停止/);
    await runtime.dispatch('navigate', { threadId: null, url: `${baseURL}/manual` });
    runtime.dispatch('chat_start', { runId: 'b', threadId: 'thread-b', request });
    await runtime.dispatch('browser_select', { threadId: 'thread-b' });
    await runtime.dispatch('browser_select', { threadId: 'thread-a' });
    await until(() => runtime.getState().tasks.length === 1);
    assert.equal(runtime.dispatch('run_get', { runId: 'b' }).status, 'completed');
    const a = await service.forThread('thread-a').ensure();
    const b = await service.forThread('thread-b').ensure();
    assert.notEqual(a.targetId, b.targetId);
    assert.equal(a.targetId, (await host.request('create', 'thread-a')).targetId);
    assert.equal(await b.page.getByLabel('Value').inputValue(), 'only-b');
    assert.equal(await manual.title(), 'Manual');
    assert.equal(b.context.pages().length, 1, 'task connections must not attach unrelated pages');
    await assert.rejects(b.session.send('Target.createTarget', { url: 'about:blank' }), /assigned browser page/);
    await context.addCookies([{ name: 'login', value: 'shared', url: baseURL }]);
    assert.match(await b.page.evaluate(() => document.cookie), /login=shared/);
    assert.ok((await a.context.cookies(baseURL)).some(cookie => cookie.name === 'login'));
    await runtime.dispatch('stop', { runId: 'a' });
    assert.equal(runtime.dispatch('run_get', { runId: 'a' }).status, 'cancelled');
    assert.equal(await b.page.getByLabel('Value').inputValue(), 'only-b');
    await runtime.dispatch('browser_select', { threadId: 'thread-b' });
    assert.equal(runtime.getState().browserThreadId, 'thread-b');
    assert.equal(runtime.getState().browser.title, 'Task B');
    runtime.dispatch('chat_start', { runId: 'b-next', threadId: 'thread-b', request });
    await until(() => runtime.getState().tasks.length === 0);
    assert.equal(runtime.dispatch('run_get', { runId: 'b-next' }).status, 'completed');
    assert.equal((await service.forThread('thread-b').ensure()).targetId, b.targetId);
    await runtime.close(); runtime = undefined;
    assert.equal(host.pages.size, 0);
    assert.equal(manual.isClosed(), true);
  } finally {
    slowResponse?.end();
    await runtime?.close(); await service?.close(); await control?.close(); await server?.close();
    http.closeAllConnections(); await new Promise(resolve => http.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
