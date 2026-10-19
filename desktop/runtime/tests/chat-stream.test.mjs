import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage } from '@langchain/core/messages';
import { Annotation, END, MemorySaver, START, StateGraph } from '@langchain/langgraph';
import { createExecution } from '../execution/index.ts';
import { createChatRun } from '../chat/adapter.mjs';
import { createDesktopRuntime } from '../runtime.mjs';
import { createResources } from '../resources.mjs';

async function until(check) {
  const deadline = Date.now() + 3000;
  while (!check() && Date.now() < deadline) await delay(5);
  assert.ok(check(), 'Expected live text before the model response completes');
}
async function streamingModel() {
  const release = Promise.withResolvers();
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const text = String(body.messages.at(-1).content);
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const send = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ id: `chatcmpl-${text}`, object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    send({ role: 'assistant' });
    send({ content: text.slice(0, 2) });
    send({ content: text.slice(2) });
    await release.promise;
    if (!response.destroyed) { send({}, 'stop'); response.end('data: [DONE]\n\n'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    release,
    model: () => new ChatOpenAI({ model: 'fixture', apiKey: 'fixture-key', useResponsesApi: false, maxRetries: 0,
      configuration: { baseURL: `http://127.0.0.1:${server.address().port}/v1` } }),
    async close() { release.resolve(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}

test('chat publishes native v3 text before completion and final snapshot does not repeat deltas', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chat-live-stream-'));
  const fixture = await streamingModel();
  const events = [];
  let runtime;
  try {
    runtime = await createDesktopRuntime({
      runsDir: join(directory, 'runs'), resources: createResources({ homeDir: directory }), checkpointer: new MemorySaver(),
      modelName: 'fixture', modelFactory: fixture.model, emit: event => events.push(event), workspace: {},
      browser: { getState: () => ({}), subscribe() {}, async close() {} },
    });
    runtime.dispatch('chat_start', { runId: 'stream', threadId: 'stream', request: { messages: [{ role: 'user', text: 'stream-proof' }] } });
    await until(() => events.some(event => event.data?.type === 'delta'));
    assert.equal(runtime.getState().task.phase, 'running');
    assert.equal(events.some(event => event.data?.type === 'completed'), false);
    fixture.release.resolve();
    await until(() => runtime.getState().task === null);
    const chat = events.filter(event => event.event === 'chat_event').map(event => event.data);
    assert.equal(chat.filter(event => event.type === 'delta').map(event => event.text).join(''), 'stream-proof');
    assert.equal(chat.filter(event => event.type === 'part-started').length, 1);
    const terminal = chat.at(-1);
    assert.equal(terminal.type, 'completed');
    assert.deepEqual(terminal.response.assistant.parts, [{ type: 'text', text: 'stream-proof' }]);
  } finally { fixture.release.resolve(); await runtime?.close(); await fixture.close(); await rm(directory, { recursive: true, force: true }); }
});

test('native parallel message namespaces retain separate message IDs and text parts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chat-stream-identities-'));
  const fixture = await streamingModel();
  const execution = await createExecution({ recordsDirectory: directory, checkpointer: new MemorySaver() });
  const events = [];
  const run = { id: 'messages', threadId: 'messages', input: { title: 'Messages' }, request: { messages: [] }, controller: new AbortController() };
  const chat = createChatRun({ run, redact: String, emit: event => events.push(event) });
  let pending;
  try {
    const state = Annotation.Root({ messages: Annotation({ reducer: (left, right) => left.concat(right), default: () => [] }) });
    pending = execution.execute({ runId: run.id, threadId: run.threadId, timeoutMs: 5000, onEvent: chat.onEvent,
      prepare(scope) {
        const graph = new StateGraph(state);
        for (const name of ['alpha', 'beta']) graph.addNode(name, async () => ({ messages: [await fixture.model().invoke([new HumanMessage(name)])] })).addEdge(START, name).addEdge(name, END);
        return { graph: graph.compile({ checkpointer: scope.checkpointer }), input: { messages: [] } };
      },
    });
    await until(() => events.filter(event => event.data?.type === 'part-started').length === 2);
    const text = new Map();
    for (const { data } of events) if (data.type === 'delta') text.set(data.partId, (text.get(data.partId) ?? '') + data.text);
    assert.deepEqual([...text.values()].sort(), ['alpha', 'beta']);
    fixture.release.resolve();
    const outcome = await pending;
    assert.equal(outcome.ok, true);
    assert.deepEqual(outcome.output.messages.map(message => message.id).sort(), ['chatcmpl-alpha', 'chatcmpl-beta']);
  } finally { fixture.release.resolve(); await pending; await execution.close(); await fixture.close(); await rm(directory, { recursive: true, force: true }); }
});
