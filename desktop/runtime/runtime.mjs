import { createExecution } from './execution/index.ts';
import { createChatHistory } from './chat/history.mjs';
import { chatRecord, createChatRun } from './chat/adapter.mjs';
import { chatInput, httpUrl, identifier } from './input.mjs';
import { invalid, RuntimeError } from './errors.mjs';
import { join } from 'node:path';
import { createClientSettings } from './settings.mjs';

export async function createDesktopRuntime({ browser, workspace, workspaceFactory, modelFactory, modelName, resources, runsDir, checkpointer,
  timeoutMs = 300_000, maxConcurrentRuns = 4, settingsFile = join(runsDir, '.settings.json'), desktopVersion = '0.1.0', modelParameters = { temperature: 0 }, emit = () => {}, redact = String, env = process.env }) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000) throw invalid('每轮执行超时必须在 1ms 到一小时之间。');
  if (!checkpointer) throw invalid('执行必须配置 checkpoint 存储。');
  if (typeof browser?.forThread !== 'function') throw invalid('浏览器必须支持按会话绑定页面。');
  const execution = await createExecution({ recordsDirectory: runsDir, checkpointer });
  const history = await createChatHistory(runsDir);
  const settings = await createClientSettings({ file: settingsFile, defaultMaxConcurrentRuns: maxConcurrentRuns });
  const seen = new Set(execution.records.list().map(record => record.runId));
  let state = { simulated: false, tasks: [], task: null, browserThreadId: null, browser: browser.getState(), browserRequest: 0 };
  const active = new Map(), navigations = new Map();
  let closing = false;
  const publish = patch => { state = { ...state, ...patch }; emit({ event: 'desktop_state', state }); };
  const selectedThread = () => browser.getThreadId ? browser.getThreadId() : [...active.values()].at(-1)?.threadId ?? null;
  const publishTasks = (patch = {}) => {
    const tasks = [...active.values()].map(run => run.task);
    const browserThreadId = selectedThread();
    publish({ tasks, task: tasks.find(task => task.threadId === browserThreadId) ?? null, browserThreadId, ...patch });
  };
  browser.subscribe(snapshot => publishTasks({ browser: snapshot }));
  const updateTask = (run, patch) => {
    if (active.get(run.id) !== run) return;
    run.task = { ...run.task, ...patch };
    publishTasks();
  };
  async function execute(run) {
    const chat = run.chat;
    try {
      const outcome = await execution.execute({ threadId: run.threadId, runId: run.id, timeoutMs,
        signal: run.controller.signal, details: chat.details, prepare: chat.prepare, onEvent: chat.onEvent, settle: chat.settle });
      emit({ event: 'chat_event', runId: run.id, threadId: run.threadId, data: chat.terminal(outcome) });
    } finally {
      active.delete(run.id);
      publishTasks();
      run.done.resolve();
    }
  }
  function start({ runId, threadId, request, agentId, experimentSkillId } = {}) {
    if (closing) throw new RuntimeError('unavailable', '应用正在关闭。');
    identifier(runId, 'runId'); identifier(threadId, 'threadId');
    if (threadId === '__manual__') throw invalid('会话编号为浏览器保留编号。');
    if (seen.has(runId)) throw new RuntimeError('duplicate-run', '这次调用已接收，不能重复执行；请查看原执行记录。');
    if ([...active.values()].some(run => run.threadId === threadId) || navigations.has(threadId) || execution.isBusy(threadId)) {
      throw new RuntimeError('unavailable', '此会话另一项任务或导航仍在进行，请先停止或等待完成。');
    }
    if (active.size >= settings.current().maxConcurrentRuns) throw new RuntimeError('unavailable', '并发任务已达上限，请等待任务完成后重新发起。');
    const input = chatInput(request, modelName);
    if (agentId !== undefined) identifier(agentId, 'agentId');
    if (experimentSkillId !== undefined) identifier(experimentSkillId, 'experimentSkillId');
    const run = { id: runId, threadId, agentId, experimentSkillId, input, request, inputCount: request.messages.length,
      controller: new AbortController(), done: Promise.withResolvers(), task: { runId, threadId, title: input.title, phase: 'preparing' } };
    const boundBrowser = browser.forThread(threadId);
    run.chat = createChatRun({ run, execution, history, browser: boundBrowser, workspace, workspaceFactory, modelFactory, resources,
      desktopVersion, modelParameters, redact, env, emit,
      running: () => updateTask(run, { phase: 'running' }),
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
  return {
    getState: () => state,
    dispatch(method, params) {
      if (method === 'status') return state;
      if (method === 'settings_get') return settings.read();
      if (method === 'settings_save') {
        if (closing) throw new RuntimeError('unavailable', '应用正在关闭。');
        return settings.save(params?.settings);
      }
      if (method === 'models_list') return modelName ? [{ id: modelName, label: modelName }] : [];
      if (method === 'chat_start') return start(params);
      if (method === 'stop') return stop(params);
      if (method === 'browser_select') {
        if (closing) throw new RuntimeError('unavailable', '应用正在关闭。');
        const threadId = params?.threadId === null ? null : identifier(params?.threadId, 'threadId');
        if (threadId === '__manual__') throw invalid('会话编号为浏览器保留编号。');
        return browser.select(threadId).then(() => { publishTasks(); return { selected: true }; });
      }
      if (method === 'runs_list') return execution.records.list().map(chatRecord);
      if (method === 'run_get') {
        const runId = identifier(params?.runId, 'runId');
        if (!execution.records.has(runId)) throw invalid('执行记录不存在。');
        return chatRecord(execution.records.get(runId));
      }
      if (method === 'session_snapshot') return history.read(identifier(params?.threadId, 'threadId')).then(session => session?.snapshot ?? null);
      if (['navigate', 'back', 'forward', 'reload'].includes(method)) return navigate(method, params);
      throw invalid('不支持此本地操作。');
    },
    async close() {
      closing = true;
      await Promise.all([...active.keys()].map(runId => stop({ runId })));
      await execution.close();
      await Promise.allSettled([...navigations.values()]);
      await settings.close();
      await browser.close();
    },
  };
}
