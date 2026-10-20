import { createExecution } from './execution/index.ts';
import { createChatHistory } from './chat/history.mjs';
import { chatRecord, createChatRun } from './chat/adapter.mjs';
import { chatInput, httpUrl, identifier } from './input.mjs';
import { invalid, RuntimeError } from './errors.mjs';
import { join } from 'node:path';
import { createClientSettings } from './settings.mjs';
import { createOperationsBrowser } from './browser/browser.mjs';

/** Optional Provider catalog owns model selection and credentials; close aborts tests and runs before closing it. */
export async function createDesktopRuntime({ browser, operationsBrowser = createOperationsBrowser(), workspace, workspaceFactory, modelFactory, modelName, providers, resources, runsDir, checkpointer,
  timeoutMs = 300_000, maxConcurrentRuns = 4, settingsFile = join(runsDir, '.settings.json'), desktopVersion = '0.1.0', modelParameters = { temperature: 0 }, emit = () => {}, redact = String, env = process.env }) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000) throw invalid('每轮执行超时必须在 1ms 到一小时之间。');
  if (!checkpointer) throw invalid('执行必须配置 checkpoint 存储。');
  if (typeof browser?.forThread !== 'function') throw invalid('浏览器必须支持按会话绑定页面。');
  const execution = await createExecution({ recordsDirectory: runsDir, checkpointer });
  const history = await createChatHistory(runsDir);
  const settings = await createClientSettings({ file: settingsFile, defaultMaxConcurrentRuns: maxConcurrentRuns });
  const seen = new Set(execution.records.list().map(record => record.runId));
  let state = { simulated: false, tasks: [], task: null, browserThreadId: null, browser: browser.getState(), browserRequest: 0, operationsBrowser: operationsBrowser.getState() };
  const active = new Map(), navigations = new Map(), providerTests = new Map();
  let operationsNavigation;
  let closing = false;
  const publish = patch => { state = { ...state, ...patch }; emit({ event: 'desktop_state', state }); };
  const selectedThread = () => browser.getThreadId ? browser.getThreadId() : [...active.values()].at(-1)?.threadId ?? null;
  const publishTasks = (patch = {}) => {
    const tasks = [...active.values()].map(run => run.task);
    const browserThreadId = selectedThread();
    publish({ tasks, task: tasks.find(task => task.threadId === browserThreadId) ?? null, browserThreadId, ...patch });
  };
  browser.subscribe(snapshot => publishTasks({ browser: snapshot }));
  operationsBrowser.subscribe(snapshot => {
    state = { ...state, operationsBrowser: snapshot };
    emit({ event: 'operations_browser_state', state: snapshot });
  });
  const updateTask = (run, patch) => {
    if (active.get(run.id) !== run) return;
    run.task = { ...run.task, ...patch };
    publishTasks();
  };
  async function execute(run) {
    const chat = run.chat;
    try {
      if (providers) {
        const { binding } = await run.providerResolution;
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
  function start({ runId, threadId, request, workspacePath, agentId, experimentSkillId } = {}) {
    if (closing) throw new RuntimeError('unavailable', '应用正在关闭。');
    identifier(runId, 'runId'); identifier(threadId, 'threadId');
    if (threadId === '__manual__') throw invalid('会话编号为浏览器保留编号。');
    if (seen.has(runId)) throw new RuntimeError('duplicate-run', '这次调用已接收，不能重复执行；请查看原执行记录。');
    if ([...active.values()].some(run => run.threadId === threadId) || navigations.has(threadId) || execution.isBusy(threadId)) {
      throw new RuntimeError('unavailable', '此会话另一项任务或导航仍在进行，请先停止或等待完成。');
    }
    if (active.size >= settings.current().maxConcurrentRuns) throw new RuntimeError('unavailable', '并发任务已达上限，请等待任务完成后重新发起。');
    const input = chatInput(request, modelName, { managedModels: Boolean(providers) });
    if (agentId !== undefined) identifier(agentId, 'agentId');
    if (experimentSkillId !== undefined) identifier(experimentSkillId, 'experimentSkillId');
    const run = { id: runId, threadId, workspacePath, agentId, experimentSkillId, input, request, inputCount: request.messages.length,
      controller: new AbortController(), done: Promise.withResolvers(), task: { runId, threadId, title: providers ? '正在准备会话…' : input.title, phase: 'preparing' } };
    if (providers) {
      // Capture the selection before later settings writes; even preparation failures retain the fixed binding.
      run.fixedSnapshot = execution.records.list().find(record => record.threadId === threadId && record.details?.snapshot?.provider)?.details.snapshot;
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
  async function stop({ runId } = {}) {
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
  async function navigate(method, params) {
    const threadId = params && Object.hasOwn(params, 'threadId')
      ? params.threadId === null ? null : identifier(params.threadId, 'threadId')
      : selectedThread();
    if (threadId === '__manual__') throw invalid('会话编号为浏览器保留编号。');
    if (closing || navigations.has(threadId) || [...active.values()].some(run => run.threadId === threadId)) {
      throw new RuntimeError('unavailable', '请先停止当前任务或等待导航完成。');
    }
    const url = method === 'navigate' ? httpUrl(params?.url, { normalize: true }) : undefined;
    const page = browser.forThread(threadId);
    const navigation = Promise.resolve().then(() => page.navigation(method, url));
    navigations.set(threadId, navigation);
    publish({ browserRequest: state.browserRequest + 1 });
    try { await navigation; return { navigated: true }; } finally { navigations.delete(threadId); }
  }
  async function navigateOperations(method, params) {
    if (closing || operationsNavigation) throw new RuntimeError('unavailable', '请等待运维浏览器导航完成。');
    const url = method === 'navigate' ? httpUrl(params?.url, { normalize: true }) : undefined;
    operationsNavigation = Promise.resolve().then(() => operationsBrowser.navigation(method, url));
    try { await operationsNavigation; return { navigated: true }; }
    finally { operationsNavigation = undefined; }
  }
  return {
    getState: () => state,
    dispatch(method, params) {
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
          execution.records.list().find(record => record.threadId === threadId && record.details?.snapshot)?.details.snapshot ?? null);
      }
      if (['navigate', 'back', 'forward', 'reload'].includes(method)) return navigate(method, params);
      throw invalid('不支持此本地操作。');
    },
    async close() {
      closing = true;
      for (const test of providerTests.values()) test.controller.abort();
      await Promise.allSettled([...providerTests.values()].map(test => test.done).concat([...active.keys()].map(runId => stop({ runId }))));
      await execution.close();
      await Promise.allSettled([...navigations.values(), operationsNavigation]);
      await settings.close();
      await providers?.close();
      try { await browser.close(); }
      finally { await operationsBrowser.close(); }
    },
  };
}
