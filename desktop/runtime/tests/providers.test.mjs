import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createProviderCatalog } from '../providers.ts';
import { safeError } from '../errors.ts';

const id = (provider, model = 'shared') => JSON.stringify([provider, model]);
const selection = (provider, model = 'shared') => ({ provider, model });
const input = (name, baseURL = 'http://localhost:9000/prefix/v1', extra = {}) => ({ name, baseURL, models: ['shared', 'second'], ...extra });

async function setup(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'provider-catalog-'));
  const file = join(directory, 'providers.json');
  const keys = new Map();
  const calls = [];
  const credentials = {
    async get(ref) { calls.push(['get', ref]); return keys.get(ref) ?? null; },
    async set(ref, value) { calls.push(['set', ref]); keys.set(ref, value); },
    async delete(ref) { calls.push(['delete', ref]); keys.delete(ref); },
  };
  const catalog = await createProviderCatalog({ file, credentials, ...options });
  t.after(async () => { await catalog.close(); await rm(directory, { recursive: true, force: true }); });
  return { catalog, keys, calls, credentials, file };
}

async function modelServer(t) {
  const requests = [];
  let mode = 'normal';
  let seen;
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    requests.push({ path: request.url, headers: request.headers, body, closed: new Promise(resolve => response.once('close', resolve)) });
    seen?.();
    if (mode === 'redirect') { response.writeHead(307, { location: '/redirected' }); response.end(); return; }
    if (typeof mode === 'number') {
      response.writeHead(mode, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'private-upstream-body-key', code: body.model === 'not-real' ? 'model_not_found' : 'unknown' } }));
      return;
    }
    response.writeHead(200, { 'content-type': mode === 'wrong-type' ? 'application/json' : 'text/event-stream' });
    response.flushHeaders();
    if (mode === 'hold') return;
    const chunk = (delta, finish_reason = null, index = 0) => `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index, delta, finish_reason }] })}\n\n`;
    response.write(chunk({ role: 'assistant', content: mode === 'malformed' ? ['invalid content'] : 'OK' }));
    if (mode === 'hold-after-text') return;
    if (mode === 'tools') response.write(chunk({ tool_calls: [{ index: 0, id: 'call-check', type: 'function', function: { name: 'check', arguments: '{}' } }] }));
    if (mode !== 'no-finish') response.write(chunk({}, mode === 'length' ? 'length' : mode === 'filtered' ? 'content_filter' : mode === 'tools' ? 'tool_calls' : 'stop'));
    if (mode === 'unfinished-choice') response.write(chunk({ content: 'unfinished second choice' }, null, 1));
    response.end(mode === 'no-done' ? '' : 'data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return {
    baseURL: `http://127.0.0.1:${server.address().port}/gateway/root/v1`, requests,
    mode(value) { mode = value; },
    nextRequest() { return new Promise(resolve => { seen = resolve; }); },
  };
}

test('multiple providers, explicit defaults and model names survive persistence without exposing keys', async t => {
  const f = await setup(t);
  await assert.rejects(f.catalog.pin(), { kind: 'unavailable' });
  await f.catalog.save(input('公司', undefined, { apiKey: 'company-secret' }));
  await f.catalog.save(input('本地'));
  assert.equal(f.calls.filter(([method]) => method === 'get').length, 0, 'listing never retrieves key values');
  assert.deepEqual((await f.catalog.read()).providers.map(provider => [provider.name, provider.hasKey]), [['公司', true], ['本地', false]]);
  const fixed = await f.catalog.pin(id('公司'));
  await f.catalog.setDefault(selection('本地'));
  assert.equal((await f.catalog.pin()).id, id('本地'));
  assert.deepEqual(await f.catalog.models(), [
    { id: id('公司'), label: '公司 / shared', isDefault: false },
    { id: id('公司', 'second'), label: '公司 / second', isDefault: false },
    { id: id('本地'), label: '本地 / shared', isDefault: true },
    { id: id('本地', 'second'), label: '本地 / second', isDefault: false },
  ]);
  await f.catalog.save(input('公司', undefined, { originalName: '公司', models: ['shared', 'second', 'third'] }));
  assert.deepEqual(await f.catalog.pin(id('公司')), fixed, 'unrelated model/default edits preserve the binding');
  const reopened = await createProviderCatalog({ file: f.file, credentials: f.credentials });
  t.after(() => reopened.close());
  assert.equal((await reopened.pin()).id, id('本地'));
  assert.doesNotMatch(await readFile(f.file, 'utf8'), /company-secret|apiKey/);
  assert.doesNotMatch(JSON.stringify(fixed), /company-secret/);
  assert.equal(f.catalog.redact('company-secret'), '[redacted]');
  await f.catalog.remove('本地');
  assert.equal((await f.catalog.read()).defaultModel, null);
  await assert.rejects(f.catalog.pin(), { kind: 'unavailable' });
});

test('keys are immutable references, preserve on omitted input, and cleared/replaced bindings cannot silently rebind', async t => {
  const f = await setup(t);
  await f.catalog.save(input('one', undefined, { apiKey: 'old-secret' }));
  await f.catalog.setDefault(selection('one'));
  const original = await f.catalog.pin();
  await f.catalog.save(input('one', undefined, { originalName: 'one' }));
  assert.deepEqual(await f.catalog.pin(), original);
  await f.catalog.save(input('one', undefined, { originalName: 'one', apiKey: 'new-secret' }));
  const replaced = await f.catalog.pin();
  assert.notEqual(replaced.credentialRef, original.credentialRef);
  assert.equal(f.keys.has(original.credentialRef), false);
  await assert.rejects(f.catalog.createModel(original), { kind: 'unavailable' });
  await f.catalog.save(input('one', undefined, { originalName: 'one', apiKey: null }));
  assert.equal((await f.catalog.pin()).credentialRef, null);
  await assert.rejects(f.catalog.createModel(replaced), { kind: 'unavailable' });
  const beforeRemoval = await f.catalog.pin();
  await f.catalog.remove('one');
  await f.catalog.save(input('one'));
  await assert.rejects(f.catalog.createModel(beforeRemoval), { kind: 'unavailable' });
});

test('redaction preserves its markers and masks short and overlapping keys in one pass', async t => {
  const f = await setup(t);
  for (const [name, apiKey] of [['short', 'a'], ['long', 'abc'], ['overlap', 'ab']]) await f.catalog.save(input(name, undefined, { apiKey }));
  const result = f.catalog.redact('keep a abc ab [redacted]');
  assert.equal(result, 'keep [redacted] [redacted] [redacted] [redacted]');
  assert.equal(f.catalog.redact(result), result);
});

test('invalid fields and duplicate models fail before touching credentials', async t => {
  const f = await setup(t);
  for (const value of [
    input(''), input('x'.repeat(65)), input('x', 'https://user:secret@example.org/v1'),
    input('x', 'https://example.org/v1?key=secret'), input('x', 'https://example.org/v1#secret'),
    input('x', 'https://example.org/v1?'), input('x', 'https://example.org/v1#'),
    input('x', 'file:///tmp/model'), input('x', undefined, { models: ['same', 'same'] }),
    input('x', undefined, { models: ['m'.repeat(129)] }), input('x', undefined, { apiKey: 'secret\nheader' }),
    input('x', undefined, { apiKey: '密'.repeat(854) }),
    input('"'.repeat(64), undefined, { models: ['"'.repeat(128)] }),
  ]) await assert.rejects(f.catalog.save(value), { kind: 'invalid-request' });
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await f.catalog.read(), { providers: [], defaultModel: null });
  await f.catalog.save(input('one'));
  await assert.rejects(f.catalog.save(input('one')), { kind: 'invalid-request' });
  await assert.rejects(f.catalog.setDefault(selection('one', 'missing')), { kind: 'unavailable' });
});

test('atomic file failure preserves effective configuration and old key; credential failure never commits', async t => {
  const f = await setup(t);
  await f.catalog.save(input('one', undefined, { apiKey: 'old-secret' }));
  const fixed = await f.catalog.pin(id('one'));
  await rename(f.file, `${f.file}.backup`);
  await mkdir(f.file);
  await assert.rejects(f.catalog.save(input('one', undefined, { originalName: 'one', apiKey: 'new-secret' })), { kind: 'storage' });
  assert.deepEqual(await f.catalog.pin(id('one')), fixed);
  assert.deepEqual([...f.keys.values()], ['old-secret']);
  await rm(f.file, { recursive: true });
  await rename(`${f.file}.backup`, f.file);
  assert.equal((await f.catalog.read()).providers[0].hasKey, true);
  f.credentials.set = async () => { throw new Error('locked-secret'); };
  await assert.rejects(f.catalog.save(input('one', undefined, { originalName: 'one', apiKey: 'replacement' })), { kind: 'credentials' });
  assert.deepEqual(await f.catalog.pin(id('one')), fixed);
  assert.equal(f.keys.get(fixed.credentialRef), 'old-secret');
});

test('broken files remain visible/retryable and never import legacy over them', async t => {
  const f = await setup(t);
  await writeFile(f.file, '{broken');
  const reopened = await createProviderCatalog({ file: f.file, credentials: f.credentials, legacy: { model: 'legacy', apiKey: 'legacy-key' } });
  t.after(() => reopened.close());
  await assert.rejects(reopened.read(), { kind: 'storage' });
  await assert.rejects(reopened.save(input('new')), { kind: 'storage' });
  assert.equal(f.keys.size, 0);
  assert.equal(await readFile(f.file, 'utf8'), '{broken');
  await writeFile(f.file, JSON.stringify({ version: 1, providers: [], defaultModel: null }));
  assert.deepEqual(await reopened.read(), { providers: [], defaultModel: null });
});

test('legacy import writes the key to the credential store and never into ordinary configuration', async t => {
  const f = await setup(t, { legacy: { model: 'legacy-model', baseURL: 'http://localhost:9000/custom/v1', apiKey: 'legacy-secret' } });
  assert.equal((await f.catalog.pin()).model, 'legacy-model');
  assert.deepEqual([...f.keys.values()], ['legacy-secret']);
  assert.doesNotMatch(await readFile(f.file, 'utf8'), /legacy-secret|apiKey/);
  const reopened = await createProviderCatalog({ file: f.file, credentials: f.credentials, legacy: { model: 'other', apiKey: 'other-secret' } });
  t.after(() => reopened.close());
  assert.equal((await reopened.pin()).model, 'legacy-model');
});

test('manual testing uses exact base path/model, sends only fixed text, and omits auth despite ambient OpenAI env', async t => {
  const server = await modelServer(t);
  const f = await setup(t);
  const previous = { OPENAI_API_KEY: process.env.OPENAI_API_KEY, OPENAI_ADMIN_KEY: process.env.OPENAI_ADMIN_KEY, OPENAI_ORG_ID: process.env.OPENAI_ORG_ID, OPENAI_PROJECT_ID: process.env.OPENAI_PROJECT_ID, OPENAI_CUSTOM_HEADERS: process.env.OPENAI_CUSTOM_HEADERS, OPENAI_LOG: process.env.OPENAI_LOG };
  Object.assign(process.env, { OPENAI_API_KEY: 'ambient-key', OPENAI_ADMIN_KEY: 'ambient-admin-key', OPENAI_ORG_ID: 'ambient-org', OPENAI_PROJECT_ID: 'ambient-project', OPENAI_CUSTOM_HEADERS: 'X-Api-Key: ambient-custom-secret', OPENAI_LOG: 'debug' });
  t.after(() => { for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
  await f.catalog.save(input('auth', server.baseURL, { apiKey: 'actual-provider-key' }));
  await f.catalog.save(input('local', server.baseURL));
  assert.equal(server.requests.length, 0, 'save does not send a test');
  await f.catalog.test(selection('auth'));
  await f.catalog.test(selection('local'));
  assert.equal(server.requests.length, 2);
  for (const request of server.requests) {
    assert.equal(request.path, '/gateway/root/v1/chat/completions');
    assert.equal(request.body.model, 'shared');
    assert.deepEqual(request.body.messages, [{ role: 'user', content: 'Reply OK.' }]);
    assert.equal(request.body.tools, undefined);
    assert.equal(request.body.max_tokens, 8);
    assert.equal(request.headers['openai-organization'], undefined);
    assert.equal(request.headers['openai-project'], undefined);
    assert.equal(request.headers['x-api-key'], undefined);
  }
  assert.equal(server.requests[0].headers.authorization, 'Bearer actual-provider-key');
  assert.equal(server.requests[1].headers.authorization, undefined);
  assert.equal(server.requests[1].headers['api-key'], undefined);
});

test('missing/locked credentials fail before any request and never fall back to no authentication', async t => {
  const server = await modelServer(t);
  const f = await setup(t);
  await f.catalog.save(input('one', server.baseURL, { apiKey: 'private-key' }));
  f.keys.clear();
  await assert.rejects(f.catalog.test(selection('one')), { kind: 'credentials' });
  f.credentials.get = async () => { throw new Error('private-key locked'); };
  await assert.rejects(f.catalog.test(selection('one')), error => {
    assert.equal(error.kind, 'credentials');
    assert.doesNotMatch(JSON.stringify(safeError(error)), /private-key|locked/);
    return true;
  });
  assert.equal(server.requests.length, 0);
});

test('cancellation, timeout, malformed and unfinished streams never report success or retry', async t => {
  const server = await modelServer(t);
  const f = await setup(t);
  await f.catalog.save(input('one', server.baseURL));
  for (const mode of ['no-finish', 'no-done', 'malformed']) {
    server.mode(mode);
    await assert.rejects(f.catalog.test(selection('one')), { kind: 'incomplete-response' });
  }
  server.mode('hold');
  const controller = new AbortController();
  const sent = server.nextRequest();
  const pending = f.catalog.test(selection('one'), { signal: controller.signal });
  await sent;
  controller.abort();
  await assert.rejects(pending, { kind: 'aborted' });
  await assert.rejects(f.catalog.test(selection('one'), { signal: AbortSignal.timeout(80) }), { kind: 'timeout' });
  assert.equal(server.requests.length, 5);
});

test('production streams require SSE and every choice to finish before DONE, and cancellation closes the body', { timeout: 5000 }, async t => {
  const server = await modelServer(t);
  const f = await setup(t);
  await f.catalog.save(input('one', server.baseURL));
  const binding = await f.catalog.pin(id('one'));
  const consume = async () => {
    const model = await f.catalog.createModel(binding);
    const chunks = [];
    for await (const chunk of await model.stream('production text')) chunks.push(chunk);
    return chunks;
  };
  for (const mode of ['wrong-type', 'no-finish', 'no-done', 'length', 'filtered', 'unfinished-choice']) {
    server.mode(mode);
    await assert.rejects(consume(), error => {
      assert.equal(error.kind ?? error.cause?.kind, 'incomplete-response', mode);
      return true;
    });
    await server.requests.at(-1).closed;
  }
  server.mode('normal');
  assert.equal((await consume()).at(-1).response_metadata.finish_reason, 'stop');
  server.mode('tools');
  assert.equal((await consume()).at(-1).response_metadata.finish_reason, 'tool_calls');
  server.mode('hold-after-text');
  const model = await f.catalog.createModel(binding);
  const controller = new AbortController();
  for await (const chunk of await model.stream('cancel body', { signal: controller.signal })) {
    assert.equal(chunk.content, 'OK');
    controller.abort();
    break;
  }
  await Promise.race([server.requests.at(-1).closed, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Model body was not cancelled')), 1000); timer.unref(); })]);
  assert.equal(server.requests.length, 9, 'malformed generations are never retried');
});

test('upstream failures are classified safely and redirects never forward the key', async t => {
  const server = await modelServer(t);
  const f = await setup(t);
  await f.catalog.save(input('one', server.baseURL, { apiKey: 'private-upstream-body-key', models: ['shared', 'not-real'] }));
  for (const [status, kind] of [[401, 'authentication'], [429, 'rate-limited'], [404, 'upstream'], [503, 'upstream']]) {
    server.mode(status);
    await assert.rejects(f.catalog.test(selection('one')), error => {
      assert.equal(error.kind, kind);
      assert.doesNotMatch(JSON.stringify(safeError(error)), /private-upstream-body-key/);
      return true;
    });
  }
  server.mode(404);
  await assert.rejects(f.catalog.test(selection('one', 'not-real')), { kind: 'model-unavailable' });
  server.mode('redirect');
  await assert.rejects(f.catalog.test(selection('one')), { kind: 'connection' });
  assert.equal(server.requests.length, 6);
});

test('a previously created model rechecks identity before sending and close cancels active tests', async t => {
  const server = await modelServer(t);
  const f = await setup(t);
  await f.catalog.save(input('one', server.baseURL));
  const model = await f.catalog.createModel(await f.catalog.pin(id('one')));
  await f.catalog.save(input('one', `${server.baseURL}/changed`, { originalName: 'one' }));
  await assert.rejects(model.invoke('do not send'));
  assert.equal(server.requests.length, 0);
  await f.catalog.save(input('one', server.baseURL, { originalName: 'one' }));
  server.mode('hold');
  const sent = server.nextRequest();
  const pending = f.catalog.test(selection('one'));
  await sent;
  await f.catalog.close();
  await assert.rejects(pending, { kind: 'aborted' });
  await assert.rejects(f.catalog.models(), { kind: 'unavailable' });
});
