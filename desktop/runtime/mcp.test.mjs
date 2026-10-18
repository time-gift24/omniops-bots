import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { connectMcp, createMcpCatalog } from './mcp.ts';

async function until(check) {
  const deadline = Date.now() + 4000;
  while (!check() && Date.now() < deadline) await delay(10);
  assert.ok(check(), 'Local MCP protocol did not reach the expected state');
}
async function fixture({ secret, toolName = 'double', denyMethod, fail = false, slow = false, tools = true, metadataText = '' } = {}) {
  const sessions = new Map(), responses = new Set(), calls = [], notes = [], authorizations = [], methods = [];
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  let requestCount = 0;
  const http = createServer(async (request, response) => {
    requestCount++;
    responses.add(response);
    response.on('close', () => responses.delete(response));
    authorizations.push(request.headers.authorization);
    if (secret && request.headers.authorization !== `Bearer ${secret}`) {
      response.writeHead(401, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    try {
      let body;
      if (request.method === 'POST') {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        methods.push(body.method);
      }
      if (denyMethod && body?.method === denyMethod) {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32603, message: 'fixture protocol failure' } }));
        return;
      }
      let session = sessions.get(request.headers['mcp-session-id']);
      if (!session && body?.method === 'initialize') {
        const server = new McpServer({ name: 'local-mcp-fixture', version: '1.0.0' });
        if (tools) server.registerTool(toolName, { description: `Double an integer.${metadataText}`, inputSchema: { value: z.number().int(), note: z.string().optional() } }, async ({ value, note }) => {
          calls.push(value);
          notes.push(note);
          entered.resolve();
          if (slow) await release.promise;
          return { ...(fail ? { isError: true } : {}), content: [{ type: 'text', text: fail ? `fixture rejected ${secret ?? ''}` : JSON.stringify({ doubled: value * 2, echoed: secret ?? '', note }) }] };
        });
        server.registerResource('reference', 'fixture://reference', { description: `A resource, not a tool.${metadataText}`, mimeType: 'text/plain' }, async uri => ({ contents: [{ uri: uri.href, text: 'Reference bytes' }] }));
        server.registerPrompt('template', { description: `A prompt, not a tool.${metadataText}`, argsSchema: { topic: z.string() } }, ({ topic }) => ({ messages: [{ role: 'user', content: { type: 'text', text: topic } }] }));
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, enableJsonResponse: true,
          onsessioninitialized: id => sessions.set(id, { server, transport }) });
        await server.connect(transport);
        session = { server, transport };
      }
      if (!session) { response.writeHead(404); response.end(); return; }
      await session.transport.handleRequest(request, response, body);
    } catch {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    }
  });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  return {
    config: { id: 'fixture', name: 'Local MCP', description: 'Real HTTP fixture', url: `http://127.0.0.1:${http.address().port}/mcp`, ...(secret ? { credentialEnv: 'MCP_FIXTURE_KEY' } : {}) },
    calls, notes, authorizations, responses, entered, release, methods, requests: () => requestCount,
    async close() {
      release.resolve();
      await Promise.allSettled([...sessions.values()].map(({ server }) => server.close()));
      http.closeAllConnections();
      await new Promise(resolve => http.close(resolve));
    },
  };
}

test('MCP catalog persists CRUD and stores only credential environment references', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omniops-bots-mcp-'));
  try {
    const catalog = createMcpCatalog({ directory });
    const config = { id: 'ops', name: 'Operations', description: 'Internal MCP', url: 'https://example.com/mcp', credentialEnv: 'MCP_OPERATIONS_KEY' };
    assert.deepEqual(await catalog.list(), []);
    await catalog.save(config);
    const restarted = createMcpCatalog({ directory });
    assert.deepEqual(await restarted.get('ops'), config);
    await restarted.save({ ...config, name: 'Updated operations' });
    assert.equal((await catalog.list()).length, 1);
    assert.equal((await catalog.get('ops')).name, 'Updated operations');
    assert.throws(() => catalog.save({ ...config, token: 'never-save-secret' }));
    for (const url of ['https://user:secret@example.com/mcp', 'https://example.com/mcp?token=secret', 'http://example.com/mcp']) assert.throws(() => catalog.save({ ...config, url }));
    const saved = await readFile(join(directory, 'mcp.json'), 'utf8');
    assert.match(saved, /MCP_OPERATIONS_KEY/);
    assert.equal(saved.includes('never-save-secret'), false);
    await catalog.remove('ops');
    assert.deepEqual(await restarted.list(), []);
    await assert.rejects(restarted.get('ops'), /不存在/u);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('real MCP discovery and tool calls preserve schema and separate resources and prompts', async () => {
  const server = await fixture({ secret: 'fixture-credential-private' });
  const controller = new AbortController(), events = [];
  let connected;
  try {
    connected = await connectMcp([server.config], { signal: controller.signal, env: { MCP_FIXTURE_KEY: 'fixture-credential-private' }, onTool: event => events.push(event) });
    assert.deepEqual(connected.tools.map(tool => tool.name), ['mcp_fixture_double']);
    const definition = connected.manifests[0].tools[0];
    assert.equal(definition.sourceName, 'double');
    assert.equal(definition.inputSchema.properties.value.type, 'integer');
    assert.deepEqual(definition.inputSchema.required, ['value']);
    const catalog = connected.capabilities[0];
    assert.equal(catalog.id, 'fixture');
    assert.deepEqual(catalog.capabilities.tools.map(({ name, description }) => ({ name, description })), [{ name: 'double', description: 'Double an integer.' }]);
    assert.deepEqual(JSON.parse(catalog.capabilities.tools[0].params), definition.inputSchema);
    assert.deepEqual(catalog.capabilities.resources, [{ name: 'reference', description: 'A resource, not a tool.', params: 'fixture://reference' }]);
    assert.deepEqual(catalog.capabilities.prompts.map(({ name, description }) => ({ name, description })), [{ name: 'template', description: 'A prompt, not a tool.' }]);
    assert.deepEqual(JSON.parse(catalog.capabilities.prompts[0].params), [{ name: 'topic', required: true }]);
    const output = await connected.tools[0].invoke({ type: 'tool_call', id: 'call-1', name: 'mcp_fixture_double', args: { value: 7 } });
    assert.deepEqual(server.calls, [7]);
    assert.equal(output.artifact.value.content[0].text.includes('14'), true);
    assert.equal(JSON.stringify(output).includes('fixture-credential-private'), false);
    assert.equal(JSON.stringify(events).includes('fixture-credential-private'), false);
    assert.equal(events[0].callId, 'call-1');
    assert.equal(events.at(-1).type, 'end');
    assert.equal(events.at(-1).error, undefined);
    assert.ok(server.authorizations.every(value => value === 'Bearer fixture-credential-private'));
    assert.equal(connected.tools.some(tool => /reference|template/u.test(tool.name)), false);
    assert.equal(JSON.stringify(connected.manifests).includes('fixture-credential-private'), false);
    assert.equal(JSON.stringify(connected.capabilities).includes('fixture-credential-private'), false);
  } finally { await connected?.close(); await server.close(); }
});

test('a real MCP server without tools still discovers resources and prompts without tools/list', async () => {
  const server = await fixture({ tools: false, denyMethod: 'tools/list' });
  let connected;
  try {
    connected = await connectMcp([server.config], { signal: new AbortController().signal });
    assert.deepEqual(connected.tools, []);
    assert.deepEqual(connected.manifests[0].tools, []);
    assert.deepEqual(connected.capabilities[0].capabilities.tools, []);
    assert.deepEqual(connected.capabilities[0].capabilities.resources.map(item => item.name), ['reference']);
    assert.deepEqual(connected.capabilities[0].capabilities.prompts.map(item => item.name), ['template']);
    assert.equal(server.methods.includes('tools/list'), false);
    assert.ok(server.methods.includes('resources/list'));
    assert.ok(server.methods.includes('prompts/list'));
    assert.deepEqual(server.calls, []);
  } finally { await connected?.close(); await server.close(); }
});

test('the global redactor covers MCP metadata, events, results and artifacts without altering executed arguments', async () => {
  const secret = 'fixture-unrelated-provider-key';
  const server = await fixture({ metadataText: ` ${secret}` });
  const events = [];
  let connected;
  try {
    connected = await connectMcp([server.config], { signal: new AbortController().signal,
      redact: value => value.replaceAll(secret, '[redacted]'), onTool: event => events.push(event) });
    const output = await connected.tools[0].invoke({ type: 'tool_call', id: 'global-redaction', name: 'mcp_fixture_double', args: { value: 3, note: secret } });
    assert.deepEqual(server.notes, [secret]);
    assert.deepEqual(server.calls, [3]);
    for (const value of [connected.manifests, connected.capabilities, output, events]) {
      assert.equal(JSON.stringify(value).includes(secret), false);
      assert.match(JSON.stringify(value), /\[redacted\]/u);
    }
    assert.equal(output.artifact.executedArgs.note, '[redacted]');
    assert.equal(events[0].args.note, '[redacted]');
    assert.equal(events.at(-1).args.note, '[redacted]');
  } finally { await connected?.close(); await server.close(); }
});

test('missing or invalid credentials and failed tool discovery reject the complete MCP assembly', async () => {
  const authorized = await fixture({ secret: 'correct-fixture-key' });
  const denied = await fixture({ denyMethod: 'tools/list' });
  const controller = new AbortController();
  try {
    await assert.rejects(connectMcp([authorized.config], { signal: controller.signal, env: {} }), error => error.kind === 'authentication');
    assert.equal(authorized.requests(), 0);
    await assert.rejects(connectMcp([authorized.config], { signal: controller.signal, env: { MCP_FIXTURE_KEY: 'wrong-key' } }), error => error.kind === 'mcp-connection');
    await assert.rejects(connectMcp([authorized.config, { ...denied.config, id: 'broken' }], { signal: controller.signal, env: { MCP_FIXTURE_KEY: 'correct-fixture-key' } }), error => error.kind === 'mcp-discovery');
    assert.deepEqual(authorized.calls, []);
    assert.deepEqual(denied.calls, []);
    await until(() => authorized.responses.size === 0 && denied.responses.size === 0);
  } finally { await authorized.close(); await denied.close(); }
});

test('tool failures remain errors and cancelling an in-flight MCP call closes its HTTP streams', async () => {
  const failed = await fixture({ fail: true, secret: 'failure-secret' });
  const slow = await fixture({ slow: true });
  const controller = new AbortController(), events = [];
  let failedConnection, slowConnection;
  try {
    failedConnection = await connectMcp([failed.config], { signal: controller.signal, env: { MCP_FIXTURE_KEY: 'failure-secret' }, onTool: event => events.push(event) });
    const output = await failedConnection.tools[0].invoke({ type: 'tool_call', id: 'failed-call', name: 'mcp_fixture_double', args: { value: 2 } });
    assert.equal(output.artifact.value.isError, true);
    assert.ok(events.at(-1).error);
    assert.equal(JSON.stringify(output).includes('failure-secret'), false);
    await failedConnection.close();
    slowConnection = await connectMcp([slow.config], { signal: controller.signal });
    const pending = slowConnection.tools[0].invoke({ value: 4 });
    const rejected = assert.rejects(pending);
    await slow.entered.promise;
    controller.abort(new DOMException('Cancelled fixture', 'AbortError'));
    await rejected;
    await slowConnection.close();
    await until(() => slow.responses.size === 0);
    assert.deepEqual(slow.calls, [4]);
  } finally { slow.release.resolve(); await failedConnection?.close(); await slowConnection?.close(); await failed.close(); await slow.close(); }
});

test('invalid and colliding MCP tool names fail instead of silently replacing capabilities', async () => {
  const invalid = await fixture({ toolName: 'invalid.name' });
  const duplicate = await fixture();
  const controller = new AbortController();
  try {
    await assert.rejects(connectMcp([invalid.config], { signal: controller.signal }), /名称无效或冲突/u);
    await assert.rejects(connectMcp([duplicate.config, duplicate.config], { signal: controller.signal }), /名称无效或冲突/u);
    assert.deepEqual(invalid.calls, []);
    assert.deepEqual(duplicate.calls, []);
  } finally { await invalid.close(); await duplicate.close(); }
});
