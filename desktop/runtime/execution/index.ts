import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { BaseCheckpointSaver, CompiledGraphType, GraphRunStream, ProtocolEvent } from '@langchain/langgraph';
import { TrackedCheckpointer } from './checkpoint.ts';
import { createRunRecords, type RunRecord, type RunRecords } from './records.ts';

export type { RunRecord, RunRecords, RunStatus } from './records.ts';
export type NativeGraph<I, O> = Pick<CompiledGraphType<{ input: I; output: O }>,
  '~InputType' | '~OutputType' | 'outputChannels'> & {
  streamEvents(input: I, options: {
    version: 'v3'; signal: AbortSignal; recursionLimit: number;
    configurable: { thread_id: string }; outputKeys: string | string[];
  }): Promise<GraphRunStream<O>>;
};
export type RunIdentity = Readonly<{ threadId: string; runId: string; graphThreadId: string }>;
export type ExecutionErrorKind = 'invalid-request' | 'busy' | 'duplicate-run' | 'closed' |
  'cancelled' | 'timed-out' | 'graph' | 'checkpoint' | 'storage' | 'adapter' | 'scope' | 'missing-input' | 'login-required' | 'invalid-output';

const messages: Record<ExecutionErrorKind, string> = {
  'invalid-request': '执行参数无效。', busy: '已有任务正在执行。', 'duplicate-run': '执行编号已存在。',
  closed: '执行模块已关闭。', cancelled: '任务已停止。', 'timed-out': '任务执行超时。',
  graph: '本地执行失败，请检查配置或重试。', checkpoint: '执行状态保存失败，请检查本地存储。',
  storage: '执行记录保存失败，请检查本地存储。', adapter: '执行结果处理失败。', scope: '当前执行范围不允许此操作。',
  'missing-input': '任务缺少必要输入。', 'login-required': '任务需要人工登录。',
  'invalid-output': '任务输出不是有效的 JSON 数据。',
};
export class ExecutionError extends Error {
  readonly kind: ExecutionErrorKind;
  override readonly cause: unknown;
  readonly cleanupErrors: readonly unknown[];
  constructor(kind: ExecutionErrorKind, cause?: unknown, cleanupErrors: unknown[] = []) {
    super(messages[kind], { cause });
    this.name = 'ExecutionError';
    this.kind = kind;
    this.cause = cause;
    this.cleanupErrors = cleanupErrors;
  }
}
export type ExecutionOutcome<O> = { ok: true; run: RunIdentity; output: O } |
  { ok: false; run?: RunIdentity; error: ExecutionError };
export interface GraphScope {
  readonly signal: AbortSignal;
  readonly checkpointer: BaseCheckpointSaver;
  operation<T>(nodeSignal: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<T>): Promise<T>;
  /** Escaped browser callback errors terminate the run; recoverable failures must become results inside the callback. */
  browserFlow<T>(nodeSignal: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<T>): Promise<T>;
  /** Reuses a surrounding flow lease, or acquires one for this complete browser action. Same fatal-error contract as browserFlow. */
  browserOperation<T>(nodeSignal: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<T>): Promise<T>;
  fail(error: unknown): never;
  defer(close: () => Promise<void>): void;
  updateDetails(details: object): Promise<void>;
}
export interface PreparedGraph<I, O> { graph: NativeGraph<I, O>; input: NoInfer<I> }
export interface ExecuteRequest<I, O> {
  threadId: string;
  runId: string;
  timeoutMs: number;
  signal?: AbortSignal;
  details?: object;
  prepare(scope: GraphScope): PreparedGraph<I, O> | Promise<PreparedGraph<I, O>>;
  onEvent?(event: ProtocolEvent): void | Promise<void>;
  settle?(outcome: ExecutionOutcome<NoInfer<O>>): Promise<void>;
}
export interface Execution {
  readonly records: RunRecords;
  isBusy(threadId?: string): boolean;
  requestStop(runId: string): 'requested' | 'result-fixed';
  execute<I, O>(request: ExecuteRequest<I, O>): Promise<ExecutionOutcome<O>>;
  close(): Promise<void>;
}

function validId(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 256; }
function validDetails(value: unknown): value is object { return !!value && typeof value === 'object' && !Array.isArray(value); }

export async function createExecution(options: { recordsDirectory: string; checkpointer: BaseCheckpointSaver }): Promise<Execution> {
  if (!options || typeof options.recordsDirectory !== 'string' || !options.recordsDirectory || !options.checkpointer ||
      !['getTuple', 'list', 'put', 'putWrites', 'deleteThread', 'getNextVersion'].every(key =>
        typeof (options.checkpointer as unknown as Record<string, unknown>)[key] === 'function')) {
    throw new ExecutionError('invalid-request');
  }
  let records: Awaited<ReturnType<typeof createRunRecords>>;
  try { records = await createRunRecords(options.recordsDirectory); }
  catch (error) { throw new ExecutionError('storage', error); }
  let closed = false;
  const active = new Map<string, { stop: () => 'requested' | 'result-fixed'; done: Promise<unknown> }>();
  const busyThreads = new Set<string>();

  async function run<I, O>(request: ExecuteRequest<I, O>, controller: AbortController, fixResult: () => void): Promise<ExecutionOutcome<O>> {
    const leases = new AsyncLocalStorage<{ lease: { tail: Promise<unknown>; closed: boolean }; action?: true }>();
    const identity: RunIdentity = { threadId: request.threadId, runId: request.runId, graphThreadId: randomUUID() };
    const record: RunRecord = { ...identity, status: 'preparing', startedAt: new Date().toISOString() };
    const cleanupErrors: unknown[] = [];
    let firstError: ExecutionError | undefined;
    let accepting = true;
    let workOpen = true;
    let detailsOpen = true;
    let cleanupOpen = true;
    let output: O | undefined;
    const operations = new Set<Promise<unknown>>();
    const cleanups: Array<() => Promise<void>> = [];
    let browserTail: Promise<unknown> = Promise.resolve();
    let writes: Promise<void> = Promise.resolve();

    const fail = (kind: ExecutionErrorKind, error?: unknown) => {
      if (!firstError) firstError = error instanceof ExecutionError ?
        new ExecutionError(error.kind, error.cause ?? error, cleanupErrors) : new ExecutionError(kind, error, cleanupErrors);
      else if (error !== undefined && error !== firstError && error !== firstError.cause) cleanupErrors.push(error);
      accepting = false;
      if (!controller.signal.aborted) controller.abort(firstError);
    };
    const externalAbort = () => {
      const reason = request.signal?.reason;
      fail(reason instanceof ExecutionError && reason.kind === 'timed-out' ? 'timed-out' : 'cancelled',
        reason instanceof ExecutionError ? reason : new ExecutionError('cancelled', reason, cleanupErrors));
    };
    const hostAbort = () => {
      if (!firstError) fail('cancelled', controller.signal.reason);
    };
    controller.signal.addEventListener('abort', hostAbort, { once: true });
    request.signal?.addEventListener('abort', externalAbort, { once: true });
    if (request.signal?.aborted) externalAbort();
    const timeout = setTimeout(() => fail('timed-out'), request.timeoutMs);
    const checkpointer = new TrackedCheckpointer(options.checkpointer, error => fail('checkpoint', error));

    const persist = () => {
      const snapshot = structuredClone(record);
      const promise = writes.then(() => records.save(snapshot)).catch(error => {
        fail('storage', error);
        throw error;
      });
      // A failed update must not prevent final persistence from being attempted.
      writes = promise.catch(() => {});
      return promise;
    };
    const assertOpen = (signal: AbortSignal) => {
      if (!accepting) throw firstError ?? new ExecutionError('scope');
      signal.throwIfAborted();
    };
    const operation = <T>(nodeSignal: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<T>): Promise<T> => {
      const signal = nodeSignal ? AbortSignal.any([controller.signal, nodeSignal]) : controller.signal;
      try { assertOpen(signal); }
      catch (error) { return Promise.reject(error); }
      const promise = Promise.resolve().then(() => {
        assertOpen(signal);
        return work(signal);
      });
      operations.add(promise);
      void promise.then(() => operations.delete(promise), () => operations.delete(promise));
      return promise;
    };
    const scope: GraphScope = {
      signal: controller.signal,
      checkpointer,
      operation,
      browserFlow<T>(nodeSignal: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
        if (leases.getStore()) return Promise.reject(new ExecutionError('scope'));
        const restoreContext = AsyncLocalStorage.snapshot();
        return operation(nodeSignal, signal => {
          const previous = browserTail;
          const next = previous.catch(() => {}).then(() => restoreContext(() => {
            assertOpen(signal);
            const lease = { tail: Promise.resolve() as Promise<unknown>, closed: false };
            return leases.run({ lease }, async () => {
              try { return await work(signal); }
              catch (error) {
                // Native sibling cancellation is propagated without replacing its original graph error.
                if (!signal.aborted) fail('graph', error);
                throw firstError ?? error;
              }
              finally { lease.closed = true; await lease.tail; }
            });
          }));
          browserTail = next.catch(() => {});
          return next;
        });
      },
      browserOperation<T>(nodeSignal: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
        const current = leases.getStore();
        if (!current) return scope.browserFlow(nodeSignal, signal => scope.browserOperation(signal, work));
        if (current.lease.closed || current.action) return Promise.reject(new ExecutionError('scope'));
        const restoreContext = AsyncLocalStorage.snapshot();
        return operation(nodeSignal, signal => {
          const next = current.lease.tail.catch(() => {}).then(() => restoreContext(() => {
            assertOpen(signal);
            return leases.run({ lease: current.lease, action: true }, async () => {
              try { return await work(signal); }
              catch (error) {
                if (!signal.aborted) fail('graph', error);
                throw firstError ?? error;
              }
            });
          }));
          current.lease.tail = next.catch(() => {});
          return next;
        });
      },
      fail(error): never {
        if (!workOpen) throw new ExecutionError('scope');
        fail('graph', error);
        throw firstError!;
      },
      defer(close) {
        if (!cleanupOpen || typeof close !== 'function') throw new ExecutionError('scope');
        cleanups.push(close);
      },
      async updateDetails(details) {
        if (!detailsOpen) throw new ExecutionError('scope');
        if (!validDetails(details)) throw new ExecutionError('invalid-request');
        record.details = structuredClone(details);
        await persist();
      },
    };
    const outcome = (): ExecutionOutcome<O> => firstError ? { ok: false, run: identity, error: firstError } :
      { ok: true, run: identity, output: output as O };

    try {
      if (request.details !== undefined) record.details = structuredClone(request.details);
      await persist();
      assertOpen(controller.signal);
      const prepared = await request.prepare(scope);
      assertOpen(controller.signal);
      if (!prepared?.graph || typeof prepared.graph.streamEvents !== 'function' ||
          !(typeof prepared.graph.outputChannels === 'string' ||
            (Array.isArray(prepared.graph.outputChannels) && prepared.graph.outputChannels.every(key => typeof key === 'string')))) {
        throw new ExecutionError('invalid-request');
      }
      record.status = 'running';
      await persist();
      assertOpen(controller.signal);
      const stream = await prepared.graph.streamEvents(prepared.input, {
        version: 'v3', signal: controller.signal, recursionLimit: 60,
        configurable: { thread_id: identity.graphThreadId }, outputKeys: prepared.graph.outputChannels,
      });
      // Attach immediately: native output can reject while an adapter awaits its event handler.
      const completed = stream.output.then(value => { output = value; }, error => { fail('graph', error); });
      try {
        for await (const event of stream) {
          if (firstError) break;
          if (request.onEvent) {
            try { await request.onEvent(event); }
            catch (error) { fail('adapter', error); break; }
          }
        }
      } catch (error) { fail('graph', error); }
      await completed;
    } catch (error) { fail(error instanceof ExecutionError ? error.kind : 'graph', error); }
    finally {
      accepting = false;
      // Native cancellation can return before cooperative external operations finish.
      while (operations.size) await Promise.allSettled([...operations]);
      await checkpointer.drain();
      workOpen = false;
      while (cleanups.length) {
        try { await cleanups.pop()!(); }
        catch (error) { fail('adapter', error); }
      }
      cleanupOpen = false;
      await checkpointer.drain();
      await writes;
      // Domain settlement must commit the outcome it receives exactly once.
      // A late stop still waits for settlement, but cannot change that outcome.
      clearTimeout(timeout);
      request.signal?.removeEventListener('abort', externalAbort);
      controller.signal.removeEventListener('abort', hostAbort);
      fixResult();
      try { await request.settle?.(outcome()); }
      catch (error) { fail(error instanceof ExecutionError ? error.kind : 'adapter', error); }
      await writes;
      detailsOpen = false;
      record.status = firstError ? firstError.kind === 'cancelled' || firstError.kind === 'timed-out' ? firstError.kind : 'failed' : 'completed';
      record.endedAt = new Date().toISOString();
      if (firstError) record.error = { kind: firstError.kind, message: firstError.message };
      try { await persist(); }
      catch { /* The storage error is retained in the returned outcome. */ }
    }
    return outcome();
  }

  return {
    records: {
      has: records.has,
      list: records.list,
      get(runId) {
        try { return records.get(runId); }
        catch (error) { throw new ExecutionError('invalid-request', error); }
      },
    },
    isBusy: threadId => threadId === undefined ? active.size > 0 : busyThreads.has(threadId),
    requestStop(runId) {
      if (!validId(runId)) throw new ExecutionError('invalid-request');
      return active.get(runId)?.stop() ?? 'result-fixed';
    },
    execute<I, O>(request: ExecuteRequest<I, O>): Promise<ExecutionOutcome<O>> {
      let rejected: ExecutionErrorKind | undefined;
      if (closed) rejected = 'closed';
      else if (!request || !validId(request.runId) || !validId(request.threadId) ||
          !Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0 || request.timeoutMs > 2_147_483_647 ||
          typeof request.prepare !== 'function' || (request.signal !== undefined && !(request.signal instanceof AbortSignal)) ||
          (request.details !== undefined && !validDetails(request.details))) rejected = 'invalid-request';
      else if (active.has(request.runId) || records.has(request.runId)) rejected = 'duplicate-run';
      else if (busyThreads.has(request.threadId)) rejected = 'busy';
      if (rejected) return Promise.resolve({ ok: false, error: new ExecutionError(rejected) });
      const controller = new AbortController();
      // Reserve synchronously, before record initialization or async graph preparation.
      let resultFixed = false;
      const entry = { stop: (): 'requested' | 'result-fixed' => {
        if (resultFixed) return 'result-fixed';
        controller.abort(new ExecutionError('cancelled'));
        return 'requested';
      }, done: Promise.resolve() as Promise<unknown> };
      active.set(request.runId, entry);
      busyThreads.add(request.threadId);
      const done = run(request, controller, () => { resultFixed = true; }).finally(() => {
        active.delete(request.runId);
        busyThreads.delete(request.threadId);
      });
      entry.done = done;
      return done;
    },
    async close() {
      closed = true;
      const pending = [...active.values()];
      for (const entry of pending) entry.stop();
      await Promise.allSettled(pending.map(entry => entry.done));
    },
  };
}
