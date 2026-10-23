import { randomUUID, createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { canonicalize } from 'json-canonicalize';
import {
  AgentCard, Task, Message, SendMessageRequest, GetTaskRequest, ListTasksRequest,
  CancelTaskRequest, SubscribeToTaskRequest, GetExtendedAgentCardRequest,
  TaskPushNotificationConfig, GetTaskPushNotificationConfigRequest,
  ListTaskPushNotificationConfigsRequest, DeleteTaskPushNotificationConfigRequest,
  Role, TaskState, Extensions,
} from '@a2a-js/sdk';
import type { StreamResponse, ListTasksResponse, ListTaskPushNotificationConfigsResponse, Artifact } from '@a2a-js/sdk';
import {
  DefaultRequestHandler, DefaultExecutionEventBusManager, DefaultExecutionEventBus,
  ResultManager, RequestContext, AgentEvent, ServerCallContext, validateVersion,
} from '@a2a-js/sdk/server';
import type { A2ARequestHandler, AgentExecutor, ExecutionEventBus, ExecutionEventBusManager, AgentExecutionEvent } from '@a2a-js/sdk/server';
import {
  A2AError, RequestMalformedError, TaskNotFoundError, TaskNotCancelableError,
  UnsupportedOperationError, ContentTypeNotSupportedError, PushNotificationNotSupportedError,
  ExtensionSupportRequiredError, VersionNotSupportedError,
} from '@a2a-js/sdk/errors';
import { RuntimeError } from '../errors.ts';
import { identifier } from '../input.ts';
import type { JsonValue, JsonObject, RemoteRunAdmission, RunReservation } from '../runtime.ts';
import { ExecutionError, type ExecutionOutcome } from '../execution/index.ts';
import { openA2AStore, principalOwner, isTerminalTask, taskResultSha256, RECEIPT_EXTENSION } from './store.ts';
import { statusMessage as message } from './status.ts';

export type A2APrincipal = Readonly<{ organizationId: string; callerId: string; installationId: string }>;
export type OfficialEndpoint = Readonly<{ agentId: string; contentId: string; card: AgentCard }>;
export type ResolveEndpoint = (context: ServerCallContext, tenant: string, options: Readonly<{ signal: AbortSignal }>) => Promise<OfficialEndpoint>;
export type A2ALimits = Readonly<{ maxRequestBytes: number; maxTaskBytes: number; maxJsonDepth: number; maxWaiters: number; maxSubscriptions: number }>;
export type A2AServiceOptions = Readonly<{ directory: string; runtime: RemoteRunAdmission; resolveEndpoint: ResolveEndpoint; limits: A2ALimits }>;
export type CallOptions = Readonly<{ signal?: AbortSignal }>;
export type CloseOptions = Readonly<{ deadline: number }>;
export type DeliveryReceipt = Readonly<{ tenant: string; taskId: string; resultSha256: string; receivedAt: string }>;
export type DeliveryConfirmation = Readonly<{ taskId: string; resultSha256: string }>;
export interface A2AService {
  protocolFor(context: ServerCallContext, tenant: string, options?: CallOptions): Promise<A2ARequestHandler>;
  confirmTaskDelivery(request: DeliveryReceipt, context: ServerCallContext, options?: CallOptions): Promise<DeliveryConfirmation>;
  close(options: CloseOptions): Promise<void>;
}

type Category = 'authentication' | 'forbidden' | 'storage' | 'resource-limit' | 'unavailable' | 'aborted' | 'unknown';
const controlledCategories = new Set<string>(['authentication', 'forbidden', 'storage', 'resource-limit', 'unavailable', 'aborted', 'unknown']);
const errorSources = new WeakMap<A2AError, unknown>();
const closingReason = Symbol('A2AService closing');
function failure(category: Category, cause?: unknown): A2AError {
  const error = new A2AError({ message: category === 'storage' ? 'A2A storage is unavailable.' : 'A2A request cannot be completed.', metadata: { category } });
  if (cause !== undefined) errorSources.set(error, cause);
  return error;
}
function safe(error: unknown): A2AError {
  // Dependencies may carry sensitive SDK messages too; only public semantic classes survive.
  for (const ErrorClass of [RequestMalformedError, TaskNotFoundError, TaskNotCancelableError,
    UnsupportedOperationError, ContentTypeNotSupportedError, PushNotificationNotSupportedError,
    ExtensionSupportRequiredError, VersionNotSupportedError]) {
    if (error instanceof ErrorClass) {
      const publicError = new ErrorClass();
      errorSources.set(publicError, error);
      return publicError;
    }
  }
  if (error instanceof A2AError) {
    const category = error.metadata?.category;
    return failure(category && controlledCategories.has(category) ? category as Category : 'unknown', error);
  }
  if (error instanceof RuntimeError) {
    if (error.kind === 'invalid-request') return new RequestMalformedError('Invalid A2A request.');
    return failure(controlledCategories.has(error.kind) ? error.kind as Category : 'unavailable', error);
  }
  return failure('unknown', error);
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
function id(value: unknown): string {
  try { const result = identifier(value, 'A2A identifier'); if (!result.isWellFormed()) throw new Error(); return result; } catch { throw new RequestMalformedError('Invalid A2A identifier.'); }
}
function signalOption(value: unknown): asserts value is AbortSignal | undefined {
  if (value !== undefined && !(value instanceof AbortSignal)) throw new RuntimeError('invalid-request', 'Invalid cancellation signal.');
}
function json(value: unknown, depthLimit: number, byteLimit: number): asserts value is JsonValue {
  const seen = new Set<object>();
  function visit(v: unknown, depth: number): void {
    if (depth > depthLimit) throw new RequestMalformedError('JSON depth limit exceeded.');
    if (typeof v === 'string') { if (!v.isWellFormed()) throw new RequestMalformedError('Invalid JSON string.'); return; }
    if (v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) return;
    if (typeof v !== 'object' || v === null || (!Array.isArray(v) && !record(v)) || seen.has(v)) throw new RequestMalformedError('Invalid JSON value.');
    seen.add(v);
    if (Object.getOwnPropertySymbols(v).length) throw new RequestMalformedError('Invalid JSON value.');
    if (Object.getOwnPropertyNames(v).length !== Object.keys(v).length + (Array.isArray(v) ? 1 : 0)) throw new RequestMalformedError('Invalid JSON properties.');
    for (const key of Object.keys(v)) {
      if (!key.isWellFormed()) throw new RequestMalformedError('Invalid JSON key.');
      const descriptor = Object.getOwnPropertyDescriptor(v, key);
      if (!descriptor || !('value' in descriptor)) throw new RequestMalformedError('Invalid JSON value.');
      visit(descriptor.value, depth + 1);
    }
    if (Array.isArray(v) && Object.keys(v).length !== v.length) throw new RequestMalformedError('Invalid JSON array.');
    seen.delete(v);
  }
  visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > byteLimit) throw new RequestMalformedError('JSON size limit exceeded.');
}
function withHistory(task: Task, length: number | undefined): Task {
  const copy = structuredClone(task);
  if (length !== undefined) copy.history = length === 0 ? [] : copy.history.slice(-length);
  return copy;
}
function historyLength(value: number | undefined): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new RequestMalformedError('Invalid historyLength.');
}
function signalFor(context: ServerCallContext, global: AbortSignal, local?: AbortSignal): AbortSignal {
  const wait = context.state.get('omniops.waitSignal');
  signalOption(wait); signalOption(local);
  return AbortSignal.any([global, ...(wait ? [wait] : []), ...(local ? [local] : [])]);
}
function checkSignal(signal: AbortSignal): void {
  if (signal.aborted) throw failure(signal.reason === closingReason ? 'unavailable' : 'aborted');
}
function contextPrincipal(context: ServerCallContext): A2APrincipal {
  if (!context || !(context.state instanceof Map) || typeof context.setTenant !== 'function' || typeof context.addActivatedExtension !== 'function' || !context.user?.isAuthenticated) throw failure('authentication');
  const principal: unknown = context.state.get('omniops.principal');
  if (!record(principal)) throw failure('authentication');
  let p: A2APrincipal;
  try { p = { organizationId: id(principal.organizationId), callerId: id(principal.callerId), installationId: id(principal.installationId) }; }
  catch { throw failure('authentication'); }
  if (context.user.userName !== principalOwner(p)) throw failure('authentication');
  return Object.freeze(p);
}
function backgroundContext(context: ServerCallContext, tenant: string): ServerCallContext {
  return new ServerCallContext({ requestedVersion: context.requestedVersion, user: { isAuthenticated: context.user!.isAuthenticated, userName: context.user!.userName }, tenant, requestedExtensions: [...(context.requestedExtensions ?? [])], state: new Map([['omniops.principal', contextPrincipal(context)]]) });
}

export async function createA2AService(options: A2AServiceOptions, callOptions: CallOptions = {}): Promise<A2AService> {
  if (!options || typeof options.directory !== 'string' || !isAbsolute(options.directory) || !options.runtime || typeof options.runtime.reserveRun !== 'function' || typeof options.resolveEndpoint !== 'function') throw new RuntimeError('invalid-request', 'Invalid A2AService options.');
  if (!callOptions || typeof callOptions !== 'object' || Array.isArray(callOptions)) throw new RuntimeError('invalid-request', 'Invalid call options.');
  signalOption(callOptions.signal);
  const limits = { ...options.limits };
  for (const name of ['maxRequestBytes', 'maxTaskBytes', 'maxJsonDepth', 'maxWaiters', 'maxSubscriptions'] as const) {
    if (!Number.isSafeInteger(limits[name]) || limits[name] <= 0) throw new RuntimeError('invalid-request', 'A2A limits must be positive safe integers.');
  }
  if (callOptions.signal?.aborted) throw new RuntimeError('aborted', 'A2AService construction canceled.');
  const store = await openA2AStore({ directory: options.directory, maxTaskBytes: limits.maxTaskBytes, signal: callOptions.signal });
  if (callOptions.signal?.aborted) { await store.close(); throw new RuntimeError('aborted', 'A2AService construction canceled.'); }
  const shutdown = new AbortController();
  let closing = false;
  let storageFault = false;
  let closeWork: Promise<void> | undefined;
  let waiters = 0;
  let subscriptions = 0;
  const operations = new Set<Promise<unknown>>();
  const sharedBuses = new DefaultExecutionEventBusManager();
  type Job = { initial: Task; context: ServerCallContext; endpoint: OfficialEndpoint; reservation: RunReservation; input: JsonObject; threadId: string; runId: string; work: Promise<void>; updates: Promise<void>; stopping: boolean; candidate?: Task; released: boolean; failure?: unknown };
  const jobs = new Map<string, Job>();
  const uncertainReservations = new Set<RunReservation>();
  type Lease = { bus: ExecutionEventBus; dispose: () => void };
  const leases = new WeakMap<ServerCallContext, Lease>();
  const liveLeases = new Set<Lease>();
  const key = (taskId: string, c: ServerCallContext) => canonicalize([c.tenant, c.user?.userName, taskId]);
  const manager: ExecutionEventBusManager = {
    createOrGetByTaskId: (taskId, c) => sharedBuses.createOrGetByTaskId(taskId, c),
    getByTaskId: (taskId, c) => c && leases.has(c) ? leases.get(c)!.bus : sharedBuses.getByTaskId(taskId, c),
    cleanupByTaskId: (taskId, c) => sharedBuses.cleanupByTaskId(taskId, c),
  };
  function open(): void { if (closing) throw failure('unavailable'); }
  function tracked<T>(work: () => Promise<T>): Promise<T> {
    const p = Promise.resolve().then(work);
    operations.add(p);
    void p.then(() => operations.delete(p), () => operations.delete(p));
    return p;
  }
  async function guarded<T>(work: () => Promise<T>): Promise<T> {
    try { return await tracked(work); } catch (error) { throw safe(error); }
  }
  function checkRequest(value: unknown): void { json(value, limits.maxJsonDepth, limits.maxRequestBytes); }
  async function authorize(c: ServerCallContext, tenant: string, local?: AbortSignal): Promise<OfficialEndpoint> {
    open(); contextPrincipal(c); id(tenant);
    const signal = signalFor(c, shutdown.signal, local); checkSignal(signal);
    let endpoint: OfficialEndpoint;
    try { endpoint = await options.resolveEndpoint(c, tenant, { signal }); }
    catch (error) { if (signal.aborted) throw failure(signal.reason === closingReason ? 'unavailable' : 'aborted', error); throw error; }
    checkSignal(signal); open();
    if (!endpoint || typeof endpoint !== 'object' || !endpoint.card) throw failure('unavailable');
    id(endpoint.agentId);
    if (!/^[a-f0-9]{64}$/.test(endpoint.contentId)) throw failure('unavailable');
    // SDK serializers are conversion helpers; validate the resulting public card as well.
    const card = AgentCard.toJSON(endpoint.card); json(card, limits.maxJsonDepth, limits.maxTaskBytes);
    if (!endpoint.card.supportedInterfaces.some(i => i.tenant === tenant && i.protocolVersion === '1.0') || endpoint.card.capabilities?.pushNotifications || endpoint.card.capabilities?.extendedAgentCard || !endpoint.card.capabilities?.streaming) throw failure('unavailable');
    if (c.requestedVersion !== '1.0') throw new VersionNotSupportedError();
    validateVersion(c.requestedVersion, endpoint.card);
    const declared = endpoint.card.capabilities.extensions ?? [];
    if (!declared.some(e => e.uri === RECEIPT_EXTENSION && e.required) || declared.some(e => e.required && (e.uri !== RECEIPT_EXTENSION || !c.requestedExtensions?.includes(e.uri))) || !c.requestedExtensions?.includes(RECEIPT_EXTENSION)) throw new ExtensionSupportRequiredError('Delivery receipt extension is required.');
    const supported = new Set(declared.map(e => e.uri));
    c.setRequestedExtensions(c.requestedExtensions.filter(e => supported.has(e)));
    c.addActivatedExtension(RECEIPT_EXTENSION);
    return structuredClone(endpoint);
  }
  async function checkBound(c: ServerCallContext, tenant: string, endpoint: OfficialEndpoint, wire: unknown): Promise<void> {
    checkRequest(wire);
    if (c.tenant !== tenant) throw new RequestMalformedError('Tenant mismatch.');
    const current = await authorize(c, tenant);
    if (current.agentId !== endpoint.agentId || current.contentId !== endpoint.contentId || canonicalize(AgentCard.toJSON(current.card)) !== canonicalize(AgentCard.toJSON(endpoint.card))) throw failure('forbidden');
  }
  function lease(taskId: string, c: ServerCallContext): Lease | undefined {
    const source = sharedBuses.getByTaskId(taskId, c);
    if (!source) return undefined;
    const signal = signalFor(c, shutdown.signal); checkSignal(signal);
    const bus = new DefaultExecutionEventBus();
    const forward = (event: AgentExecutionEvent) => bus.publish(structuredClone(event));
    const finished = () => bus.finished();
    source.on('event', forward); source.on('finished', finished);
    const result: Lease = { bus, dispose() {
      source.off('event', forward); source.off('finished', finished);
      signal.removeEventListener('abort', finished);
      bus.finished(); bus.removeAllListeners(); liveLeases.delete(result); leases.delete(c);
    } };
    signal.addEventListener('abort', finished, { once: true });
    leases.set(c, result); liveLeases.add(result);
    return result;
  }
  function fault(error: unknown, job?: Job): void {
    storageFault = true;
    if (job) {
      job.failure = error;
      sharedBuses.getByTaskId(job.initial.id, job.context)?.finished();
      sharedBuses.cleanupByTaskId(job.initial.id, job.context);
    }
  }
  async function persist(job: Job): Promise<void> {
    if (!job.candidate) throw failure('storage');
    await job.updates;
    const current = await store.taskStore.load(job.initial.id, job.context);
    if (current && !isTerminalTask(current)) {
      job.candidate.history = [...current.history];
      if (job.candidate.status?.message) job.candidate.history.push(job.candidate.status.message);
    }
    await new ResultManager(store.taskStore, job.context).processEvent(AgentEvent.task(job.candidate));
    const final = await store.taskStore.load(job.initial.id, job.context);
    if (!final || !isTerminalTask(final)) throw failure('storage');
    job.reservation.release(); job.released = true;
    const bus = sharedBuses.getByTaskId(final.id, job.context);
    for (const artifact of final.artifacts) bus?.publish(AgentEvent.artifactUpdate({ taskId: final.id, contextId: final.contextId, artifact, append: false, lastChunk: true, metadata: undefined }));
    bus?.publish(AgentEvent.statusUpdate({ taskId: final.id, contextId: final.contextId, status: final.status, metadata: structuredClone(final.metadata) }));
    bus?.finished();
    sharedBuses.cleanupByTaskId(final.id, job.context);
    jobs.delete(key(final.id, job.context));
  }
  async function run(job: Job): Promise<void> {
    let outcome: ExecutionOutcome<JsonValue>;
    try { outcome = await job.reservation.execute({ threadId: job.threadId, runId: job.runId, agent: { agentId: job.endpoint.agentId, contentId: job.endpoint.contentId }, input: structuredClone(job.input) }); }
    catch (error) {
      // Broken injected dependencies still settle the accepted Task safely.
      outcome = { ok: false, error: new ExecutionError('graph', error) };
    }
    const final = structuredClone(job.initial);
    final.status = { state: TaskState.TASK_STATE_FAILED, timestamp: new Date().toISOString(), message: undefined };
    if (outcome.ok) {
      try {
        json(outcome.output, limits.maxJsonDepth, limits.maxTaskBytes);
        const artifact: Artifact = { artifactId: randomUUID(), name: 'result', description: '', parts: [{ content: { $case: 'data', value: structuredClone(outcome.output) }, mediaType: 'application/json', metadata: undefined, filename: '' }], metadata: undefined, extensions: [] };
        final.artifacts = [artifact]; final.status.state = TaskState.TASK_STATE_COMPLETED;
        // Reserve space for the SHA metadata injected by the store.
        if (Buffer.byteLength(JSON.stringify(Task.toJSON(final))) + 512 > limits.maxTaskBytes) throw new RequestMalformedError();
      } catch { final.artifacts = []; final.status.state = TaskState.TASK_STATE_FAILED; final.status.message = message(final, 'invalid-output', 'Agent output is not valid bounded JSON.'); }
    } else {
      const kind = outcome.error.kind;
      final.status.state = kind === 'cancelled' ? TaskState.TASK_STATE_CANCELED : TaskState.TASK_STATE_FAILED;
      const allowed = new Set(['cancelled', 'timed-out', 'missing-input', 'login-required', 'invalid-output']);
      final.status.message = message(final, allowed.has(kind) ? kind : 'execution-failed', kind === 'cancelled' ? 'Task canceled after execution drained.' : 'Agent execution failed.');
    }
    if (final.status.message) final.history.push(final.status.message);
    final.metadata = { ...final.metadata, [RECEIPT_EXTENSION]: { resultSha256: taskResultSha256(final) } };
    job.candidate = final;
    await persist(job);
  }
  function requestStop(job: Job): void {
    if (job.candidate || job.reservation.requestStop() === 'result-fixed') throw new TaskNotCancelableError('Task cannot be canceled.');
  }
  const executor: AgentExecutor = {
    async execute(request, eventBus) {
      const job = jobs.get(key(request.taskId, request.context));
      if (!job) throw failure('unavailable');
      eventBus.publish(AgentEvent.task(structuredClone(job.initial)));
      await run(job);
    },
    async cancelTask(taskId, eventBus) {
      // This same SDK bridge is used by the custom cancellation path below.
      const job = [...jobs.values()].find(j => j.initial.id === taskId && sharedBuses.getByTaskId(taskId, j.context) === eventBus);
      if (!job) throw new TaskNotCancelableError('Task cannot be canceled.');
      requestStop(job);
    },
  };
  async function accept(p: SendMessageRequest, c: ServerCallContext, endpoint: OfficialEndpoint): Promise<Task> {
    const wire = SendMessageRequest.toJSON(p); checkRequest(wire);
    const m = p.message;
    if (!m) throw new RequestMalformedError('Message is required.');
    id(m.messageId); if (m.contextId) id(m.contextId);
    if (m.taskId) {
      id(m.taskId);
      if (!await store.taskStore.load(m.taskId, c)) throw new TaskNotFoundError('Task not found.');
      throw new UnsupportedOperationError('A terminal task cannot be resumed.');
    }
    if (m.role !== Role.ROLE_USER || m.referenceTaskIds.length || m.parts.length !== 1 || m.parts[0].content?.$case !== 'data') throw new ContentTypeNotSupportedError('One JSON data part is required.');
    const part = m.parts[0];
    if (part.mediaType && part.mediaType !== 'application/json') throw new ContentTypeNotSupportedError('JSON input is required.');
    const input: unknown = part.content!.value;
    json(input, limits.maxJsonDepth, limits.maxRequestBytes);
    if (!record(input)) throw new RequestMalformedError('Input must be a JSON object.');
    const config = p.configuration;
    if (config?.taskPushNotificationConfig) throw new PushNotificationNotSupportedError();
    if (config?.acceptedOutputModes.length && !config.acceptedOutputModes.includes('application/json')) throw new ContentTypeNotSupportedError('JSON output must be accepted.');
    historyLength(config?.historyLength);
    const fingerprint = createHash('sha256').update(canonicalize({ agentId: endpoint.agentId, contentId: endpoint.contentId, tenant: c.tenant, message: Message.toJSON(m), metadata: p.metadata ?? {} })).digest('hex');
    const fixed = backgroundContext(c, c.tenant!);
    let reservation: RunReservation | undefined;
    let threadId: string | undefined;
    let runId: string | undefined;
    let committed = false;
    try {
      const accepted = await store.accept({ principal: contextPrincipal(c), messageId: m.messageId, fingerprint, agentId: endpoint.agentId, contentId: endpoint.contentId, context: c }, () => {
        open(); checkSignal(signalFor(c, shutdown.signal));
        if (storageFault) throw failure('storage');
        const task = Task.fromJSON({ id: randomUUID(), contextId: m.contextId || randomUUID(), status: { state: 'TASK_STATE_WORKING', timestamp: new Date().toISOString() }, history: [Message.toJSON(m)] });
        // A new accepted task must always have room for a safe failure and seal.
        if (Buffer.byteLength(JSON.stringify(Task.toJSON(task))) + 2048 > limits.maxTaskBytes) throw new RequestMalformedError('Input cannot fit a terminal task.');
        try { reservation = options.runtime.reserveRun(); }
        catch (error) {
          if (!(error instanceof RuntimeError) || error.kind !== 'busy') throw error;
          task.status = { state: TaskState.TASK_STATE_REJECTED, timestamp: new Date().toISOString(), message: message(task, 'busy', 'Runtime capacity is full.') };
          task.history.push(task.status.message!);
          return { task };
        }
        threadId = randomUUID(); runId = randomUUID();
        return { task, threadId, runId };
      }, () => { open(); checkSignal(signalFor(c, shutdown.signal)); });
      committed = true;
      if (accepted.fresh && reservation && threadId && runId) {
        const job: Job = { initial: structuredClone(accepted.task), context: fixed, endpoint, reservation, threadId, runId, input: structuredClone(input) as JsonObject, work: Promise.resolve(), updates: Promise.resolve(), stopping: false, released: false };
        jobs.set(key(accepted.task.id, fixed), job);
        sharedBuses.createOrGetByTaskId(accepted.task.id, fixed);
        // Consumers never own this execution/persistence promise.
        job.work = executor.execute(new RequestContext(structuredClone(p), accepted.task.id, accepted.task.contextId, fixed, structuredClone(accepted.task)), new DefaultExecutionEventBus());
        void job.work.catch(error => fault(error, job));
        if (closing) reservation.requestStop();
      }
      return structuredClone(accepted.task);
    } catch (error) {
      if (!committed && error instanceof RuntimeError && 'acceptanceUnknown' in error && error.acceptanceUnknown === true) { storageFault = true; if (reservation) uncertainReservations.add(reservation); }
      else if (!committed) reservation?.release();
      throw error;
    }
  }

  class BoundHandler extends DefaultRequestHandler {
    private readonly endpoint: OfficialEndpoint;
    private readonly tenant: string;
    constructor(endpoint: OfficialEndpoint, tenant: string) {
      super(endpoint.card, store.taskStore, executor, manager);
      this.endpoint = endpoint; this.tenant = tenant;
    }
    override async getAgentCard(): Promise<AgentCard> { open(); return structuredClone(await super.getAgentCard()); }
    private async checked(c: ServerCallContext, tenant: string, wire: unknown): Promise<void> {
      if (tenant !== this.tenant) throw new RequestMalformedError('Tenant mismatch.');
      await checkBound(c, this.tenant, this.endpoint, wire);
    }
    override sendMessage(p: SendMessageRequest, c: ServerCallContext): Promise<Message | Task> {
      return guarded(async () => {
        await this.checked(c, p.tenant, SendMessageRequest.toJSON(p));
        const signal = signalFor(c, shutdown.signal); checkSignal(signal);
        const blocking = !p.configuration?.returnImmediately;
        if (blocking && waiters >= limits.maxWaiters) throw failure('resource-limit');
        if (blocking) waiters++;
        try {
          const task = await accept(p, c, this.endpoint);
          if (!blocking || isTerminalTask(task)) return withHistory(task, p.configuration?.historyLength);
          const job = jobs.get(key(task.id, c));
          if (!job) {
            const latest = await store.taskStore.load(task.id, c);
            if (latest && isTerminalTask(latest)) return withHistory(latest, p.configuration?.historyLength);
            throw failure('unavailable');
          }
          await wait(job.work, signal);
          const latest = await store.taskStore.load(task.id, c);
          if (!latest || !isTerminalTask(latest)) throw failure('storage');
          return withHistory(latest, p.configuration?.historyLength);
        } finally { if (blocking) waiters--; }
      });
    }
    private async *sendStream(p: SendMessageRequest, c: ServerCallContext): AsyncGenerator<StreamResponse, void, undefined> {
      let acquired = false;
      try {
        await this.checked(c, p.tenant, SendMessageRequest.toJSON(p));
        if (subscriptions >= limits.maxSubscriptions) throw failure('resource-limit');
        subscriptions++; acquired = true;
        const task = await tracked(() => accept(p, c, this.endpoint));
        // The default resubscribe path supplies the current snapshot with its
        // listener-before-load ordering; no second initial Task is broadcast.
        const current = await store.taskStore.load(task.id, c);
        if (current && isTerminalTask(current)) { yield { payload: { $case: 'task', value: withHistory(current, p.configuration?.historyLength) } }; return; }
        yield* this.observe({ id: task.id, tenant: this.tenant }, c, p.configuration?.historyLength, true);
      } catch (error) { throw safe(error); }
      finally { if (acquired) subscriptions--; }
    }
    private async *observe(p: SubscribeToTaskRequest, c: ServerCallContext, length?: number, allowTerminal = false): AsyncGenerator<StreamResponse, void, undefined> {
      const owned = lease(p.id, c);
      const signal = signalFor(c, shutdown.signal);
      let terminal = false;
      let started = false;
      try {
        for await (const event of super.resubscribe(p, c)) {
          checkSignal(signal);
          if (event.payload?.$case === 'task') { terminal = isTerminalTask(event.payload.value); event.payload.value = withHistory(event.payload.value, length); }
          if (event.payload?.$case === 'statusUpdate') terminal = [TaskState.TASK_STATE_COMPLETED, TaskState.TASK_STATE_FAILED, TaskState.TASK_STATE_REJECTED, TaskState.TASK_STATE_CANCELED].includes(event.payload.value.status?.state ?? 0);
          started = true;
          yield event;
        }
        checkSignal(signal);
        if (!terminal) throw failure(storageFault ? 'storage' : 'unavailable');
      } catch (error) {
        if (!started && allowTerminal && error instanceof UnsupportedOperationError) {
          const final = await store.taskStore.load(p.id, c);
          if (final && isTerminalTask(final)) { yield { payload: { $case: 'task', value: withHistory(final, length) } }; return; }
        }
        throw error;
      } finally { owned?.dispose(); }
    }
    private async *subscribe(p: SubscribeToTaskRequest, c: ServerCallContext): AsyncGenerator<StreamResponse, void, undefined> {
      let acquired = false;
      try {
        await this.checked(c, p.tenant, SubscribeToTaskRequest.toJSON(p)); id(p.id);
        if (subscriptions >= limits.maxSubscriptions) throw failure('resource-limit');
        subscriptions++; acquired = true;
        yield* this.observe(p, c);
      } catch (error) { throw safe(error); }
      finally { if (acquired) subscriptions--; }
    }
    override sendMessageStream(p: SendMessageRequest, c: ServerCallContext): AsyncGenerator<StreamResponse, void, undefined> {
      return cancellable(c, () => this.sendStream(p, c));
    }
    override resubscribe(p: SubscribeToTaskRequest, c: ServerCallContext): AsyncGenerator<StreamResponse, void, undefined> {
      return cancellable(c, () => this.subscribe(p, c));
    }
    override getTask(p: GetTaskRequest, c: ServerCallContext): Promise<Task> {
      return guarded(async () => { await this.checked(c, p.tenant, GetTaskRequest.toJSON(p)); id(p.id); historyLength(p.historyLength); return super.getTask(p, c); });
    }
    override listTasks(p: ListTasksRequest, c: ServerCallContext): Promise<ListTasksResponse> {
      return guarded(async () => { await this.checked(c, p.tenant, ListTasksRequest.toJSON(p)); return super.listTasks(p, c); });
    }
    override cancelTask(p: CancelTaskRequest, c: ServerCallContext): Promise<Task> {
      return guarded(async () => {
        await this.checked(c, p.tenant, CancelTaskRequest.toJSON(p)); id(p.id);
        const task = await store.taskStore.load(p.id, c);
        if (!task) throw new TaskNotFoundError('Task not found.');
        if (isTerminalTask(task)) throw new TaskNotCancelableError('Task cannot be canceled.');
        const job = jobs.get(key(p.id, c));
        if (!job) {
          const current = await store.taskStore.load(p.id, c);
          if (current && isTerminalTask(current)) throw new TaskNotCancelableError('Task cannot be canceled.');
          throw failure('unavailable');
        }
        if (job.candidate) throw new TaskNotCancelableError('Task cannot be canceled.');
        if (!job.stopping) {
          requestStop(job);
          job.stopping = true;
          job.updates = job.updates.then(async () => {
            const stopping = { ...task, status: { state: TaskState.TASK_STATE_WORKING, timestamp: new Date().toISOString(), message: message(task, 'stopping', 'Task is stopping.') } };
            stopping.history = [...task.history, stopping.status.message];
            await new ResultManager(store.taskStore, job.context).processEvent(AgentEvent.task(stopping));
            sharedBuses.getByTaskId(task.id, job.context)?.publish(AgentEvent.statusUpdate({ taskId: task.id, contextId: task.contextId, status: stopping.status, metadata: undefined }));
          });
          void job.updates.catch(error => fault(error, job));
        }
        await job.updates;
        const latest = await store.taskStore.load(p.id, c);
        if (!latest) throw failure('storage');
        if (isTerminalTask(latest)) throw new TaskNotCancelableError('Task cannot be canceled.');
        return latest;
      });
    }
    override getAuthenticatedExtendedAgentCard(p: GetExtendedAgentCardRequest, c: ServerCallContext): Promise<AgentCard> {
      return guarded(async () => { await this.checked(c, p.tenant, GetExtendedAgentCardRequest.toJSON(p)); return super.getAuthenticatedExtendedAgentCard(p, c); });
    }
    override createTaskPushNotificationConfig(p: TaskPushNotificationConfig, c: ServerCallContext): Promise<TaskPushNotificationConfig> {
      return guarded(async () => { await this.checked(c, p.tenant, TaskPushNotificationConfig.toJSON(p)); return super.createTaskPushNotificationConfig(p, c); });
    }
    override getTaskPushNotificationConfig(p: GetTaskPushNotificationConfigRequest, c: ServerCallContext): Promise<TaskPushNotificationConfig> {
      return guarded(async () => { await this.checked(c, p.tenant, GetTaskPushNotificationConfigRequest.toJSON(p)); return super.getTaskPushNotificationConfig(p, c); });
    }
    override listTaskPushNotificationConfigs(p: ListTaskPushNotificationConfigsRequest, c: ServerCallContext): Promise<ListTaskPushNotificationConfigsResponse> {
      return guarded(async () => { await this.checked(c, p.tenant, ListTaskPushNotificationConfigsRequest.toJSON(p)); return super.listTaskPushNotificationConfigs(p, c); });
    }
    override deleteTaskPushNotificationConfig(p: DeleteTaskPushNotificationConfigRequest, c: ServerCallContext): Promise<void> {
      return guarded(async () => { await this.checked(c, p.tenant, DeleteTaskPushNotificationConfigRequest.toJSON(p)); return super.deleteTaskPushNotificationConfig(p, c); });
    }
  }
  return {
    protocolFor: (c, tenant, opts = {}) => guarded(async () => new BoundHandler(await authorize(c, tenant, opts.signal), tenant)),
    confirmTaskDelivery: (request, c, opts = {}) => guarded(async () => {
      checkRequest(request); await authorize(c, request.tenant, opts.signal);
      if (c.tenant !== request.tenant) throw new RequestMalformedError('Tenant mismatch.');
      id(request.taskId);
      if (!/^[a-f0-9]{64}$/.test(request.resultSha256) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(request.receivedAt) || !Number.isFinite(Date.parse(request.receivedAt))) throw new RequestMalformedError('Invalid delivery receipt.');
      return store.confirm(request, c);
    }),
    close(opts) {
      if (!opts || !Number.isFinite(opts.deadline) || opts.deadline < 0) return Promise.reject(new RuntimeError('invalid-request', 'Invalid close deadline.'));
      if (closeWork) return closeWork;
      closing = true; shutdown.abort(closingReason);
      const stopErrors: unknown[] = [];
      const attempted = new Set<Job>();
      const stopOwned = () => {
        for (const job of jobs.values()) {
          if (attempted.has(job) || job.stopping || job.candidate) continue;
          attempted.add(job);
          try { if (job.reservation.requestStop() === 'requested') job.stopping = true; }
          catch (error) { stopErrors.push(error); }
        }
      };
      stopOwned();
      const cleanup = async () => {
        await Promise.allSettled([...operations]);
        stopOwned();
        await Promise.allSettled([...jobs.values()].map(j => j.work));
        const errors: unknown[] = [...stopErrors];
        for (const job of [...jobs.values()]) {
          if (job.candidate && !job.released && job.failure) {
            try { job.updates = Promise.resolve(); await persist(job); } catch (error) { errors.push(error); }
          } else if (!job.released) errors.push(job.failure ?? failure('unavailable'));
        }
        for (const reservation of uncertainReservations) reservation.release();
        uncertainReservations.clear();
        for (const l of liveLeases) l.dispose();
        await store.close();
        if (errors.length) throw new RuntimeError('storage', 'A2AService could not settle all tasks.');
      };
      // Cleanup keeps ownership if the caller's budget expires; it never
      // destroys SQLite under a pending transaction or releases active runs.
      const work = cleanup(); void work.catch(() => {});
      closeWork = untilDeadline(work, opts.deadline).catch(error => {
        if (performance.now() >= opts.deadline) throw new RuntimeError('timeout', 'A2AService shutdown timed out.');
        if (error instanceof RuntimeError) throw error;
        throw new RuntimeError('storage', 'A2AService shutdown failed.');
      });
      return closeWork;
    },
  };
}

function wait<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const aborted = () => {
      signal.removeEventListener('abort', aborted);
      try { checkSignal(signal); } catch (error) { reject(error); }
    };
    if (signal.aborted) { aborted(); return; }
    signal.addEventListener('abort', aborted, { once: true });
    void promise.then(value => { signal.removeEventListener('abort', aborted); resolve(value); }, error => { signal.removeEventListener('abort', aborted); reject(error); });
  });
}

/** return() must wake a pending next() before queuing generator disposal. */
function cancellable(c: ServerCallContext, create: () => AsyncGenerator<StreamResponse, void, undefined>): AsyncGenerator<StreamResponse, void, undefined> {
  const controller = new AbortController();
  let iterator: AsyncGenerator<StreamResponse, void, undefined> | undefined;
  let closed = false;
  const start = () => {
    if (!iterator) {
      const signal = c.state.get('omniops.waitSignal');
      signalOption(signal);
      c.state.set('omniops.waitSignal', AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]));
      iterator = create();
    }
    return iterator;
  };
  return {
    next: async (...args) => closed ? Promise.resolve({ done: true, value: undefined }) : start().next(...args),
    return: async value => { closed = true; controller.abort(); return iterator ? iterator.return(value) : { done: true, value: await value }; },
    throw: error => { closed = true; controller.abort(); return iterator ? iterator.throw(error) : Promise.reject(error); },
    [Symbol.asyncIterator]() { return this; },
    [Symbol.asyncDispose]() { return this.return().then(() => {}); },
  };
}

function untilDeadline<T>(promise: Promise<T>, deadline: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      const remaining = deadline - performance.now();
      if (remaining <= 0) reject(new RuntimeError('timeout', 'A2AService shutdown timed out.'));
      else timer = setTimeout(tick, Math.min(Math.ceil(remaining), 2_147_483_647));
    };
    tick();
    void promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}
