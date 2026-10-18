import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import readline from 'node:readline';

test('JSONL entry returns structured safe errors, exact snapshots and clean shutdown without a configured model', { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omniops-bots-ipc-'));
  const child = spawn(process.execPath, ['main.mjs'], { cwd: new URL('..', import.meta.url), env: {
    ...process.env, OMNIOPS_BOTS_DATA_DIR: directory, OMNIOPS_BOTS_LOCAL_ROOT: join(directory, 'local'), OMNIOPS_BOTS_MODEL: '', OPENAI_API_KEY: '', OPENAI_BASE_URL: '',
    OMNIOPS_BOTS_BROWSER_CDP_ENDPOINT: 'http://127.0.0.1:1', OMNIOPS_BOTS_BROWSER_TARGET_ID: 'fixture-only',
  }, stdio: ['pipe', 'pipe', 'pipe'] });
  let id = 0;
  const pending = new Map(), ready = Promise.withResolvers(), exited = Promise.withResolvers();
  const events = [];
  child.on('error', error => { ready.reject(error); exited.reject(error); });
  child.on('exit', code => { exited.resolve(code); ready.reject(new Error(`Exited before ready: ${code}`)); });
  readline.createInterface({ input: child.stdout }).on('line', line => {
    const message = JSON.parse(line);
    if (message.event === 'ready') ready.resolve(message);
    if (message.event) events.push(message);
    pending.get(message.id)?.resolve(message);
    pending.delete(message.id);
  });
  const rpc = (method, params) => {
    const sequence = ++id, response = Promise.withResolvers();
    pending.set(sequence, response);
    child.stdin.write(JSON.stringify({ id: sequence, method, params }) + '\n');
    return response.promise;
  };
  try {
    await ready.promise;
    const status = (await rpc('status')).result;
    assert.deepEqual(Object.keys(status).sort(), ['browser', 'browserRequest', 'simulated', 'task']);
    assert.equal(status.simulated, false);
    assert.deepEqual((await rpc('models_list')).result, []);
    const failure = await rpc('chat_start', { runId: 'test', threadId: 'test', request: { messages: [{ role: 'user', text: 'hello' }] } });
    assert.equal(failure.error.kind, 'unavailable');
    assert.equal(typeof failure.error.message, 'string');
    assert.equal((await rpc('agent_run', { task: 'bypass' })).error.kind, 'invalid-request');
    assert.equal((await rpc('script_run', { name: 'bypass.mjs' })).error.kind, 'invalid-request');
    assert.deepEqual((await rpc('shutdown')).result, { stopped: true });
    assert.equal(await exited.promise, 0);
    assert.ok(events.some(event => event.event === 'exit'));
  } finally { child.kill('SIGKILL'); await exited.promise; await rm(directory, { recursive: true, force: true }); }
});
