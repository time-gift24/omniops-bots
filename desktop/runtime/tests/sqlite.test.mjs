import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { emptyCheckpoint } from '@langchain/langgraph-checkpoint';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { openSqliteCheckpointer } from '../execution/sqlite.ts';
import { createExecution } from '../execution/index.ts';

const metadata = { source: 'input', step: -1, parents: {} };

test('native SQLite persists graph roots, subgraph namespaces and pending writes across reopening', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omniops-sqlite-'));
  const file = join(directory, 'checkpoints.sqlite');
  let store;
  try {
    store = await openSqliteCheckpointer(file);
    assert.equal(store.checkpointer.db.pragma('journal_mode', { simple: true }), 'wal');
    assert.equal(store.checkpointer.db.pragma('synchronous', { simple: true }), 2);
    assert.equal(store.checkpointer.db.pragma('busy_timeout', { simple: true }), 5000);
    assert.equal(store.checkpointer.db.pragma('max_page_count', { simple: true }) * store.checkpointer.db.pragma('page_size', { simple: true }), 512 * 1024 * 1024);
    assert.equal(store.checkpointer.db.pragma('journal_size_limit', { simple: true }), 8 * 1024 * 1024);
    const state = Annotation.Root({ answer: Annotation() });
    const child = new StateGraph(state).addNode('generate', () => ({ answer: 'persisted' }))
      .addEdge(START, 'generate').addEdge('generate', END).compile();
    const graph = new StateGraph(state).addNode('child', child)
      .addEdge(START, 'child').addEdge('child', END).compile({ checkpointer: store.checkpointer });
    assert.equal((await graph.invoke({}, { configurable: { thread_id: 'graph-run-one' } })).answer, 'persisted');
    const config = { configurable: { thread_id: 'graph-run-two', checkpoint_ns: 'child:proof' } };
    const checkpoint = emptyCheckpoint();
    checkpoint.channel_values.answer = 'separate run';
    const saved = await store.checkpointer.put(config, checkpoint, metadata, {});
    // close must wait for a write whose serializer has yielded before SQLite commits.
    const bytes = new Uint8Array([0, 255, 65, 128]);
    const pending = store.checkpointer.putWrites(saved, [['answer', 'pending value'], ['binary', bytes]], 'task-one', 'branch/one');
    await store.close();
    await pending;
    store = await openSqliteCheckpointer(file);
    const root = await store.checkpointer.getTuple({ configurable: { thread_id: 'graph-run-one', checkpoint_ns: '' } });
    assert.equal(root.checkpoint.channel_values.answer, 'persisted');
    assert.ok(root.parentConfig.configurable.checkpoint_id);
    const tuples = [];
    for await (const tuple of store.checkpointer.list({ configurable: { thread_id: 'graph-run-one' } })) tuples.push(tuple);
    assert.ok(tuples.some(tuple => tuple.config.configurable.checkpoint_ns.startsWith('child:')));
    const other = await store.checkpointer.getTuple(saved);
    assert.equal(other.checkpoint.channel_values.answer, 'separate run');
    assert.deepEqual(other.pendingWrites, [['task-one', 'answer', 'pending value'], ['task-one', 'binary', bytes]]);
    for await (const tuple of store.checkpointer.list({ configurable: { thread_id: 'graph-run-two' } })) {
      assert.deepEqual(tuple.pendingWrites, other.pendingWrites);
    }
    assert.equal(await store.checkpointer.getTuple({ configurable: { thread_id: 'missing', checkpoint_ns: '' } }), undefined);
    if (process.platform !== 'win32') {
      assert.equal((await stat(directory)).mode & 0o777, 0o700);
      for (const suffix of ['', '-wal', '-shm']) assert.equal((await stat(file + suffix)).mode & 0o777, 0o600);
    }
    store.checkpointer.db.prepare("UPDATE writes SET type='future-encoding' WHERE type='bytes'").run();
    await store.close();
    await assert.rejects(openSqliteCheckpointer(file), error => /serialization/.test(error.cause.message));
  } finally { await store?.close(); await rm(directory, { recursive: true, force: true }); }
});

test('a configured checkpoint capacity rejects growth without trimming retained checkpoints', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omniops-sqlite-quota-'));
  const file = join(directory, 'checkpoints.sqlite');
  let store;
  try {
    for (const maxBytes of [0, -1, 65535, 65536.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      await assert.rejects(openSqliteCheckpointer(file, { maxBytes }), /capacity/);
    }
    store = await openSqliteCheckpointer(file, { maxBytes: 64 * 1024 });
    const config = { configurable: { thread_id: 'retained-run', checkpoint_ns: '' } };
    const retained = await store.checkpointer.put(config, emptyCheckpoint(), metadata, {});
    const large = emptyCheckpoint();
    large.channel_values.answer = 'x'.repeat(128 * 1024);
    await assert.rejects(store.checkpointer.put(config, large, metadata, {}), { code: 'SQLITE_FULL' });
    assert.ok(await store.checkpointer.getTuple(retained));
    assert.equal(await store.checkpointer.getTuple({ configurable: { ...config.configurable, checkpoint_id: large.id } }), undefined);
    assert.equal(store.checkpointer.db.pragma('max_page_count', { simple: true }), 16);
    assert.equal(store.checkpointer.db.pragma('journal_size_limit', { simple: true }), 64 * 1024);
    await store.close();
    store = await openSqliteCheckpointer(file, { maxBytes: 64 * 1024 });
    assert.ok(await store.checkpointer.getTuple(retained));
  } finally { await store?.close(); await rm(directory, { recursive: true, force: true }); }
});

test('binary checkpoint reads tolerate another branch adding pending writes during deserialization', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omniops-sqlite-bytes-race-'));
  let store;
  try {
    store = await openSqliteCheckpointer(join(directory, 'checkpoints.sqlite'));
    const saved = await store.checkpointer.put({ configurable: { thread_id: 'run', checkpoint_ns: '' } }, emptyCheckpoint(), metadata, {});
    await store.checkpointer.putWrites(saved, [['payload', new Uint8Array([255])]], 'z', 'z');
    const read = store.checkpointer.getTuple(saved);
    const write = store.checkpointer.putWrites(saved, [['payload', new Uint8Array([128])]], 'a', 'a');
    const [snapshot] = await Promise.all([read, write]);
    assert.deepEqual(snapshot.pendingWrites, [['z', 'payload', new Uint8Array([255])]]);
    assert.deepEqual((await store.checkpointer.getTuple(saved)).pendingWrites, [
      ['a', 'payload', new Uint8Array([128])], ['z', 'payload', new Uint8Array([255])],
    ]);
  } finally { await store?.close(); await rm(directory, { recursive: true, force: true }); }
});

test('initial schema and format creation roll back together after initialization failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omniops-sqlite-initialize-'));
  const file = join(directory, 'checkpoints.sqlite');
  const setup = SqliteSaver.prototype.setup;
  let store;
  try {
    SqliteSaver.prototype.setup = function () { setup.call(this); throw new Error('initialization fault'); };
    await assert.rejects(openSqliteCheckpointer(file), error => error.cause.message === 'initialization fault');
    SqliteSaver.prototype.setup = setup;
    const probe = SqliteSaver.fromConnString(file);
    try { assert.deepEqual(probe.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all(), []); }
    finally { probe.db.close(); }
    store = await openSqliteCheckpointer(file);
    assert.ok(store.checkpointer.db.prepare('SELECT format FROM omniops_checkpoint_format WHERE id=1').get());
  } finally {
    SqliteSaver.prototype.setup = setup;
    await store?.close(); await rm(directory, { recursive: true, force: true });
  }
});

test('execution reports a SQLite capacity failure and releases its run after checkpoint cleanup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omniops-sqlite-execution-'));
  let store;
  let execution;
  try {
    store = await openSqliteCheckpointer(join(directory, 'checkpoints.sqlite'), { maxBytes: 64 * 1024 });
    execution = await createExecution({ recordsDirectory: join(directory, 'runs'), checkpointer: store.checkpointer });
    const state = Annotation.Root({ payload: Annotation() });
    const outcome = await execution.execute({ threadId: 'thread', runId: 'run', timeoutMs: 10_000,
      prepare(scope) {
        const graph = new StateGraph(state).addNode('generate', () => ({ payload: 'x'.repeat(128 * 1024) }))
          .addEdge(START, 'generate').addEdge('generate', END).compile({ checkpointer: scope.checkpointer });
        return { graph, input: {} };
      },
    });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.error.kind, 'checkpoint');
    assert.equal(outcome.error.cause.code, 'SQLITE_FULL');
    assert.equal(execution.isBusy(), false);
  } finally {
    await execution?.close(); await store?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('SQLite reports full storage and bounded writer contention without pretending a commit succeeded', { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omniops-sqlite-capacity-'));
  let store;
  let contender;
  try {
    const file = join(directory, 'checkpoints.sqlite');
    store = await openSqliteCheckpointer(file);
    contender = await openSqliteCheckpointer(file);
    const config = { configurable: { thread_id: 'blocked', checkpoint_ns: '' } };
    store.checkpointer.db.exec('BEGIN IMMEDIATE');
    const started = performance.now();
    await assert.rejects(contender.checkpointer.put(config, emptyCheckpoint(), metadata, {}), { code: 'SQLITE_BUSY' });
    assert.ok(performance.now() - started >= 4500);
    assert.ok(performance.now() - started < 10_000);
    store.checkpointer.db.exec('ROLLBACK');
    assert.equal(await contender.checkpointer.getTuple(config), undefined);
    await contender.close();
    const pages = store.checkpointer.db.pragma('page_count', { simple: true });
    store.checkpointer.db.pragma(`max_page_count=${pages}`);
    const large = emptyCheckpoint();
    large.channel_values.answer = 'x'.repeat(128 * 1024);
    await assert.rejects(store.checkpointer.put(config, large, metadata, {}), { code: 'SQLITE_FULL' });
    assert.equal(await store.checkpointer.getTuple(config), undefined);
  } finally {
    if (store?.checkpointer.db.inTransaction) store.checkpointer.db.exec('ROLLBACK');
    await contender?.close(); await store?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a committed checkpoint survives process exit without close', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omniops-sqlite-crash-'));
  const file = join(directory, 'checkpoints.sqlite');
  let store;
  try {
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', `
      import { openSqliteCheckpointer } from './execution/sqlite.ts';
      import { emptyCheckpoint } from '@langchain/langgraph-checkpoint';
      const store = await openSqliteCheckpointer(process.argv[1]);
      await store.checkpointer.put({ configurable: { thread_id: 'crashed-run', checkpoint_ns: '' } }, emptyCheckpoint(), ${JSON.stringify(metadata)}, {});
      process.exit(23);
    `, file], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
    assert.equal(result.status, 23, result.stderr);
    store = await openSqliteCheckpointer(file);
    assert.ok(await store.checkpointer.getTuple({ configurable: { thread_id: 'crashed-run', checkpoint_ns: '' } }));
  } finally { await store?.close(); await rm(directory, { recursive: true, force: true }); }
});

test('SQLite incompatibility, corruption and write failure are explicit and preserve existing data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omniops-sqlite-errors-'));
  const file = join(directory, 'checkpoints.sqlite');
  let store;
  try {
    store = await openSqliteCheckpointer(file);
    store.checkpointer.db.prepare('UPDATE omniops_checkpoint_format SET format=? WHERE id=1').run('future-version');
    await store.close();
    const before = await readFile(file);
    await assert.rejects(openSqliteCheckpointer(file), error => /format/.test(error.cause.message));
    assert.deepEqual(await readFile(file), before);
    const corrupt = join(directory, 'corrupt.sqlite');
    await writeFile(corrupt, 'preserve damaged bytes');
    await assert.rejects(openSqliteCheckpointer(corrupt));
    assert.equal(await readFile(corrupt, 'utf8'), 'preserve damaged bytes');
    store = await openSqliteCheckpointer(join(directory, 'readonly.sqlite'));
    store.checkpointer.db.pragma('query_only=ON');
    await assert.rejects(store.checkpointer.put({ configurable: { thread_id: 'run', checkpoint_ns: '' } }, emptyCheckpoint(), metadata, {}), { code: 'SQLITE_READONLY' });
    if (process.platform !== 'win32') {
      const link = join(directory, 'link.sqlite');
      await symlink(file, link);
      await assert.rejects(openSqliteCheckpointer(link), /regular file/);
    }
  } finally { await store?.close(); await rm(directory, { recursive: true, force: true }); }
});
