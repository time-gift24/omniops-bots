import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import readline from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { chromium } from 'playwright-core';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { createModelFixture } from './model-fixture.mjs';

async function until(check) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await delay(10); }
  throw new Error('Local client did not reach the expected state');
}
async function writable(directory) {
  if (!(await lstat(directory)).isDirectory()) return;
  await chmod(directory, 0o700);
  for (const name of await readdir(directory)) await writable(join(directory, name));
}
async function mcpFixture() {
  const sessions = new Map(), calls = [];
  const http = createServer(async (request, response) => {
    if (request.headers.authorization !== 'Bearer local-mcp-private') { response.writeHead(401); response.end(); return; }
    try {
      let body;
      if (request.method === 'POST') {
        const chunks = []; for await (const chunk of request) chunks.push(chunk);
        body = JSON.parse(Buffer.concat(chunks).toString());
      }
      let session = sessions.get(request.headers['mcp-session-id']);
      if (!session && body?.method === 'initialize') {
        const server = new McpServer({ name: 'local-client-fixture', version: '1.0.0' });
        server.registerTool('lookup', { description: 'Resolve a search query.', inputSchema: { value: z.string() } }, async ({ value }) => {
          calls.push(value);
          return { content: [{ type: 'text', text: JSON.stringify({ query: value }) }] };
        });
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, enableJsonResponse: true,
          onsessioninitialized: id => sessions.set(id, { server, transport }) });
        await server.connect(transport); session = { server, transport };
      }
      if (!session) { response.writeHead(404); response.end(); return; }
      await session.transport.handleRequest(request, response, body);
    } catch { if (!response.headersSent) response.writeHead(500); response.end(); }
  });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${http.address().port}/mcp`, calls, async close() {
    await Promise.allSettled([...sessions.values()].map(({ server }) => server.close()));
    http.closeAllConnections(); await new Promise(resolve => http.close(resolve));
  } };
}
async function client(directory, model, manual = {}, keys = new Map()) {
  const child = spawn(process.env.OMNIOPS_BOTS_TEST_NODE_EXECUTABLE || process.execPath, ['main.ts'], {
    cwd: process.env.OMNIOPS_BOTS_TEST_RUNTIME_DIRECTORY || new URL('..', import.meta.url), env: {
    ...process.env, OMNIOPS_BOTS_DATA_DIR: join(directory, 'app'), OMNIOPS_BOTS_LOCAL_ROOT: join(directory, 'local'),
    OMNIOPS_BOTS_MODEL: model.model, OPENAI_API_KEY: 'local-model-private', OPENAI_BASE_URL: model.baseURL,
    MCP_LOCAL_TOKEN: 'local-mcp-private',
    OMNIOPS_BOTS_MANUAL_BROWSER_CDP_ENDPOINT: manual.endpoint || '', OMNIOPS_BOTS_MANUAL_BROWSER_TARGET_ID: manual.targetId || '',
  }, stdio: ['pipe', 'pipe', 'pipe'] });
  const subscribers = new Set();
  const events = [], pending = new Map(), ready = Promise.withResolvers(), exited = Promise.withResolvers();
  let sequence = 0, stderr = '';
  child.stderr.on('data', bytes => { stderr += bytes; });
  child.on('error', error => ready.reject(error));
  child.on('exit', code => { exited.resolve(code); ready.reject(new Error(`Runtime exited: ${code} ${stderr}`)); for (const request of pending.values()) request.reject(new Error('Runtime exited')); });
  readline.createInterface({ input: child.stdout }).on('line', line => {
    const message = JSON.parse(line);
    if (message.event === 'credential_request') {
      if (message.operation === 'set') keys.set(message.reference, message.secret);
      if (message.operation === 'delete') keys.delete(message.reference);
      child.stdin.write(JSON.stringify({ event: 'credential_reply', requestId: message.requestId,
        result: message.operation === 'get' ? keys.get(message.reference) ?? null : null }) + '\n');
      return;
    }
    if (message.event) { events.push(message); for (const subscriber of subscribers) subscriber(message); }
    if (message.event === 'ready') ready.resolve();
    const request = pending.get(message.id);
    if (request) { pending.delete(message.id); message.error ? request.reject(Object.assign(new Error(message.error.message), message.error)) : request.resolve(message.result); }
  });
  await ready.promise;
  function rpc(method, params) {
    const id = ++sequence, result = Promise.withResolvers(); pending.set(id, result);
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    return result.promise;
  }
  return { rpc, events, subscribe(listener) { subscribers.add(listener); return () => subscribers.delete(listener); }, async close(force = false) {
    if (child.exitCode !== null || child.signalCode) return;
    if (force) child.kill('SIGKILL'); else await rpc('shutdown');
    await exited.promise;
  } };
}

test('client JSONL isolates manual CDP operations from Agent Chrome, runs pinned Skills and MCP, and restores without replay', { timeout: 90_000 }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'omniops-bots-client-')));
  const keys = new Map();
  let control, manualServer, manualControl, runtime, model, mcp;
  async function chromeContext() {
    await control?.close();
    const [port, path] = (await readFile(join(directory, 'app/chrome/DevToolsActivePort'), 'utf8')).trim().split('\n');
    control = await chromium.connectOverCDP(`ws://127.0.0.1:${port}${path}`);
    return control.contexts()[0];
  }
  async function inputValues(context) {
    const values = [];
    for (const page of context.pages()) if (await page.getByRole('searchbox').count()) values.push(await page.getByRole('searchbox').inputValue());
    return values.toSorted();
  }
  try {
    mcp = await mcpFixture();
    model = await createModelFixture({ respond({ body, baseURL }) {
      const index = body.messages.findLastIndex(message => message.role === 'user');
      const turns = body.messages.slice(index + 1);
      const calls = new Map(turns.flatMap(message => message.tool_calls ?? []).map(call => [call.id, call]));
      const results = turns.filter(message => message.role === 'tool');
      const last = results.at(-1), name = calls.get(last?.tool_call_id)?.function.name;
      const content = typeof last?.content === 'string' ? last.content : last?.content?.map(part => part.text ?? '').join('');
      if (!last) return { action: { name: 'read_file', args: { file_path: '/skills/browser-proof/references/query.txt' } } };
      if (name === 'read_file') {
        assert.match(content, /version-(one|two)/);
        return { action: { name: 'mcp_local_lookup', args: { value: content.includes('version-two') ? 'version-two' : 'version-one' } } };
      }
      if (name === 'mcp_local_lookup') return { action: { name: 'inspect_browser', args: { url: `${baseURL}/page` } } };
      if (name === 'inspect_browser') {
        const mcpResult = results.find(message => calls.get(message.tool_call_id)?.function.name === 'mcp_local_lookup');
        const query = JSON.parse(JSON.parse(mcpResult.content).content[0].text).query;
        return { action: { name: 'write_playwright_script', args: { name: 'fill.mjs', code: `export default async({page,assert})=>{await page.getByRole('searchbox').fill(${JSON.stringify(query)});assert.equal(await page.getByRole('searchbox').inputValue(),${JSON.stringify(query)});return {query:${JSON.stringify(query)},submitted:false};}` } } };
      }
      if (name === 'write_playwright_script') { const source = JSON.parse(last.content); return { action: { name: 'run_playwright_script', args: { name: source.name, sha256: source.sha256 } } }; }
      assert.equal(JSON.parse(last.content).status, 'passed');
      return { text: `真实页面已填写：${JSON.parse(last.content).result.query}，未提交。` };
    } });
    manualServer = await chromium.launchServer({ channel: 'chromium', headless: true, args: ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1'] });
    const manualProfile = manualServer.process().spawnargs.find(arg => arg.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);
    const [manualPort, manualPath] = (await readFile(join(manualProfile, 'DevToolsActivePort'), 'utf8')).trim().split('\n');
    const manual = { endpoint: `ws://127.0.0.1:${manualPort}${manualPath}` };
    manualControl = await chromium.connectOverCDP(manual.endpoint);
    const manualPage = manualControl.contexts()[0].pages()[0] || await manualControl.contexts()[0].newPage();
    const manualSession = await manualControl.contexts()[0].newCDPSession(manualPage);
    manual.targetId = (await manualSession.send('Target.getTargetInfo')).targetInfo.targetId;
    await manualSession.detach();
    runtime = await client(directory, model, manual, keys);
    const rpc = (...args) => runtime.rpc(...args);
    assert.equal((await rpc('operations_browser_status')).status, 'empty');
    const manualUrl = `${model.baseURL.replace(/\/v1\/?$/, '')}/page`;
    await rpc('operations_browser_navigate', { url: `${manualUrl}?manual=one` });
    await rpc('operations_browser_navigate', { url: `${manualUrl}?manual=two` });
    await rpc('operations_browser_back');
    assert.equal((await rpc('operations_browser_status')).url, `${manualUrl}?manual=one`);
    await rpc('operations_browser_forward');
    await rpc('operations_browser_reload');
    await manualPage.getByRole('searchbox').fill('manual-only');
    const beforeAgent = await rpc('status');
    assert.equal(beforeAgent.browser.url, '');
    assert.equal(beforeAgent.browserRequest, 0);
    assert.equal(beforeAgent.operationsBrowser.url, `${manualUrl}?manual=two`);
    assert.ok(runtime.events.some(event => event.event === 'operations_browser_state' && event.state.url === `${manualUrl}?manual=two`));
    const skill = await rpc('skill_library_create', { name: 'browser-proof', description: 'Read references/query.txt and use MCP before browser operations.' });
    await rpc('skill_library_mkdir', { id: skill.id, path: 'references' });
    const writeReference = text => rpc('skill_library_write', { id: skill.id, path: 'references/query.txt', data: Buffer.from(text).toString('base64'), replace: true });
    await writeReference('version-one');
    await rpc('mcp_save', { server: { id: 'local', name: 'Local fixture', description: 'Search values', url: mcp.url, credentialEnv: 'MCP_LOCAL_TOKEN' } });
    assert.equal((await rpc('mcp_test', { id: 'local' })).tools[0].name, 'lookup');
    const configuration = { name: 'Browser proof', description: 'Local proof', instructions: 'Read browser-proof references/query.txt and use lookup, then fill the search field without submitting.',
      skillIds: [skill.id], mcpServerIds: ['local'], toolIds: ['inspect_browser', 'write_playwright_script', 'run_playwright_script'] };
    const agent = await rpc('agent_create', { configuration });
    async function run(runId, threadId, text = '读取固定资源，通过 MCP 填写页面，不提交。') {
      await rpc('chat_start', { runId, threadId, agentId: agent.id, request: { messages: [{ role: 'user', text }] } });
      const terminal = await until(() => runtime.events.find(event => event.runId === runId && ['completed', 'failed'].includes(event.data?.type)));
      assert.equal(terminal.data.type, 'completed', JSON.stringify({ terminal, fixtureErrors: model.errors, messages: model.requests.at(-1)?.messages.slice(-2) }));
      return rpc('run_get', { runId });
    }
    const scope = { sessionId: 'stable-session' };
    await rpc('workspace_bind', { scope });
    const first = await run('one', scope.sessionId);
    let context = await chromeContext();
    assert.deepEqual(await inputValues(context), ['version-one']);
    assert.equal(await manualPage.getByRole('searchbox').inputValue(), 'manual-only');
    const page = await context.newPage(), other = await context.newPage();
    assert.equal(page.url(), 'about:blank');
    assert.equal(other.url(), 'about:blank');
    assert.equal(first.status, 'completed');
    assert.ok(first.result.assistant.parts.some(part => part.type === 'tool-call' && part.call.name === 'mcp_local_lookup'));
    assert.equal(first.snapshot.skills.length, 1);
    assert.deepEqual(first.snapshot.tools.toSorted(), [...configuration.toolIds, 'mcp_local_lookup'].toSorted());
    assert.equal(first.snapshot.workingDirectory, join(directory, 'local/tmp/stable-session'));
    assert.match(await readFile(join(first.snapshot.workingDirectory, 'automation/scripts/fill.mjs'), 'utf8'), /version-one/u);
    assert.ok((await rpc('workspace_files', { scope })).some(file => file.path === 'automation/scripts/fill.mjs'));
    assert.ok((await rpc('workspace_changes', { scope })).fileCount > 0);
    await writeReference('version-two');
    await rpc('agent_save', { id: agent.id, configuration: { ...configuration, instructions: 'Updated prompt for new sessions.' } });
    await runtime.close();
    assert.equal(control.isConnected(), false, 'runtime shutdown closes its own external Chrome');
    assert.equal(manualPage.isClosed(), false, 'runtime only disconnects from the native manual browser');
    const requestCount = model.requests.length;
    runtime = await client(directory, model, manual, keys);
    assert.equal((await rpc('operations_browser_status')).url, `${manualUrl}?manual=two`);
    assert.equal((await rpc('runs_list')).length, 1);
    assert.deepEqual(await rpc('session_snapshot', { threadId: 'stable-session' }), first.snapshot);
    await delay(50); assert.equal(model.requests.length, requestCount);
    const second = await run('two', 'stable-session');
    context = await chromeContext();
    assert.deepEqual(await inputValues(context), ['version-one']);
    assert.deepEqual(second.snapshot, first.snapshot);
    const third = await run('three', 'fresh-session');
    assert.deepEqual(await inputValues(context), ['version-one', 'version-two']);
    assert.notEqual(third.snapshot.skills[0].contentId, first.snapshot.skills[0].contentId);
    assert.deepEqual(mcp.calls, ['version-one', 'version-one', 'version-two']);
    await assert.rejects(rpc('chat_start', { runId: 'one', threadId: 'stable-session', request: { messages: [{ role: 'user', text: 'duplicate' }] } }), error => error.kind === 'duplicate-run');
    await rpc('chat_start', { runId: 'interrupted', threadId: 'fresh-session', agentId: agent.id, request: { messages: [{ role: 'user', text: '[hold-model]' }] } });
    await until(() => runtime.events.some(event => event.runId === 'interrupted' && event.data?.type === 'started'));
    await runtime.close(true);
    const beforeRestart = model.requests.length;
    runtime = await client(directory, model, manual, keys);
    const interrupted = await rpc('run_get', { runId: 'interrupted' });
    assert.equal(interrupted.status, 'interrupted');
    assert.match(interrupted.error.message, /结果未知/);
    await delay(50); assert.equal(model.requests.length, beforeRestart);
    assert.equal((await rpc('status')).task, null);
    const records = JSON.stringify(await rpc('runs_list'));
    for (const secret of ['local-model-private', 'local-mcp-private']) assert.equal(records.includes(secret), false);
  } finally {
    await runtime?.close(); await control?.close(); await manualControl?.close(); await manualServer?.close();
    await model?.close(); await mcp?.close(); await writable(directory); await rm(directory, { recursive: true, force: true });
  }
});

// Run against source or the packaged Node/runtime using the same environment
// overrides as the client regression above. Only the native transport and model
// service are fixtures; LangGraph, JSONL, adapters, stores and Arc are real.
test('Cognacta input renders real LangGraph IPC deltas, tools, completion, history and cancellation', { timeout: 90_000 }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'omniops-chat-ui-')));
  const gates = [], requests = [];
  let runtime, browser, vite, page, unsubscribe, mcp;
  const http = createServer(async (request, response) => {
    try {
      let raw = '';
      for await (const bytes of request) raw += bytes;
      const body = JSON.parse(raw);
      requests.push(body);
      const user = body.messages.findLastIndex(message => message.role === 'user');
      const stopped = body.messages[user].content.includes('取消');
      const tools = body.messages.slice(user + 1).filter(message => message.role === 'tool');
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const send = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ id: `chatcmpl-ui-${requests.length}`, object: 'chat.completion.chunk', created: 1, model: 'ui-fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      send({ role: 'assistant' });
      if (!tools.length && !stopped) {
        send({ tool_calls: [{ index: 0, id: 'lookup-proof', type: 'function', function: { name: 'mcp_local_lookup', arguments: '{"value":"live-ui"}' } }] });
        send({}, 'tool_calls');
      } else {
        send({ content: stopped ? '取消前保留 👩🏽‍💻' : 'LangGraph 实时中文 👩🏽‍💻' });
        const gate = Promise.withResolvers();
        gates.push(gate);
        await gate.promise;
        if (response.destroyed) return;
        send({ content: '\n\n```ts\nconst verified = true\n```\n\n完成结果。' });
        send({}, 'stop');
      }
      response.end('data: [DONE]\n\n');
    } catch { if (!response.headersSent) response.writeHead(500); response.end(); }
  });
  try {
    await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
    runtime = await client(directory, { model: 'ui-fixture', baseURL: `http://127.0.0.1:${http.address().port}/v1` });
    mcp = await mcpFixture();
    await runtime.rpc('mcp_save', { server: { id: 'local', name: 'Local fixture', description: 'Local streaming fixture', url: mcp.url, credentialEnv: 'MCP_LOCAL_TOKEN' } });
    const agent = await runtime.rpc('agent_create', { configuration: { name: 'UI proof', description: '', instructions: 'Use the selected MCP lookup and answer.', skillIds: [], toolIds: [], mcpServerIds: ['local'] } });
    const { createServer: createVite } = await import('../../../web/node_modules/vite/dist/node/index.js');
    vite = await createVite({ appType: 'custom', root: new URL('../../../web', import.meta.url).pathname, plugins: [{ name: 'chat-ui-test', resolveId(id) { if (id === '/chat-ui-test.js') return id; }, load(id) { if (id === '/chat-ui-test.js') return 'import React from "react"; import ReactDOM from "react-dom/client"; export const h = React.createElement; export const createRoot = ReactDOM.createRoot;'; } }], cacheDir: 'node_modules/.vite-langgraph-ui', server: { host: '127.0.0.1', port: 0 }, optimizeDeps: { entries: ['src/main.tsx'] } });
    vite.middlewares.use('/__chat_ui', async (_request, response) => { response.setHeader('Content-Type', 'text/html'); response.end(await vite.transformIndexHtml('/__chat_ui', '<!doctype html><div id="root" style="height:800px"></div>')); });
    await vite.listen();
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
    await page.exposeFunction('runtimeInvoke', async (command, args) => {
      if (['runtime_prepare_run', 'runtime_release_run'].includes(command)) return null;
      assert.equal(command, 'runtime_request');
      return runtime.rpc(args.method, args.params);
    });
    await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}/__chat_ui`);
    unsubscribe = runtime.subscribe(message => { void page.evaluate(message => window.runtimeListener?.(message), message).catch(() => {}); });
    await page.evaluate(async agentId => {
      const [{ h, createRoot }, { createTauriAdapters }, { createAppDependencies, AppDependenciesProvider }, { ChatScreen }] = await Promise.all([
        import('/chat-ui-test.js'),
        import('/src/adapters/tauri/index.ts'), import('/src/app/dependencies.tsx'), import('/src/components/chat/chat-screen.tsx'), import('/src/index.css'),
      ]);
      const connection = await createTauriAdapters({ invoke: window.runtimeInvoke, async listen(_name, callback) { window.runtimeListener = callback; return () => { window.runtimeListener = undefined; }; } });
      connection.setContextResolver(async () => ({ agentId }));
      const dependencies = createAppDependencies(connection.adapters), models = await dependencies.models.list();
      const root = createRoot(document.querySelector('#root'));
      const mount = () => root.render(h(AppDependenciesProvider, { value: dependencies }, h(ChatScreen, { threadId: 'live-ui', models })));
      window.uiProof = { mount, unmount: () => root.render(null), dispose: () => { root.unmount(); connection.dispose(); } };
      mount();
    }, agent.id);
    const input = page.getByRole('textbox', { name: '消息输入' });
    await input.fill('验证实时 LangGraph');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    try { await page.getByText('LangGraph 实时中文 👩🏽‍💻', { exact: false }).waitFor({ timeout: 10_000 }); }
    catch (cause) { throw new Error(JSON.stringify({ requests: requests.map(body => body.messages.map(message => ({ role: message.role, tool: message.name }))), events: runtime.events.filter(message => message.event === 'chat_event').map(message => ({ type: message.data.type, error: message.data.error })), ui: await page.locator('body').innerText() }), { cause }); }
    const running = await runtime.rpc('status');
    assert.equal(running.tasks.length, 1, 'Arc must reveal deltas while the real graph is still running');
    assert.ok(runtime.events.some(message => message.data?.type === 'delta'));
    assert.equal(runtime.events.some(message => message.data?.type === 'completed'), false);
    await page.getByRole('button', { name: /mcp_local_lookup/ }).click();
    assert.ok(await page.getByText('live-ui', { exact: false }).count(), 'Actual graph tool output reaches the Arc tool detail');
    await input.fill('保留下一轮草稿');
    await page.evaluate(() => window.uiProof.unmount());
    gates[0].resolve();
    await until(async () => (await runtime.rpc('status')).tasks.length === 0);
    await page.evaluate(() => window.uiProof.mount());
    await page.getByText('完成结果。', { exact: false }).waitFor();
    assert.equal(await input.textContent(), '保留下一轮草稿');
    assert.match(await page.locator('pre').innerText(), /const verified = true/);
    const records = await runtime.rpc('runs_list');
    assert.equal(records[0].status, 'completed');
    assert.equal(records[0].result.assistant.parts.filter(part => part.type === 'text').map(part => part.text).join(''), 'LangGraph 实时中文 👩🏽‍💻\n\n```ts\nconst verified = true\n```\n\n完成结果。');
    await input.fill('验证取消');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await page.getByText('取消前保留 👩🏽‍💻', { exact: false }).waitFor();
    await page.getByRole('button', { name: '停止响应', exact: true }).click();
    await until(async () => (await runtime.rpc('status')).tasks.length === 0);
    assert.ok(await page.getByText('取消前保留 👩🏽‍💻', { exact: false }).count());
    assert.equal((await runtime.rpc('runs_list'))[0].status, 'cancelled');
    assert.equal(requests.length, 3, 'Stop and remount must never replay a graph/model call');
    await page.evaluate(() => window.uiProof.dispose());
  } finally {
    unsubscribe?.();
    for (const gate of gates) gate.resolve();
    await browser?.close();
    await vite?.close();
    await runtime?.close();
    await mcp?.close();
    http.closeAllConnections();
    await new Promise(resolve => http.close(resolve));
    await writable(directory); await rm(directory, { recursive: true, force: true });
  }
});
