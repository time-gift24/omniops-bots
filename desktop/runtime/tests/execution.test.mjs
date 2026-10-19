import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Annotation, END, getConfig, Graph, MemorySaver, START, StateGraph } from '@langchain/langgraph';
import { FakeToolCallingModel } from 'langchain';
import { createBrowserAgent } from '../graphs/browser-agent.ts';
import { createExecution } from '../execution/index.ts';
import { storageId, writeJson } from '../json-store.mjs';

const deferred = () => Promise.withResolvers();
const Input = Annotation.Root({ question: Annotation() });
const Output = Annotation.Root({ answer: Annotation() });
const State = Annotation.Root({ question: Annotation(), answer: Annotation(), privateValue: Annotation() });
const request = (runId, prepare, extra = {}) => ({ runId, threadId: 'same-thread', timeoutMs: 5_000, prepare, ...extra });
function graph(scope, fn = state => ({ answer: state.question + ':ok', privateValue: 'secret' })) {
  return new StateGraph({ input: Input, output: Output, stateSchema: State })
    .addNode('respond', fn).addEdge(START, 'respond').addEdge('respond', END).compile({ checkpointer: scope.checkpointer });
}
async function fixture(t, saver = new MemorySaver()) {
  const directory = await mkdtemp(join(tmpdir(), 'desktop-execution-'));
  const execution = await createExecution({ recordsDirectory: directory, checkpointer: saver });
  t.after(async () => { await execution.close(); await rm(directory, { recursive: true, force: true }); });
  return { execution, directory, saver };
}

test('native graphs own input/state/output; records and checkpoint IDs are run-specific', async t => {
  const f = await fixture(t);
  assert.equal(f.execution.records.save, undefined, 'record mutations stay inside the execution lifecycle');
  assert.throws(() => f.execution.records.get('missing'), error => error.kind === 'invalid-request' && error.cause instanceof Error);
  const events = [];
  const first = await f.execution.execute(request('one', scope => ({ graph: graph(scope), input: { question: 'proof' } }), {
    details: { label: 'caller data' },
    onEvent: event => events.push(event),
  }));
  assert.equal(first.ok, true);
  assert.deepEqual(first.output, { answer: 'proof:ok' }, 'private state must not escape the graph output schema');
  const second = await f.execution.execute(request('two', scope => ({ graph: graph(scope), input: { question: 'again' } })));
  assert.equal(second.ok, true);
  assert.notEqual(first.run.graphThreadId, second.run.graphThreadId);
  assert.equal(f.execution.records.get('one').details.label, 'caller data');
  assert.equal(f.execution.records.get('one').status, 'completed');
  assert.ok((await f.saver.getTuple({ configurable: { thread_id: first.run.graphThreadId } })).checkpoint);
  assert.ok(events.length > 0);
  assert.equal((await f.execution.execute(request('one', () => { throw new Error('must not execute'); }))).error.kind, 'duplicate-run');
  assert.equal((await f.execution.execute(request('invalid-signal', () => {}, { signal: {} }))).error.kind, 'invalid-request');
});

test('native subgraph namespaces survive checkpoint tracking', async t => {
  const namespaces = [];
  class Saver extends MemorySaver {
    async put(config, ...args) { namespaces.push(config.configurable.checkpoint_ns); return super.put(config, ...args); }
  }
  const f = await fixture(t, new Saver());
  const result = await f.execution.execute(request('subgraph', scope => {
    const child = new StateGraph({ input: Input, output: Output, stateSchema: State })
      .addNode('respond', state => ({ answer: state.question + ':child' })).addEdge(START, 'respond').addEdge('respond', END).compile();
    const parent = new StateGraph({ input: Input, output: Output, stateSchema: State })
      .addNode('child', child).addEdge(START, 'child').addEdge('child', END).compile({ checkpointer: scope.checkpointer });
    return { graph: parent, input: { question: 'namespace' } };
  }));
  assert.equal(result.ok, true);
  assert.ok(namespaces.includes(''));
  assert.ok(namespaces.some(namespace => namespace.startsWith('child:')));
});

test('scalar native graph output is preserved without imposing a state object', async t => {
  const f = await fixture(t);
  const result = await f.execution.execute(request('scalar', scope => ({
    graph: new Graph().addNode('length', value => value.length).addEdge(START, 'length').addEdge('length', END)
      .compile({ checkpointer: scope.checkpointer }), input: 'four',
  })));
  assert.equal(result.ok, true);
  assert.equal(result.output, 4);
  const invalid = await f.execution.execute(request('missing-output-schema', () => ({
    graph: { streamEvents() { throw new Error('must not invoke'); } }, input: {},
  })));
  assert.equal(invalid.error.kind, 'invalid-request');
});

test('admission is synchronous and cancellation during async prepare waits for acquired resource cleanup', async t => {
  const f = await fixture(t), ready = deferred(), acquired = deferred();
  const controller = new AbortController();
  const actions = [];
  const pending = f.execution.execute(request('prepare', async scope => {
    ready.resolve();
    await acquired.promise;
    scope.defer(async () => { actions.push('closed'); });
    return { graph: graph(scope, () => { actions.push('graph'); return { answer: 'bad' }; }), input: { question: 'x' } };
  }, { signal: controller.signal }));
  assert.equal(f.execution.isBusy(), true);
  assert.equal((await f.execution.execute(request('racing', () => {}))).error.kind, 'busy');
  await ready.promise;
  controller.abort(new Error('user stop'));
  let terminal = false;
  void pending.then(() => { terminal = true; });
  await delay(10);
  assert.equal(terminal, false);
  acquired.resolve();
  const result = await pending;
  assert.equal(result.error.kind, 'cancelled');
  assert.deepEqual(actions, ['closed']);
  assert.equal(f.execution.isBusy(), false);
  assert.equal(f.execution.records.get('prepare').status, 'cancelled');
});

test('distinct threads execute browser actions concurrently while thread and run reservations stay exclusive', async t => {
  const f = await fixture(t);
  const started = [deferred(), deferred()], release = [deferred(), deferred()];
  const prepare = index => scope => ({ graph: graph(scope, async (_state, config) => scope.browserOperation(config.signal, async () => {
    started[index].resolve();
    await release[index].promise;
    return { answer: `thread:${index}` };
  })), input: { question: 'x' } });
  const first = f.execution.execute(request('concurrent-one', prepare(0), { threadId: 'thread-one' }));
  assert.equal(f.execution.records.has('concurrent-one'), false, 'admission must reserve the run before its first disk write');
  assert.equal(f.execution.isBusy('thread-one'), true);
  assert.equal((await f.execution.execute(request('concurrent-one', () => assert.fail('duplicate run prepared'), { threadId: 'other-thread' }))).error.kind, 'duplicate-run');
  assert.equal((await f.execution.execute(request('same-thread', () => assert.fail('busy thread prepared'), { threadId: 'thread-one' }))).error.kind, 'busy');
  const second = f.execution.execute(request('concurrent-two', prepare(1), { threadId: 'thread-two' }));
  try {
    await Promise.race([
      Promise.all(started.map(item => item.promise)),
      second.then(() => assert.fail('the second thread must start before either browser action finishes')),
    ]);
    assert.equal(f.execution.isBusy(), true);
    assert.equal(f.execution.isBusy('thread-two'), true);
    assert.equal(f.execution.isBusy('unrelated-thread'), false);
    release[0].resolve();
    const outcome = await first;
    assert.equal(outcome.ok, true);
    assert.deepEqual(outcome.output, { answer: 'thread:0' });
    assert.equal(f.execution.isBusy('thread-one'), false);
    assert.equal(f.execution.isBusy('thread-two'), true);
  } finally { release.forEach(item => item.resolve()); }
  const outcome = await second;
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.output, { answer: 'thread:1' });
  assert.equal(f.execution.isBusy(), false);
  assert.notEqual(f.execution.records.get('concurrent-one').graphThreadId, outcome.run.graphThreadId);
  assert.equal(f.execution.records.get('concurrent-one').status, 'completed');
  assert.equal(f.execution.records.get('concurrent-two').status, 'completed');
});

test('a run started inside another run browser flow receives its own lease', async t => {
  const f = await fixture(t), actions = [];
  const result = await f.execution.execute(request('outer-run', async scope => {
    await scope.browserFlow(undefined, async () => {
      actions.push('outer:start');
      const inner = await f.execution.execute(request('inner-run', async innerScope => {
        await innerScope.browserFlow(undefined, signal => innerScope.browserOperation(signal, async () => { actions.push('inner'); }));
        return { graph: graph(innerScope), input: { question: 'inner' } };
      }, { threadId: 'inner-thread' }));
      assert.equal(inner.ok, true, inner.error?.cause?.stack);
      assert.deepEqual(inner.output, { answer: 'inner:ok' });
      actions.push('outer:end');
    });
    return { graph: graph(scope), input: { question: 'outer' } };
  }));
  assert.equal(result.ok, true, result.error?.cause?.stack);
  assert.deepEqual(actions, ['outer:start', 'inner', 'outer:end']);
});

test('cancellation and settlement retain only their own thread reservation', async t => {
  const f = await fixture(t), started = deferred(), aborted = deferred(), drain = deferred(), settling = deferred(), commit = deferred();
  const otherStarted = deferred(), otherRelease = deferred();
  const controller = new AbortController(), actions = [];
  const pending = f.execution.execute(request('cancel-isolated', scope => ({ graph: graph(scope, async (_state, config) => scope.browserOperation(config.signal, async signal => {
    started.resolve();
    if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    aborted.resolve();
    await drain.promise;
    actions.push('cancelled operation drained');
    signal.throwIfAborted();
    return { answer: 'bad' };
  })), input: { question: 'x' } }), { threadId: 'cancelled-thread', signal: controller.signal, settle: async outcome => {
    actions.push('cancelled settlement started');
    assert.equal(outcome.error.kind, 'cancelled');
    settling.resolve();
    await commit.promise;
    actions.push('cancelled settlement committed');
  } }));
  const otherPending = f.execution.execute(request('unaffected', scope => ({ graph: graph(scope, async (_state, config) => scope.browserOperation(config.signal, async signal => {
    otherStarted.resolve();
    await otherRelease.promise;
    signal.throwIfAborted();
    return { answer: 'unaffected' };
  })), input: { question: 'other' } }), { threadId: 'other-thread' }));
  try {
    await Promise.all([started.promise, otherStarted.promise]);
    controller.abort();
    await aborted.promise;
    otherRelease.resolve();
    const other = await otherPending;
    assert.equal(other.ok, true, 'other threads can complete while cancellation drains');
    assert.equal(f.execution.isBusy('cancelled-thread'), true);
    assert.equal(f.execution.isBusy('other-thread'), false);
    drain.resolve();
    await settling.promise;
    assert.equal((await f.execution.execute(request('too-soon', () => assert.fail('settling thread prepared'), { threadId: 'cancelled-thread' }))).error.kind, 'busy');
    assert.equal(f.execution.records.get('cancel-isolated').status, 'running');
  } finally { drain.resolve(); commit.resolve(); otherRelease.resolve(); }
  assert.equal((await pending).error.kind, 'cancelled');
  assert.deepEqual(actions, ['cancelled operation drained', 'cancelled settlement started', 'cancelled settlement committed']);
  const replacement = await f.execution.execute(request('after-commit', scope => ({ graph: graph(scope), input: { question: 'next' } }), { threadId: 'cancelled-thread' }));
  assert.equal(replacement.ok, true);
  assert.equal(f.execution.records.get('cancel-isolated').status, 'cancelled');
  assert.equal(f.execution.records.get('unaffected').status, 'completed');
});

test('close cancels every running thread and waits for every drain and frozen settlement', async t => {
  const f = await fixture(t);
  const started = [deferred(), deferred()], aborted = [deferred(), deferred()], drain = [deferred(), deferred()];
  const settling = deferred(), commit = deferred();
  const pending = [0, 1].map(index => f.execution.execute(request(`close-${index}`, scope => ({ graph: graph(scope, async (_state, config) => scope.operation(config.signal, async signal => {
    started[index].resolve();
    if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    aborted[index].resolve();
    await drain[index].promise;
    signal.throwIfAborted();
    return { answer: 'bad' };
  })), input: { question: 'x' } }), { threadId: `close-thread-${index}` })));
  const settled = f.execution.execute(request('close-settling', scope => ({ graph: graph(scope), input: { question: 'committing' } }), {
    threadId: 'settling-thread', settle: async outcome => {
      assert.equal(outcome.ok, true);
      settling.resolve();
      await commit.promise;
    },
  }));
  let closed = false;
  try {
    await Promise.all([...started.map(item => item.promise), settling.promise]);
    const closing = f.execution.close().then(() => { closed = true; });
    await Promise.all(aborted.map(item => item.promise));
    assert.equal((await f.execution.execute(request('after-closing', () => assert.fail('closed engine prepared')))).error.kind, 'closed');
    drain[0].resolve();
    assert.equal((await pending[0]).error.kind, 'cancelled');
    assert.equal(f.execution.isBusy('close-thread-0'), false);
    assert.equal(f.execution.isBusy('close-thread-1'), true);
    assert.equal(closed, false);
    drain[1].resolve();
    assert.equal((await pending[1]).error.kind, 'cancelled');
    assert.equal(f.execution.isBusy('settling-thread'), true);
    assert.equal(closed, false);
    commit.resolve();
    assert.equal((await settled).ok, true, 'close cannot change an outcome already being committed');
    await closing;
  } finally { drain.forEach(item => item.resolve()); commit.resolve(); }
  assert.equal(closed, true);
  assert.equal(f.execution.isBusy(), false);
  assert.equal(f.execution.records.get('close-0').status, 'cancelled');
  assert.equal(f.execution.records.get('close-1').status, 'cancelled');
  assert.equal(f.execution.records.get('close-settling').status, 'completed');
});

test('unhandled parallel node failure cancels siblings and drains launched operations before settlement', async t => {
  const f = await fixture(t), started = deferred(), observedAbort = deferred(), release = deferred();
  const original = new Error('first node error');
  const actions = [];
  const pending = f.execution.execute(request('parallel', scope => {
    const state = Annotation.Root({ answer: Annotation() });
    const native = new StateGraph(state)
      .addNode('fail', async () => { await started.promise; throw original; })
      .addNode('external', async (_state, config) => scope.browserFlow(config.signal, flowSignal => scope.browserOperation(flowSignal, async signal => {
        started.resolve();
        if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
        observedAbort.resolve();
        await release.promise;
        actions.push('drained');
        signal.throwIfAborted();
        return { answer: 'bad' };
      })))
      .addEdge(START, 'fail').addEdge(START, 'external').addEdge('fail', END).addEdge('external', END)
      .compile({ checkpointer: scope.checkpointer });
    return { graph: native, input: {} };
  }, { settle: async result => { actions.push('settled'); assert.equal(result.ok, false); } }));
  await observedAbort.promise;
  assert.equal(f.execution.isBusy(), true);
  assert.equal(f.execution.records.get('parallel').status, 'running');
  release.resolve();
  const result = await pending;
  assert.equal(result.error.kind, 'graph');
  assert.equal(result.error.cause, original);
  assert.deepEqual(actions, ['drained', 'settled']);
  assert.equal(f.execution.records.get('parallel').status, 'failed');
});

test('browser workflows serialize complete branches, preserve native async context and reject nested acquisition', async t => {
  const f = await fixture(t), actions = [];
  const result = await f.execution.execute(request('flows', scope => ({ graph: graph(scope, async (_state, config) => {
    await Promise.all(['a', 'b'].map(name => scope.browserFlow(config.signal, async signal => {
      assert.equal(getConfig().metadata.langgraph_node, 'respond');
      actions.push(name + '1');
      await delay(5);
      await scope.operation(signal, async () => { actions.push(name + '2'); });
      await assert.rejects(scope.browserFlow(signal, async () => {}), error => error.kind === 'scope');
      actions.push(name + '3');
    })));
    return { answer: 'done' };
  }), input: { question: 'x' } })));
  assert.equal(result.ok, true);
  assert.deepEqual(actions, ['a1', 'a2', 'a3', 'b1', 'b2', 'b3']);
});

test('browser operations inherit a workflow lease and serialize within and between branches', async t => {
  const f = await fixture(t), actions = [];
  const result = await f.execution.execute(request('leased-actions', scope => ({ graph: graph(scope, async (_state, config) => {
    await Promise.all(['a', 'b'].map(name => scope.browserFlow(config.signal, async flowSignal => {
      actions.push(name + ':model');
      await delay(5);
      await Promise.all([1, 2].map(index => scope.browserOperation(flowSignal, async signal => {
        assert.equal(getConfig().metadata.langgraph_node, 'respond');
        actions.push(`${name}:${index}:start`);
        await delay(5);
        await assert.rejects(scope.browserOperation(signal, async () => {}), error => error.kind === 'scope');
        actions.push(`${name}:${index}:end`);
      })));
      actions.push(name + ':done');
    })));
    // Single actions without a surrounding workflow still acquire the same lease.
    await Promise.all(['c', 'd'].map(name => scope.browserOperation(config.signal, async () => {
      actions.push(name + ':start'); await delay(5); actions.push(name + ':end');
    })));
    return { answer: 'serialized' };
  }), input: { question: 'x' } })));
  assert.equal(result.ok, true);
  assert.deepEqual(actions, [
    'a:model', 'a:1:start', 'a:1:end', 'a:2:start', 'a:2:end', 'a:done',
    'b:model', 'b:1:start', 'b:1:end', 'b:2:start', 'b:2:end', 'b:done',
    'c:start', 'c:end', 'd:start', 'd:end',
  ]);
});

test('workflow lease stays held until its launched browser operations drain', async t => {
  const f = await fixture(t), actions = [];
  const result = await f.execution.execute(request('unawaited-action', scope => ({ graph: graph(scope, async (_state, config) => {
    await Promise.all([
      scope.browserFlow(config.signal, async signal => {
        void scope.browserOperation(signal, async () => { actions.push('first:start'); await delay(10); actions.push('first:end'); });
      }),
      scope.browserFlow(config.signal, async () => { actions.push('second'); }),
    ]);
    return { answer: 'drained' };
  }), input: { question: 'x' } })));
  assert.equal(result.ok, true);
  assert.deepEqual(actions, ['first:start', 'first:end', 'second']);
});

test('cancelled browser operations queued within a workflow never start', async t => {
  const f = await fixture(t), started = deferred(), release = deferred();
  const controller = new AbortController(), actions = [];
  const pending = f.execution.execute(request('queued-actions', scope => ({ graph: graph(scope, async (_state, config) => {
    await scope.browserFlow(config.signal, async signal => {
      await Promise.all([
        scope.browserOperation(signal, async actionSignal => {
          actions.push('first'); started.resolve();
          await release.promise; actions.push('drained'); actionSignal.throwIfAborted();
        }),
        scope.browserOperation(signal, async () => { actions.push('must not start'); }),
      ]);
    });
    return { answer: 'bad' };
  }), input: { question: 'x' } }), { signal: controller.signal }));
  await started.promise;
  controller.abort();
  assert.equal(f.execution.isBusy(), true);
  release.resolve();
  assert.equal((await pending).error.kind, 'cancelled');
  assert.deepEqual(actions, ['first', 'drained']);
});

test('explicit fatal failure closes queued browser admission immediately and cancels other operations', async t => {
  const f = await fixture(t), started = deferred(), aborted = deferred(), release = deferred();
  const actions = [], fatal = new Error('unrecoverable browser failure');
  let scope;
  const pending = f.execution.execute(request('explicit-fatal', value => {
    scope = value;
    return { graph: graph(scope, async (_state, config) => {
      await Promise.all([
        scope.operation(config.signal, async signal => {
          started.resolve();
          if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
          aborted.resolve();
          await release.promise;
          actions.push('other operation drained');
          signal.throwIfAborted();
        }),
        scope.browserOperation(config.signal, async () => {
          await started.promise;
          actions.push('fatal');
          scope.fail(fatal);
        }),
        scope.browserOperation(config.signal, async () => { actions.push('must not start'); }),
      ]);
      return { answer: 'bad' };
    }), input: { question: 'x' } };
  }));
  await aborted.promise;
  assert.equal(f.execution.isBusy(), true);
  assert.equal(f.execution.records.get('explicit-fatal').status, 'running');
  release.resolve();
  const outcome = await pending;
  assert.equal(outcome.error.kind, 'graph');
  assert.equal(outcome.error.cause, fatal);
  assert.deepEqual(actions, ['fatal', 'other operation drained']);
  assert.throws(() => scope.fail(new Error('too late')), error => error.kind === 'scope');
  assert.equal(f.execution.records.get('explicit-fatal').error.kind, 'graph');
});

test('exceptions escaping browser callback boundaries terminate the run before queued actions start', async t => {
  const f = await fixture(t);
  for (const method of ['browserOperation', 'browserFlow']) {
    const actions = [], failure = new Error('browser callback failed');
    const result = await f.execution.execute(request('escaped-' + method, scope => ({ graph: graph(scope, async (_state, config) => {
      await Promise.all([
        scope[method](config.signal, async () => { actions.push('failed'); throw failure; }),
        scope[method](config.signal, async () => { actions.push('must not start'); }),
      ]);
      return { answer: 'bad' };
    }), input: { question: 'x' } })));
    assert.equal(result.error.kind, 'graph');
    assert.equal(result.error.cause, failure);
    assert.deepEqual(actions, ['failed']);
  }
});

test('browser callback can convert a business failure to a result and permit queued actions', async t => {
  const f = await fixture(t);
  for (const method of ['browserOperation', 'browserFlow']) {
    const actions = [];
    const result = await f.execution.execute(request('handled-' + method, scope => ({ graph: graph(scope, async (_state, config) => {
      const results = await Promise.all([
        scope[method](config.signal, async () => {
          try { throw new Error('recoverable browser business result'); }
          catch { actions.push('handled'); return { ok: false }; }
        }),
        scope[method](config.signal, async () => { actions.push('continued'); return { ok: true }; }),
      ]);
      assert.deepEqual(results, [{ ok: false }, { ok: true }]);
      return { answer: 'handled' };
    }), input: { question: 'x' } })));
    assert.equal(result.ok, true);
    assert.deepEqual(actions, ['handled', 'continued']);
  }
});

test('a synchronous workflow exception blocks its queued inner actions even if the graph catches it', async t => {
  const f = await fixture(t), actions = [], failure = new Error('workflow failed before its queued actions started');
  const result = await f.execution.execute(request('flow-synchronous-failure', scope => ({ graph: graph(scope, async (_state, config) => {
    try {
      await scope.browserFlow(config.signal, () => {
        void scope.browserOperation(config.signal, async () => { actions.push('must not start one'); }).catch(() => {});
        void scope.browserOperation(config.signal, async () => { actions.push('must not start two'); }).catch(() => {});
        throw failure;
      });
    } catch { actions.push('graph caught after browser boundary'); }
    return { answer: 'cannot recover an escaped browser failure' };
  }), input: { question: 'x' } })));
  assert.equal(result.error.kind, 'graph');
  assert.equal(result.error.cause, failure);
  assert.deepEqual(actions, ['graph caught after browser boundary']);
});

test('cancelled queued browser workflow never starts; active work drains before terminal', async t => {
  const f = await fixture(t), started = deferred(), aborted = deferred(), release = deferred();
  const controller = new AbortController(), actions = [];
  const pending = f.execution.execute(request('queued', scope => ({ graph: graph(scope, async (_state, config) => {
    await Promise.all([
      scope.browserFlow(config.signal, async signal => {
        actions.push('first'); started.resolve();
        if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
        aborted.resolve(); await release.promise; actions.push('drained'); signal.throwIfAborted();
      }),
      scope.browserFlow(config.signal, async () => { actions.push('must not start'); }),
    ]);
    return { answer: 'bad' };
  }), input: { question: 'x' } }), { signal: controller.signal }));
  await started.promise;
  controller.abort();
  await aborted.promise;
  assert.equal(f.execution.isBusy(), true);
  release.resolve();
  assert.equal((await pending).error.kind, 'cancelled');
  assert.deepEqual(actions, ['first', 'drained']);
});

test('checkpoint failure drains other pending writes and keeps the first failure over later timeout/cleanup errors', async t => {
  const pendingWrite = deferred(), writeStarted = deferred();
  const checkpointError = new Error('checkpoint failed'), cleanupError = new Error('cleanup failed');
  class Saver extends MemorySaver {
    async putWrites(config, writes, taskId, taskPath) {
      writeStarted.resolve();
      await pendingWrite.promise;
      return super.putWrites(config, writes, taskId, taskPath);
    }
    async put(config, checkpoint, metadata, versions) {
      if (metadata.step >= 0) { await writeStarted.promise; throw checkpointError; }
      return super.put(config, checkpoint, metadata, versions);
    }
  }
  const f = await fixture(t, new Saver());
  const pending = f.execution.execute(request('checkpoints', scope => {
    scope.defer(async () => { throw cleanupError; });
    return { graph: graph(scope), input: { question: 'x' } };
  }, { timeoutMs: 60 }));
  await writeStarted.promise;
  await delay(90);
  assert.equal(f.execution.isBusy(), true);
  assert.equal(f.execution.records.get('checkpoints').status, 'running');
  pendingWrite.resolve();
  const result = await pending;
  assert.equal(result.error.kind, 'checkpoint');
  assert.equal(result.error.cause, checkpointError);
  assert.ok(result.error.cleanupErrors.includes(cleanupError));
});

test('checkpoint draining includes native put calls chained behind an earlier pending put', async t => {
  const initialPut = deferred(), futurePut = deferred(), writeFailed = deferred(), futureStarted = deferred();
  const actions = [];
  class Saver extends MemorySaver {
    async put(config, checkpoint, metadata, versions) {
      if (metadata.step === -1) await initialPut.promise;
      else { futureStarted.resolve(); await futurePut.promise; }
      actions.push('put:' + metadata.step);
      return super.put(config, checkpoint, metadata, versions);
    }
    async putWrites() { writeFailed.resolve(); throw new Error('write failed while an earlier put is pending'); }
  }
  const f = await fixture(t, new Saver());
  const pending = f.execution.execute(request('checkpoint-chain', scope => ({ graph: graph(scope), input: { question: 'x' } }), {
    settle: async () => { actions.push('settled'); },
  }));
  await writeFailed.promise;
  initialPut.resolve();
  await futureStarted.promise;
  assert.equal(f.execution.isBusy(), true);
  assert.equal(actions.includes('settled'), false);
  futurePut.resolve();
  assert.equal((await pending).error.kind, 'checkpoint');
  assert.equal(actions.at(-1), 'settled');
});

test('settle persists caller details before final record and does not admit new operations', async t => {
  const f = await fixture(t);
  let retainedScope, settles = 0;
  const result = await f.execution.execute(request('settle', scope => {
    retainedScope = scope;
    return { graph: graph(scope), input: { question: 'x' } };
  }, { settle: async outcome => {
    settles++;
    assert.equal(outcome.ok, true);
    await assert.rejects(retainedScope.operation(undefined, async () => {}), error => error.kind === 'scope');
    await retainedScope.updateDetails({ result: outcome.output, events: ['finished'] });
  } }));
  assert.equal(result.ok, true);
  assert.equal(settles, 1);
  const disk = JSON.parse(await readFile(join(f.directory, '.records', storageId('settle') + '.json'), 'utf8'));
  assert.equal(disk.status, 'completed');
  assert.deepEqual(disk.details, { result: { answer: 'x:ok' }, events: ['finished'] });
  await assert.rejects(retainedScope.updateDetails({ too: 'late' }), error => error.kind === 'scope');
});

test('caught operation failures remain graph results and settle failure is an adapter error', async t => {
  const f = await fixture(t);
  const recoverable = await f.execution.execute(request('recover', scope => ({
    graph: graph(scope, async () => {
      try { await scope.operation(undefined, async () => { throw new Error('recoverable business result'); }); }
      catch { return { answer: 'handled' }; }
    }), input: { question: 'x' },
  })));
  assert.equal(recoverable.ok, true);
  assert.deepEqual(recoverable.output, { answer: 'handled' });
  const failure = new Error('history could not be saved');
  const failed = await f.execution.execute(request('settle-failure', scope => ({ graph: graph(scope), input: { question: 'x' } }), {
    settle: async () => { throw failure; },
  }));
  assert.equal(failed.error.kind, 'adapter');
  assert.equal(failed.error.cause, failure);
  assert.equal(f.execution.records.get('settle-failure').status, 'failed');
});

test('domain settlement freezes its outcome while late stop, timeout and close wait for its commit', async t => {
  const f = await fixture(t), settling = deferred(), release = deferred();
  const controller = new AbortController();
  let scope, settles = 0;
  const pending = f.execution.execute(request('settlement-commit', value => {
    scope = value;
    return { graph: graph(value), input: { question: 'x' } };
  }, { timeoutMs: 80, signal: controller.signal, settle: async outcome => {
    settles++;
    assert.equal(outcome.ok, true);
    assert.throws(() => scope.fail(new Error('settlement is closed to graph failure')), error => error.kind === 'scope');
    settling.resolve();
    await release.promise;
    await scope.updateDetails({ result: outcome.output, status: 'completed' });
  } }));
  await settling.promise;
  controller.abort();
  const closing = f.execution.close();
  let finished = false;
  void pending.then(() => { finished = true; });
  await delay(100);
  assert.equal(finished, false);
  assert.equal(f.execution.isBusy(), true);
  release.resolve();
  const outcome = await pending;
  await closing;
  assert.equal(outcome.ok, true);
  assert.equal(settles, 1);
  assert.equal(f.execution.records.get('settlement-commit').status, 'completed');
  assert.deepEqual(f.execution.records.get('settlement-commit').details.result, { answer: 'x:ok' });
});

test('timeout and host close cancel active runs and reject future admission', async t => {
  const f = await fixture(t), started = deferred();
  const prepare = scope => ({ graph: graph(scope, async (_state, config) => scope.operation(config.signal, async signal => {
    started.resolve();
    await delay(10_000, undefined, { signal });
    return { answer: 'bad' };
  })), input: { question: 'x' } });
  const timedOut = await f.execution.execute(request('timeout', prepare, { timeoutMs: 50 }));
  assert.equal(timedOut.error.kind, 'timed-out');
  assert.equal(f.execution.records.get('timeout').status, 'timed-out');
  const pending = f.execution.execute(request('closed', prepare));
  const closing = f.execution.close();
  const result = await pending;
  await closing;
  assert.equal(result.error.kind, 'cancelled');
  assert.equal(f.execution.isBusy(), false);
  assert.equal((await f.execution.execute(request('after-close', prepare))).error.kind, 'closed');
  await assert.rejects(createExecution({ recordsDirectory: f.directory }), error => error.kind === 'invalid-request');
});

test('cancellation waits for a model promise that ignores the abort signal', async t => {
  const f = await fixture(t);
  for (const binding of [false, true]) {
    const generating = deferred(), release = deferred();
    const controller = new AbortController(), actions = [];
    class SlowModel extends FakeToolCallingModel {
      bindTools(tools) { this.tools = tools; return binding ? this.withConfig({}) : this; }
      async _generate(...args) {
        generating.resolve();
        await release.promise;
        actions.push('model finished');
        return super._generate(...args);
      }
    }
    const pending = f.execution.execute(request('model-drain-' + binding, scope => ({
      graph: createBrowserAgent({ model: new SlowModel(), scope, workspace: {}, browser: {},
        snapshot: { directory: f.directory, skills: [], agent: { configuration: { instructions: '', toolIds: [] } } } }),
      input: { messages: [{ role: 'user', content: 'Wait for the local model operation.' }] },
    }), { signal: controller.signal, settle: async () => { actions.push('settled'); } }));
    await Promise.race([generating.promise, pending.then(result => { throw result.error ?? new Error('model never started'); })]);
    controller.abort();
    const completedEarly = await Promise.race([pending.then(() => true), delay(40).then(() => false)]);
    release.resolve();
    const result = await pending;
    assert.equal(completedEarly, false, 'the local model invocation must finish before settlement');
    assert.equal(result.error.kind, 'cancelled');
    assert.deepEqual(actions, ['model finished', 'settled']);
  }
});

test('legacy payload is retained and unfinished records become interrupted without replay', async t => {
  const f = await fixture(t);
  await f.execution.close();
  const old = { runId: 'legacy', threadId: 'thread', status: 'running', startedAt: new Date().toISOString(),
    title: 'Old chat', inputMessages: [{ role: 'user', text: 'retain' }], events: [{ type: 'started' }], result: { text: 'partial' } };
  await writeJson(join(f.directory, '.records', storageId('legacy') + '.json'), old);
  const reopened = await createExecution({ recordsDirectory: f.directory, checkpointer: new MemorySaver() });
  t.after(() => reopened.close());
  const record = reopened.records.get('legacy');
  assert.equal(record.status, 'interrupted');
  assert.equal(record.error.kind, 'interrupted');
  assert.equal(record.details.title, old.title);
  assert.deepEqual(record.details.inputMessages, old.inputMessages);
  assert.deepEqual(record.details.events, old.events);
  assert.deepEqual(record.details.result, old.result);
  assert.equal((await reopened.execute(request('legacy', () => {}))).error.kind, 'duplicate-run');
});
