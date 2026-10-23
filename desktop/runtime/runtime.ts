import { Annotation, END, START, StateGraph, type BaseCheckpointSaver } from '@langchain/langgraph';
import { HumanMessage, AIMessage } from '@langchain/core/messages';
import { createBrowserAgent } from './graphs/browser-agent.ts';
import { connectMcp } from './mcp.ts';
import type { SessionAssembly } from './assembly.ts';
import type { createProviderCatalog, ProviderBinding } from './providers.ts';
import type { createBrowserService } from './browser/browser.ts';
import type { createResources } from './resources.ts';
import { ExecutionError, createExecution, type ExecutionOutcome } from './execution/index.ts';
import { createChatHistory } from './chat/history.ts';
import { chatRecord, createChatRun, type ChatRunInput, type ChatSession, type ChatDetails } from './chat/adapter.ts';
import { chatInput, httpUrl, identifier } from './input.ts';
import { invalid, RuntimeError } from './errors.ts';
import { join } from 'node:path';
import { createClientSettings } from './settings.ts';
import { createOperationsBrowser } from './browser/browser.ts';

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };
export type AgentVersionRef = Readonly<{ agentId: string; contentId: string }>;
export type RemoteRunRequest = Readonly<{ threadId: string; runId: string; agent: AgentVersionRef; input: JsonObject }>;
export interface RunReservation {
  execute(request: RemoteRunRequest): Promise<ExecutionOutcome<JsonValue>>;
  requestStop(): 'requested' | 'result-fixed';
  release(): void;
}
export interface RemoteRunAdmission { reserveRun(): RunReservation }

type Browser = ReturnType<typeof createBrowserService>;
type BoundBrowser = ReturnType<Browser['forThread']>;
type OperationsBrowser = ReturnType<typeof createOperationsBrowser>;
type Resources = ReturnType<typeof createResources>;
type Providers = Awaited<ReturnType<typeof createProviderCatalog>>;
type Provider = ProviderBinding;
type ProviderCatalog = Providers;
type Model = Parameters<typeof createBrowserAgent>[0]['model'];
type Workspace = Parameters<typeof createBrowserAgent>[0]['workspace'];
type Session = SessionAssembly & { workingDirectory: string; workspacePath?: string };
export type DesktopRuntimeOptions = {
  browser: Browser; operationsBrowser?: OperationsBrowser;
  workspace?: Workspace;
  workspaceFactory?: (session: Session, browser: BoundBrowser) => Workspace | Promise<Workspace>;
  modelFactory?: (name: string | undefined, parameters: Record<string, unknown>) => Model | Promise<Model>;
  modelName?: string; providers?: ProviderCatalog; resources: Resources; runsDir: string; checkpointer: BaseCheckpointSaver;
  timeoutMs?: number; maxConcurrentRuns?: number; settingsFile?: string; desktopVersion?: string;
  modelParameters?: Record<string, unknown>; emit?: (event: Record<string, unknown>) => void;
  redact?: (value: string) => string; env?: NodeJS.ProcessEnv;
};
type Task = { runId: string; threadId: string; title: string; phase: 'preparing' | 'running' | 'stopping' };
type State = {
  simulated: false; tasks: Task[]; task: Task | null; browserThreadId: string | null;
  browser: ReturnType<Browser['getState']>; browserRequest: number;
  operationsBrowser: ReturnType<OperationsBrowser['getState']>;
};
type LocalRun = ChatRunInput & {
  done: PromiseWithResolvers<void>; task: Task; chat?: ReturnType<typeof createChatRun>;
};
type RemoteReservation = RunReservation & { done?: Promise<ExecutionOutcome<JsonValue>>; threadId?: string };
const jsonLimit = 32 * 1024 * 1024;
function jsonValue(value: unknown): JsonValue {
  const seen = new Set<object>();
  const visit = (item: unknown, depth: number): void => {
    if (depth > 64) throw invalid('JSON 嵌套超过上限。');
    if (item === null || typeof item === 'string' || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item !== 'object' || seen.has(item) || Object.getOwnPropertySymbols(item).length ||
      !Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) throw invalid('业务值必须为有限 JSON 数据。');
    if (Array.isArray(item) && (Object.keys(item).length !== item.length || Object.keys(item).some((key, index) => key !== String(index)))) throw invalid('业务 JSON 不接受稀疏数组或数组附加属性。');
    seen.add(item);
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(item))) {
      if (descriptor.get || descriptor.set || !descriptor.enumerable && !(Array.isArray(item) && key === 'length')) throw invalid('业务 JSON 不接受访问器或隐藏属性。');
      visit(descriptor.value, depth + 1);
    }
    seen.delete(item);
  };
  visit(value, 0);
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) > jsonLimit) throw invalid('业务 JSON 超过 32 MiB 上限。');
  return JSON.parse(encoded) as JsonValue;
}


/** Optional Provider catalog owns model selection and credentials; close aborts tests and runs before closing it. */
export async function createDesktopRuntime({ browser, operationsBrowser = createOperationsBrowser(), workspace, workspaceFactory, modelFactory, modelName, providers, resources, runsDir, checkpointer,
  timeoutMs = 300_000, maxConcurrentRuns = 4, settingsFile = join(runsDir, '.settings.json'), desktopVersion = '0.1.0', modelParameters = { temperature: 0 }, emit = () => {}, redact = String, env = process.env }: DesktopRuntimeOptions) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000) throw invalid('每轮执行超时必须在 1ms 到一小时之间。');
  if (!checkpointer) throw invalid('执行必须配置 checkpoint 存储。');
  if (typeof browser?.forThread !== 'function') throw invalid('浏览器必须支持按会话绑定页面。');
  const execution = await createExecution({ recordsDirectory: runsDir, checkpointer });
  const history = await createChatHistory<ChatSession>(runsDir);
  const settings = await createClientSettings({ file: settingsFile, defaultMaxConcurrentRuns: maxConcurrentRuns });
  const seen = new Set(execution.records.list().map(record => record.runId));
  let state: State = { simulated: false, tasks: [], task: null, browserThreadId: null, browser: browser.getState(), browserRequest: 0, operationsBrowser: operationsBrowser.getState() };
  const active = new Map<string, LocalRun>(), navigations = new Map<string | null, Promise<unknown>>(), providerTests = new Map<string, { controller: AbortController; done: Promise<{ tested: boolean }> }>();
  const reservations = new Set<RemoteReservation>();
  let operationsNavigation: Promise<unknown> | undefined;
  let closing = false;
  let closeWork: Promise<void> | undefined;
  const publish = (patch: Partial<State>) => { state = { ...state, ...patch }; emit({ event: 'desktop_state', state }); };
  const selectedThread = () => browser.getThreadId ? browser.getThreadId() : [...active.values()].at(-1)?.threadId ?? null;
  const publishTasks = (patch: Partial<State> = {}) => {
    const tasks = [...active.values()].map(run => run.task);
    const browserThreadId = selectedThread();
    publish({ tasks, task: tasks.find(task => task.threadId === browserThreadId) ?? null, browserThreadId, ...patch });
  };
  browser.subscribe((snapshot: State['browser']) => publishTasks({ browser: snapshot }));
  operationsBrowser.subscribe((snapshot: State['operationsBrowser']) => {
    state = { ...state, operationsBrowser: snapshot };
    emit({ event: 'operations_browser_state', state: snapshot });
  });
  const updateTask = (run: LocalRun, patch: Partial<Task>) => {
    if (active.get(run.id) !== run) return;
    run.task = { ...run.task, ...patch };
    publishTasks();
  };
  async function execute(run: LocalRun) {
    const chat = run.chat;
    if (!chat) throw invalid('会话尚未装配。');
    try {
      if (providers) {
        const { binding } = await run.providerResolution!;
        const provider = run.fixedProvider ?? binding;
        if (provider) chat.details.snapshot = { ...run.fixedSnapshot, model: provider.id, provider, modelParameters, desktopVersion };
      }
      const outcome = await execution.execute({ threadId: run.threadId, runId: run.id, timeoutMs,
        signal: run.controller.signal, details: chat.details, prepare: chat.prepare, onEvent: chat.onEvent, settle: chat.settle });
      emit({ event: 'chat_event', runId: run.id, threadId: run.threadId, data: chat.terminal(outcome) });
    } finally {
      active.delete(run.id);
      publishTasks();
      run.done.resolve();
    }
  }
  function start(params: Record<string, unknown> = {}) {
    const { runId, threadId, request, workspacePath, agentId, experimentSkillId } = params;
    if (closing) throw new RuntimeError('unavailable', '应用正在关闭。');
    if (typeof runId !== 'string' || typeof threadId !== 'string') throw invalid('执行编号无效。');
    identifier(runId, 'runId'); identifier(threadId, 'threadId');
    if (threadId === '__manual__') throw invalid('会话编号为浏览器保留编号。');
    if (seen.has(runId)) throw new RuntimeError('duplicate-run', '这次调用已接收，不能重复执行；请查看原执行记录。');
    if ([...active.values()].some(run => run.threadId === threadId) || [...reservations].some(run => run.threadId === threadId) || navigations.has(threadId) || execution.isBusy(threadId)) {
      throw new RuntimeError('unavailable', '此会话另一项任务或导航仍在进行，请先停止或等待完成。');
    }
    if (active.size + reservations.size >= settings.current().maxConcurrentRuns) throw new RuntimeError('unavailable', '并发任务已达上限，请等待任务完成后重新发起。');
    const input = chatInput(request, modelName, { managedModels: Boolean(providers) });
    if (agentId !== undefined) identifier(agentId, 'agentId');
    if (experimentSkillId !== undefined) identifier(experimentSkillId, 'experimentSkillId');
    if (workspacePath !== undefined && typeof workspacePath !== 'string' || agentId !== undefined && typeof agentId !== 'string' || experimentSkillId !== undefined && typeof experimentSkillId !== 'string') throw invalid('会话装配参数无效。');
    if (!request || typeof request !== 'object' || !('messages' in request) || !Array.isArray(request.messages)) throw invalid('消息格式无效。');
    const run: LocalRun = { id: runId, threadId, workspacePath, agentId, experimentSkillId, input, request: request as ChatRunInput['request'], inputCount: request.messages.length,
      controller: new AbortController(), done: Promise.withResolvers<void>(), task: { runId, threadId, title: providers ? '正在准备会话…' : input.title, phase: 'preparing' } };
    if (providers) {
      // Capture the selection before later settings writes; even preparation failures retain the fixed binding.
      run.fixedSnapshot = execution.records.list().filter(record => record.threadId === threadId).map(record => record.details as ChatDetails | undefined).find(details => details?.snapshot?.provider)?.snapshot;
      run.fixedProvider = run.fixedSnapshot?.provider;
      run.providerResolution = providers.pin(input.model).then(binding => ({ binding }), error => ({ error }));
    }
    const boundBrowser = browser.forThread(threadId);
    run.chat = createChatRun({ run, execution, history, browser: boundBrowser, workspace, workspaceFactory, modelFactory, providers, resources,
      desktopVersion, modelParameters, redact, env, emit,
      running: () => updateTask(run, { phase: 'running', title: redact(run.input.title) }),
      stopping: () => updateTask(run, { phase: 'stopping' }),
      browserRequested: () => publish({ browserRequest: state.browserRequest + 1 }),
    });
    seen.add(runId); active.set(runId, run);
    publishTasks();
    queueMicrotask(() => void execute(run));
    return { runId };
  }
  async function stop({ runId }: Record<string, unknown> = {}) {
    if (typeof runId !== 'string') throw invalid('runId 无效。');
    identifier(runId, 'runId');
    const run = active.get(runId);
    if (!run) return { stopped: true };
    if (!run.controller.signal.aborted) {
      updateTask(run, { phase: 'stopping' });
      run.controller.abort(new DOMException('Stopped', 'AbortError'));
    }
    await run.done.promise;
    return { stopped: true };
  }
  async function navigate(method: string, params?: Record<string, unknown>) {
    const threadId = params && Object.hasOwn(params, 'threadId')
      ? params.threadId === null ? null : identifier(params.threadId, 'threadId')
      : selectedThread();
    if (threadId === '__manual__') throw invalid('会话编号为浏览器保留编号。');
    if (closing || navigations.has(threadId) || [...active.values()].some(run => run.threadId === threadId) || [...reservations].some(run => run.threadId === threadId)) {
      throw new RuntimeError('unavailable', '请先停止当前任务或等待导航完成。');
    }
    const url = method === 'navigate' ? httpUrl(params?.url, { normalize: true }) : undefined;
    const page = browser.forThread(threadId);
    const navigation = Promise.resolve().then(() => page.navigation(method, url));
    navigations.set(threadId, navigation);
    publish({ browserRequest: state.browserRequest + 1 });
    try { await navigation; return { navigated: true }; } finally { navigations.delete(threadId); }
  }
  async function navigateOperations(method: string, params?: Record<string, unknown>) {
    if (closing || operationsNavigation) throw new RuntimeError('unavailable', '请等待运维浏览器导航完成。');
    const url = method === 'navigate' ? httpUrl(params?.url, { normalize: true }) : undefined;
    operationsNavigation = Promise.resolve().then(() => operationsBrowser.navigation(method, url));
    try { await operationsNavigation; return { navigated: true }; }
    finally { operationsNavigation = undefined; }
  }
  function reserveRun(): RunReservation {
    if (closing) throw new RuntimeError('unavailable', '应用正在关闭。');
    if (active.size + reservations.size >= settings.current().maxConcurrentRuns) throw new RuntimeError('busy', '并发任务已达上限。');
    let released = false, started = false, drained = false, failedBeforeRun = false, stopRequested = false;
    let controller: AbortController | undefined;
    let runId: string | undefined;
    const reservation: RemoteReservation = {
      execute(request) {
        if (released || started || closing) return Promise.resolve({ ok: false, error: new ExecutionError(closing ? 'closed' : 'invalid-request') });
        started = true;
        const work = async (): Promise<ExecutionOutcome<JsonValue>> => {
          let input: JsonObject;
          try {
            if (!request || typeof request !== 'object' || !request.agent || typeof request.agent !== 'object') throw invalid('远端执行参数无效。');
            identifier(request.threadId, 'threadId'); identifier(request.runId, 'runId'); identifier(request.agent.agentId, 'agentId');
            if (request.threadId === '__manual__' || typeof request.agent.contentId !== 'string' || !/^[a-f0-9]{64}$/u.test(request.agent.contentId)) throw invalid('远端执行身份无效。');
            if (seen.has(request.runId)) throw new ExecutionError('duplicate-run');
            if (navigations.has(request.threadId) || [...active.values()].some(run => run.threadId === request.threadId) ||
                [...reservations].some(other => other !== reservation && other.threadId === request.threadId) || execution.isBusy(request.threadId)) throw new ExecutionError('busy');
            const value = jsonValue(request.input);
            if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('任务输入必须为 JSON 对象。');
            input = value;
            request = { threadId: request.threadId, runId: request.runId, agent: { agentId: request.agent.agentId, contentId: request.agent.contentId }, input };
          } catch (error) { failedBeforeRun = true; return { ok: false, error: error instanceof ExecutionError ? error : new ExecutionError('invalid-request', error) }; }
          runId = request.runId;
          reservation.threadId = request.threadId;
          seen.add(runId);
          controller = new AbortController();
          if (stopRequested) controller.abort(new ExecutionError('cancelled'));
          const outcome = await execution.execute({ threadId: request.threadId, runId, timeoutMs, signal: controller.signal,
            details: { origin: 'a2a', agentId: request.agent.agentId, contentId: request.agent.contentId },
            async prepare(scope) {
              const signal = scope.signal;
              signal.throwIfAborted();
              const session = await resources.prepareSession({ sessionId: request.threadId, agentId: request.agent.agentId, contentId: request.agent.contentId });
              signal.throwIfAborted();
              if (session.agent.source !== 'official' || session.agent.contentId !== request.agent.contentId) throw invalid('官方 Agent 版本不匹配。');
              const provider = providers ? await providers.pin() : undefined;
              signal.throwIfAborted();
              const model = provider ? await providers!.createModel(provider) : modelFactory ? await modelFactory(modelName, modelParameters) : undefined;
              signal.throwIfAborted();
              if (!model) throw new RuntimeError('unavailable', '请配置本地模型。');
              const boundBrowser = browser.forThread(request.threadId);
              const currentWorkspace = workspaceFactory ? await workspaceFactory(session, boundBrowser) : workspace;
              if (!currentWorkspace) throw new RuntimeError('unavailable', '任务工作空间未配置。');
              scope.defer(async () => { if (signal.aborted) await boundBrowser.stop?.(); });
              const mcp = await connectMcp(session.mcpServers ?? [], { signal, scope, env, redact });
              signal.throwIfAborted();
              const snapshot = { ...session, agent: { ...session.agent, configuration: { ...session.agent.configuration,
                instructions: `${session.agent.configuration.instructions}\nThe user message is the complete JSON task input. Return exactly one valid JSON value as the final response, with no markdown fences or surrounding prose.`,
              } } };
              await scope.updateDetails({ origin: 'a2a', agentId: request.agent.agentId, contentId: request.agent.contentId,
                snapshot: { ...session, ...(provider ? { model: provider.id, provider } : { model: modelName }), modelParameters, desktopVersion, mcpTools: mcp.manifests },
              });
              const agent = createBrowserAgent({ model, scope, workspace: currentWorkspace, browser: boundBrowser, snapshot, extraTools: mcp.tools, redact });
              const graphInput = Annotation.Root({ input: Annotation<JsonObject>() });
              const graphOutput = Annotation.Root({ value: Annotation<JsonValue>() });
              const stateSchema = Annotation.Root({ input: Annotation<JsonObject>(), value: Annotation<JsonValue>() });
              const graph = new StateGraph({ input: graphInput, output: graphOutput, stateSchema })
                .addNode('execute', async state => {
                  const result = await agent.invoke({ messages: [new HumanMessage(JSON.stringify(state.input))] }, { signal });
                  if (Array.isArray(result.__interrupt__) && result.__interrupt__.length) throw new ExecutionError('missing-input');
                  const final = result.messages.at(-1);
                  if (!(final instanceof AIMessage) || final.tool_calls?.length) throw new ExecutionError('missing-input');
                  const text = typeof final.content === 'string' ? final.content : final.content.map(block => 'text' in block ? block.text : '').join('');
                  try { return { value: jsonValue(JSON.parse(text)) }; }
                  catch (error) { throw new ExecutionError('invalid-output', error); }
                })
                .addEdge(START, 'execute').addEdge('execute', END).compile({ checkpointer: scope.checkpointer });
              return { graph, input: { input } };
            },
          });
          return outcome.ok ? { ...outcome, output: outcome.output.value } : outcome;
        };
        reservation.done = work().catch(error => ({ ok: false as const, error: new ExecutionError('adapter', error) })).finally(() => { drained = true; });
        return reservation.done;
      },
      requestStop() {
        if (drained || released || failedBeforeRun) return 'result-fixed';
        if (runId) return execution.requestStop(runId);
        stopRequested = true;
        controller?.abort(new ExecutionError('cancelled'));
        return 'requested';
      },
      release() {
        if (released) return;
        if (started && !drained) throw invalid('执行尚未排空，不能释放名额。');
        released = true;
        reservations.delete(reservation);
      },
    };
    reservations.add(reservation);
    return reservation;
  }
  return {
    reserveRun,
    getState: () => state,
    dispatch(method: string, params?: Record<string, unknown>) {
      if (method === 'status') return state;
      if (method === 'operations_browser_status') {
        if (closing) throw new RuntimeError('unavailable', '应用正在关闭。');
        return operationsBrowser.refresh().then(() => state.operationsBrowser);
      }
      if (['operations_browser_navigate', 'operations_browser_back', 'operations_browser_forward', 'operations_browser_reload'].includes(method)) {
        return navigateOperations(method.slice('operations_browser_'.length), params);
      }
      if (method === 'settings_get') return settings.read();
      if (method === 'settings_save') {
        if (closing) throw new RuntimeError('unavailable', '应用正在关闭。');
        return settings.save(params?.settings);
      }
      if (method === 'models_list') return providers ? providers.models() : modelName ? [{ id: modelName, label: modelName }] : [];
      if (['providers_get', 'provider_save', 'provider_remove', 'provider_default', 'provider_test', 'provider_test_cancel'].includes(method)) {
        if (closing || !providers) throw new RuntimeError('unavailable', 'Provider 管理暂不可用。');
        if (method === 'providers_get') return providers.read();
        if (method === 'provider_save') return providers.save(params);
        if (method === 'provider_remove') return providers.remove(params?.name);
        if (method === 'provider_default') return providers.setDefault(params);
        const testId = identifier(params?.testId, 'testId');
        if (method === 'provider_test_cancel') {
          providerTests.get(testId)?.controller.abort();
          return { stopped: true };
        }
        if (providerTests.has(testId)) throw new RuntimeError('duplicate-test', '这次连接测试已开始。');
        if (providerTests.size >= 8) throw new RuntimeError('resource-limit', '连接测试过多，请先停止或等待完成。');
        const controller = new AbortController();
        const done = Promise.resolve().then(() => providers.test({ provider: params?.provider, model: params?.model }, { signal: controller.signal }))
          .then(() => ({ tested: true })).finally(() => providerTests.delete(testId));
        providerTests.set(testId, { controller, done });
        return done;
      }
      if (method === 'chat_start') return start(params);
      if (method === 'stop') return stop(params);
      if (method === 'browser_select') {
        if (closing) throw new RuntimeError('unavailable', '应用正在关闭。');
        const threadId = params?.threadId === null ? null : identifier(params?.threadId, 'threadId');
        if (threadId === '__manual__') throw invalid('会话编号为浏览器保留编号。');
        const focus = params?.focus === undefined ? false : params.focus;
        if (typeof focus !== 'boolean') throw invalid('浏览器聚焦选项必须为布尔值。');
        return browser.select(threadId, { focus }).then(() => { publishTasks(); return { selected: true }; });
      }
      if (method === 'runs_list') return execution.records.list().map(chatRecord);
      if (method === 'run_get') {
        const runId = identifier(params?.runId, 'runId');
        if (!execution.records.has(runId)) throw invalid('执行记录不存在。');
        return chatRecord(execution.records.get(runId));
      }
      if (method === 'session_snapshot') {
        const threadId = identifier(params?.threadId, 'threadId');
        return history.read(threadId).then(session => session?.snapshot ??
          execution.records.list().filter(record => record.threadId === threadId).map(record => record.details as { snapshot?: unknown } | undefined).find(details => details?.snapshot)?.snapshot ?? null);
      }
      if (['navigate', 'back', 'forward', 'reload'].includes(method)) return navigate(method, params);
      throw invalid('不支持此本地操作。');
    },
    close({ deadline = performance.now() + 10_000 }: { deadline?: number } = {}): Promise<void> {
      if (!Number.isFinite(deadline) || deadline < 0) return Promise.reject(invalid('关闭期限无效。'));
      closing = true;
      closeWork ??= (async () => {
        for (const test of providerTests.values()) test.controller.abort();
        for (const reservation of reservations) reservation.requestStop();
        await Promise.allSettled([...providerTests.values()].map(test => test.done));
        await Promise.allSettled([...active.keys()].map(runId => stop({ runId })));
        await Promise.allSettled([...reservations].map(reservation => reservation.done));
        for (const reservation of [...reservations]) reservation.release();
        await execution.close();
        await Promise.allSettled([...navigations.values(), operationsNavigation]);
        const failures: unknown[] = [];
        for (const cleanup of [() => settings.close(), () => providers?.close(), () => browser.close(), () => operationsBrowser.close()]) {
          try { await cleanup(); } catch (error) { failures.push(error); }
        }
        if (failures.length) throw Object.assign(new RuntimeError('unavailable', '部分运行资源关闭失败。'), { cause: new AggregateError(failures) });
      })();
      // The tracked teardown remains owned after a deadline; no browser/storage is
      // declared closed while a cooperative model or tool is still draining.
      const remaining = deadline - performance.now();
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new RuntimeError('unavailable', '关闭超时，部分任务或资源尚未完成清理。')), Math.max(0, Math.min(remaining, 2_147_483_647)));
        closeWork!.then(() => { clearTimeout(timer); resolve(); }, error => { clearTimeout(timer); reject(error); });
      });
    },
  };
}
