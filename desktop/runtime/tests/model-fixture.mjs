import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

/** Local model fixture only; never bundled. Browser effects still execute through real Playwright. */
export async function createModelFixture({ respond } = {}) {
  let baseURL;
  const requests = [];
  const errors = [];
  const server = createServer(async (request, response) => {
    if (request.url?.split('?')[0] === '/page') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><title>omniops-bots 本地浏览器验证</title><label>搜索<input type="search" aria-label="搜索"></label><p>本地测试页面；填写不会提交。</p>');
      return;
    }
    if (request.url === '/health') { response.end('ok'); return; }
    if (request.url !== '/v1/chat/completions' || request.method !== 'POST') { response.writeHead(404); response.end(); return; }
    try {
      let raw = '';
      for await (const chunk of request) { raw += chunk; if (raw.length > 4_000_000) throw new Error('too large'); }
      const body = JSON.parse(raw);
      requests.push(body);
      const messages = body.messages ?? [];
      const latestUser = messages.findLastIndex(message => message.role === 'user');
      const text = messages[latestUser]?.content;
      if (typeof text === 'string' && text.includes('[hold-model]')) {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.flushHeaders(); return;
      }
      const tools = messages.slice(latestUser + 1).filter(message => message.role === 'tool');
      const calls = new Map(messages.flatMap(message => message.tool_calls ?? []).map(call => [call.id, call]));
      const last = tools.at(-1);
      const name = calls.get(last?.tool_call_id)?.function?.name;
      let result;
      try { result = JSON.parse(last?.content); } catch {}
      const changedPlan = tools.slice(0, -1).some(message => {
        const tool = calls.get(message.tool_call_id)?.function?.name;
        if (!['inspect_browser', 'run_playwright_script'].includes(tool)) return false;
        try { const value = JSON.parse(message.content); return Boolean(value.error) || (tool === 'inspect_browser' ? !value.title : value.status !== 'passed'); }
        catch { return true; }
      });
      let action;
      if (!tools.length) action = { name: 'inspect_browser', args: { url: `${baseURL}/page` } };
      else if (name === 'inspect_browser' && !result?.title) action = { name: 'inspect_browser', args: {} };
      else if (name === 'inspect_browser' && !changedPlan) action = { name: 'write_playwright_script', args: {
        name: 'fixture-input.mjs',
        code: `export default async ({page,assert})=>{await page.goto(${JSON.stringify(`${baseURL}/page`)},{waitUntil:'domcontentloaded'});await page.getByRole('searchbox').fill('abcd');assert.equal(await page.getByRole('searchbox').inputValue(),'abcd');assert.equal(new URL(page.url()).searchParams.has('q'),false);return {inputValue:'abcd',submitted:false};}`,
      } };
      else if (name === 'write_playwright_script') action = { name: 'run_playwright_script', args: { name: result.name, sha256: result.sha256 } };
      else if (name === 'run_playwright_script' && (result?.error || !result?.result)) action = { name: 'inspect_browser', args: {} };
      const override = await respond?.({ body, baseURL });
      if (override) action = override.action;
      if (action && !body.tools?.some(tool => tool.function?.name === action.name)) action = undefined;
      const id = `fixture-${requests.length}-${tools.length}`;
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const chunk = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ id: `chatcmpl-${id}`, object: 'chat.completion.chunk', created: 1, model: 'omniops-bots-fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      chunk({ role: 'assistant' });
      if (action) chunk({ tool_calls: [{ index: 0, id, type: 'function', function: { name: action.name, arguments: JSON.stringify(action.args) } }] });
      else chunk({ content: override?.text ?? '本地验证完成：已检查真实工具结果；未提交搜索。' });
      chunk({}, action ? 'tool_calls' : 'stop');
      response.end('data: [DONE]\n\n');
    } catch (error) { errors.push(String(error)); response.writeHead(400); response.end(JSON.stringify({ error: { message: 'Invalid fixture request' } })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseURL = `http://127.0.0.1:${server.address().port}`;
  return { baseURL: `${baseURL}/v1`, pageURL: `${baseURL}/page`, model: 'omniops-bots-fixture', requests, errors, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const fixture = await createModelFixture();
  console.log(JSON.stringify({ baseURL: fixture.baseURL, pageURL: fixture.pageURL, model: fixture.model, apiKey: 'local-fixture-key' }));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void fixture.close());
}
