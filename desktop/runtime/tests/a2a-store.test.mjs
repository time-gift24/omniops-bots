import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { test } from 'node:test';
import SQLite from 'better-sqlite3';
import { Task } from '@a2a-js/sdk';
import { ServerCallContext } from '@a2a-js/sdk/server';
import { RequestMalformedError } from '@a2a-js/sdk/errors';
import { openA2AStore, principalOwner, taskResultSha256, RECEIPT_EXTENSION } from '../a2a/store.ts';
import { createA2AService } from '../a2a/index.ts';

const principal = { organizationId: 'organization', callerId: 'caller', installationId: 'installation' };
const fingerprint = value => createHash('sha256').update(value).digest('hex');
const context = (identity = principal, tenant = 'agent') => new ServerCallContext({
  tenant, requestedVersion: '1.0', user: { isAuthenticated: true, userName: principalOwner(identity) },
});
const task = state => Task.fromJSON({ id: randomUUID(), contextId: randomUUID(),
  status: { state, timestamp: new Date().toISOString() }, artifacts: [], history: [] });
const request = (messageId, identity = principal) => ({ principal: identity, messageId,
  fingerprint: fingerprint(messageId), agentId: 'agent', contentId: 'content-v1', context: context(identity) });

async function fixture(t, maxTaskBytes = 64 * 1024) {
  const directory = await mkdtemp(join(tmpdir(), 'omniops-a2a-store-'));
  let store = await openA2AStore({ directory, maxTaskBytes });
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  return {
    directory,
    get store() { return store; },
    async restart() { await store.close(); store = await openA2AStore({ directory, maxTaskBytes }); return store; },
  };
}

test('SDK SQLite atomic acceptance deduplicates before reserve, conflicts and rollback preserve original Task', async t => {
  const f = await fixture(t);
  if (process.platform !== 'win32') {
    assert.equal((await stat(f.directory)).mode & 0o777, 0o700);
    assert.equal((await stat(join(f.directory, 'a2a.sqlite'))).mode & 0o777, 0o600);
  }
  let reserves = 0;
  const original = task('TASK_STATE_WORKING');
  const accept = () => f.store.accept(request('same-message'), () => {
    reserves++;
    return { task: original, threadId: randomUUID(), runId: randomUUID() };
  });
  const accepted = await Promise.all([accept(), accept()]);
  assert.equal(reserves, 1);
  assert.deepEqual(accepted.map(result => result.fresh), [true, false]);
  assert.equal(accepted[1].task.id, original.id);
  await assert.rejects(f.store.accept({ ...request('same-message'), fingerprint: fingerprint('different') }, () => {
    assert.fail('conflict must not reserve');
  }), RequestMalformedError);
  // SDK save is an upsert; a second extension row with the same Task identity must roll that save back.
  const changed = structuredClone(original);
  changed.metadata = { shouldRollback: true };
  await assert.rejects(f.store.accept(request('second-message'), () => ({ task: changed })), { kind: 'storage' });
  assert.deepEqual(await f.store.taskStore.load(original.id, context()), original);
  assert.equal((await f.store.taskStore.list({ tenant: 'agent', pageSize: 50 }, context())).totalSize, 1);
  assert.equal(await f.store.taskStore.load(original.id, context({ ...principal, callerId: 'another' })), undefined);
  assert.equal((await f.store.taskStore.list({ tenant: 'agent', pageSize: 50 }, context({ ...principal, callerId: 'another' }))).totalSize, 0);
});

test('terminal Task, Artifact and SHA freeze atomically; receipt changes only the first project timestamp', async t => {
  const f = await fixture(t);
  const initial = task('TASK_STATE_WORKING');
  await f.store.accept(request('terminal'), () => ({ task: initial }));
  const terminal = structuredClone(initial);
  terminal.status.state = 3;
  terminal.artifacts = [{ artifactId: 'result', name: '', description: '', extensions: [], metadata: {},
    parts: [{ content: { $case: 'data', value: null }, metadata: {}, mediaType: 'application/json', filename: '' }] }];
  await f.store.taskStore.save(terminal, context());
  const saved = await f.store.taskStore.load(initial.id, context());
  assert.equal(saved.artifacts[0].parts[0].content.value, null);
  assert.equal(saved.artifacts[0].parts[0].content.$case, 'data');
  const digest = taskResultSha256(saved);
  assert.equal(saved.metadata[RECEIPT_EXTENSION].resultSha256, digest);
  await f.store.taskStore.save(saved, context());
  await assert.rejects(f.store.taskStore.save({ ...saved, metadata: { changed: true } }, context()), RequestMalformedError);
  await assert.rejects(f.store.taskStore.save({ ...saved, artifacts: [] }, context()), RequestMalformedError);
  await assert.rejects(f.store.confirm({ taskId: saved.id, resultSha256: '0'.repeat(64), receivedAt: new Date().toISOString() }, context()), RequestMalformedError);
  const receivedAt = '2026-10-22T01:00:00.000Z';
  const confirmation = { taskId: saved.id, resultSha256: digest };
  assert.deepEqual(await f.store.confirm({ ...confirmation, receivedAt }, context()), confirmation);
  assert.deepEqual(await f.store.confirm({ ...confirmation, receivedAt: '2026-10-22T02:00:00Z' }, context()), confirmation);
  assert.deepEqual(await f.store.taskStore.load(saved.id, context()), saved);
  const listing = await f.store.taskStore.list({ tenant: 'agent', pageSize: 1, includeArtifacts: true }, context());
  assert.equal(listing.tasks[0].artifacts[0].parts[0].content.value, null);
  const projected = await f.store.taskStore.list({ tenant: 'agent', pageSize: 1, historyLength: 0 }, context());
  assert.equal(projected.tasks[0].artifacts.length, 0);
  assert.equal(projected.tasks[0].history.length, 0);
  await f.restart();
  assert.deepEqual(await f.store.taskStore.load(saved.id, context()), saved);
  await f.store.close();
  const db = new SQLite(join(f.directory, 'a2a.sqlite'), { readonly: true });
  try {
    assert.equal(db.prepare('SELECT received_at FROM omniops_a2a_delivery').get().received_at, receivedAt);
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND type = 'table'").get().n, 3);
  } finally { db.close(); }
});

test('restart preserves sealed rejection and converts only unfinished Tasks to FAILED without execution', async t => {
  const f = await fixture(t);
  const unfinished = task('TASK_STATE_WORKING');
  const rejected = task('TASK_STATE_REJECTED');
  await f.store.accept(request('unfinished'), () => ({ task: unfinished, threadId: 'thread', runId: 'run' }));
  const busy = await f.store.accept(request('busy'), () => ({ task: rejected }));
  await f.restart();
  const recovered = await f.store.taskStore.load(unfinished.id, context());
  assert.equal(recovered.status.state, 4);
  const explanation = recovered.status.message;
  assert.equal(explanation.role, 2);
  assert.equal(explanation.taskId, unfinished.id);
  assert.equal(explanation.contextId, unfinished.contextId);
  assert.equal(explanation.parts[0].content.$case, 'text');
  assert.equal(explanation.parts[1].content.$case, 'data');
  assert.equal(explanation.parts[1].content.value.reasonCode, 'interrupted-unknown');
  assert.equal(explanation.parts[1].mediaType, 'application/json');
  assert.equal(explanation.parts[1].content.value.safeMessage, explanation.parts[0].content.value);
  assert.deepEqual(recovered.history.at(-1), explanation);
  assert.equal(recovered.metadata[RECEIPT_EXTENSION].resultSha256, taskResultSha256(recovered));
  assert.deepEqual(await f.store.taskStore.load(rejected.id, context()), busy.task);
  await f.restart();
  assert.deepEqual(await f.store.taskStore.load(unfinished.id, context()), recovered);
});

test('oversized acceptance rolls back and an existing database cannot have a second owning writer', async t => {
  const f = await fixture(t, 2048);
  const tooLarge = task('TASK_STATE_WORKING');
  tooLarge.metadata = { payload: 'x'.repeat(4096) };
  await assert.rejects(f.store.accept(request('large'), () => ({ task: tooLarge })), RequestMalformedError);
  assert.equal(await f.store.taskStore.load(tooLarge.id, context()), undefined);
  assert.equal((await f.store.taskStore.list({ tenant: 'agent', pageSize: 50 }, context())).totalSize, 0);
  await assert.rejects(openA2AStore({ directory: f.directory, maxTaskBytes: 2048 }), { kind: 'storage' });
});

test('closing or aborted wait before commit rolls fresh admission back without leaving a Task', async t => {
  const f = await fixture(t);
  const initial = task('TASK_STATE_WORKING');
  await assert.rejects(f.store.accept(request('closing'), () => ({ task: initial }), () => {
    throw new Error('fixture closing');
  }), { kind: 'storage' });
  assert.equal(await f.store.taskStore.load(initial.id, context()), undefined);
  const controller = new AbortController();
  const c = context();
  c.state.set('omniops.waitSignal', controller.signal);
  await assert.rejects(f.store.accept({ ...request('abort'), context: c }, () => {
    controller.abort();
    return { task: initial };
  }), { kind: 'aborted' });
  assert.equal(await f.store.taskStore.load(initial.id, context()), undefined);
});

test('startup rejects corrupt payloads and missing associations without rebuilding data', async t => {
  const f = await fixture(t);
  const saved = (await f.store.accept(request('corrupt'), () => ({ task: task('TASK_STATE_COMPLETED') }))).task;
  await f.store.close();
  const db = new SQLite(join(f.directory, 'a2a.sqlite'));
  db.prepare('UPDATE a2a_tasks SET artifacts = ?').run('{broken-secret-json');
  db.close();
  await assert.rejects(openA2AStore({ directory: f.directory, maxTaskBytes: 64 * 1024 }), { kind: 'storage' });
  const repaired = new SQLite(join(f.directory, 'a2a.sqlite'));
  repaired.prepare('UPDATE a2a_tasks SET artifacts = NULL').run();
  repaired.prepare('DELETE FROM omniops_a2a_delivery').run();
  assert.equal(repaired.prepare('SELECT id FROM a2a_tasks').get().id, saved.id);
  repaired.close();
  await assert.rejects(openA2AStore({ directory: f.directory, maxTaskBytes: 64 * 1024 }), { kind: 'storage' });
});

test('recovery Task and seal roll back together when extension update fails', async t => {
  const f = await fixture(t);
  const initial = task('TASK_STATE_WORKING');
  await f.store.accept(request('recovery-rollback'), () => ({ task: initial }));
  await f.store.close();
  const db = new SQLite(join(f.directory, 'a2a.sqlite'));
  db.exec("CREATE TRIGGER fail_seal BEFORE UPDATE OF result_sha256 ON omniops_a2a_delivery BEGIN SELECT RAISE(ABORT, 'fixture'); END");
  db.close();
  await assert.rejects(openA2AStore({ directory: f.directory, maxTaskBytes: 64 * 1024 }), { kind: 'storage' });
  const inspect = new SQLite(join(f.directory, 'a2a.sqlite'));
  assert.equal(inspect.prepare('SELECT status_state FROM a2a_tasks').get().status_state, 'TASK_STATE_WORKING');
  assert.equal(inspect.prepare('SELECT result_sha256 FROM omniops_a2a_delivery').get().result_sha256, null);
  inspect.exec('DROP TRIGGER fail_seal');
  inspect.close();
  await f.restart();
  assert.equal((await f.store.taskStore.load(initial.id, context())).status.state, 4);
});

test('receipt transaction failure leaves sealed Task and first timestamp untouched and retryable', async t => {
  const f = await fixture(t);
  const sealed = (await f.store.accept(request('receipt-failure'), () => ({ task: task('TASK_STATE_COMPLETED') }))).task;
  await f.store.close();
  const db = new SQLite(join(f.directory, 'a2a.sqlite'));
  db.exec("CREATE TRIGGER fail_receipt BEFORE UPDATE OF received_at ON omniops_a2a_delivery BEGIN SELECT RAISE(ABORT, 'fixture'); END");
  db.close();
  await f.restart();
  const receipt = { taskId: sealed.id, resultSha256: taskResultSha256(sealed), receivedAt: new Date().toISOString() };
  await assert.rejects(f.store.confirm(receipt, context()), { kind: 'storage' });
  assert.deepEqual(await f.store.taskStore.load(sealed.id, context()), sealed);
  await f.store.close();
  const inspect = new SQLite(join(f.directory, 'a2a.sqlite'));
  assert.equal(inspect.prepare('SELECT received_at FROM omniops_a2a_delivery').get().received_at, null);
  inspect.exec('DROP TRIGGER fail_receipt');
  inspect.close();
  await f.restart();
  assert.deepEqual(await f.store.confirm(receipt, context()), { taskId: sealed.id, resultSha256: receipt.resultSha256 });
});

test('raw nested corruption fails safely before SDK coercion and never prints persisted values', async t => {
  const f = await fixture(t);
  await f.store.accept(request('nested-corruption'), () => ({ task: task('TASK_STATE_WORKING') }));
  await f.store.close();
  const corruptions = [
    { artifacts: [{ artifactId: 'artifact', parts: [{ metadata: { secret: 'fixture secret' } }] }] },
    { artifacts: [{ artifactId: 'artifact', parts: [{ data: {}, text: 'two oneof values' }] }] },
    { artifacts: [{ artifactId: 12, parts: [{ data: {} }] }] },
    { artifacts: [{ artifactId: 'artifact', parts: [] }] },
    { history: [{ messageId: 'message', role: 'ROLE_UNSPECIFIED', parts: [{ text: 'fixture secret' }] }] },
    { history: [{ messageId: 'message', role: 'ROLE_USER', parts: [{ text: 12 }] }] },
  ];
  const childSource = `import {openA2AStore} from ${JSON.stringify(new URL('../a2a/store.ts', import.meta.url).href)};
    try { const store=await openA2AStore({directory:process.argv[1],maxTaskBytes:65536}); await store.close(); process.exitCode=1; }
    catch(error) { if(error.kind!=='storage') throw error; }`;
  for (const values of corruptions) {
    const db = new SQLite(join(f.directory, 'a2a.sqlite'));
    db.prepare('UPDATE a2a_tasks SET artifacts = ?, history = ?')
      .run(values.artifacts ? JSON.stringify(values.artifacts) : null, values.history ? JSON.stringify(values.history) : null);
    db.close();
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', childSource, f.directory], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  }
});

const serviceOptions = directory => ({ directory,
  runtime: { reserveRun() { assert.fail('directory validation must not start an execution'); } },
  resolveEndpoint: async () => assert.fail('directory validation must not resolve an endpoint'),
  limits: { maxTaskBytes: 65536, maxRequestBytes: 32768, maxJsonDepth: 20, maxWaiters: 2, maxSubscriptions: 2 },
});

test('public construction accepts dedicated empty/reopen directories without chmod of existing directories', async t => {
  const root = await mkdtemp(join(tmpdir(), 'omniops-a2a-directories-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'dedicated');
  await mkdir(directory, { mode: 0o755 });
  if (process.platform !== 'win32') await chmod(directory, 0o755);
  const originalMode = (await stat(directory)).mode;
  const first = await createA2AService(serviceOptions(directory));
  await first.close({ deadline: performance.now() + 1000 });
  assert.equal((await stat(directory)).mode, originalMode);
  const reopened = await createA2AService(serviceOptions(directory));
  await reopened.close({ deadline: performance.now() + 1000 });
  assert.equal((await stat(directory)).mode, originalMode);
  if (process.platform !== 'win32') assert.equal((await stat(join(directory, 'a2a.sqlite'))).mode & 0o777, 0o600);
  const created = join(root, 'new', 'a2a');
  const fresh = await createA2AService(serviceOptions(created));
  await fresh.close({ deadline: performance.now() + 1000 });
  if (process.platform !== 'win32') assert.equal((await stat(created)).mode & 0o777, 0o700);
});

test('public construction rejects unrelated directories, root/home/tmp and unknown databases without chmod', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'omniops-a2a-not-owned-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  if (process.platform !== 'win32') await chmod(directory, 0o755);
  const originalMode = (await stat(directory)).mode;
  const unrelated = join(directory, 'other-project.txt');
  await writeFile(unrelated, 'keep this directory and file');
  await assert.rejects(createA2AService(serviceOptions(directory)), { kind: 'invalid-request' });
  assert.equal((await stat(directory)).mode, originalMode);
  assert.equal(await readFile(unrelated, 'utf8'), 'keep this directory and file');
  await assert.rejects(lstat(join(directory, 'a2a.sqlite')), { code: 'ENOENT' });
  for (const shared of new Set([parse(homedir()).root, homedir(), tmpdir()])) {
    const before = (await stat(shared)).mode;
    await assert.rejects(createA2AService(serviceOptions(shared)), { kind: 'invalid-request' });
    assert.equal((await stat(shared)).mode, before);
  }
  await rm(unrelated);
  const database = join(directory, 'a2a.sqlite');
  await writeFile(database, 'unrelated content', { mode: 0o644 });
  const fileMode = (await stat(database)).mode;
  await assert.rejects(createA2AService(serviceOptions(directory)), { kind: 'storage' });
  assert.equal((await stat(directory)).mode, originalMode);
  assert.equal((await stat(database)).mode, fileMode);
  assert.equal(await readFile(database, 'utf8'), 'unrelated content');
});
