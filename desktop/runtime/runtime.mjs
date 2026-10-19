import { createExecution } from './execution/index.ts';
import { createChatHistory } from './chat/history.mjs';
import { chatRecord, createChatRun } from './chat/adapter.mjs';
import { chatInput, httpUrl, identifier } from './input.mjs';
import { invalid, RuntimeError } from './errors.mjs';

export async function createDesktopRuntime({ browser, workspace, workspaceFactory, modelFactory, modelName, resources, runsDir, checkpointer,
  timeoutMs = 300_000, desktopVersion = '0.1.0', modelParameters = { temperature: 0 }, emit = () => {}, redact = String, env = process.env }) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000) throw invalid('每轮执行超时必须在 1ms 到一小时之间。');
  if (!checkpointer) throw invalid('执行必须配置 checkpoint 存储。');
  const execution = await createExecution({ recordsDirectory: runsDir, checkpointer });
  const history = await createChatHistory(runsDir);
  const seen = new Set(execution.records.list().map(record => record.runId));
  let state = { simulated: false, task: null, browser: browser.getState(), browserRequest: 0 };
  let active, navigation, closing = false;
  const publish = patch => { state = { ...state, ...patch }; emit({ event: 'desktop_state', state }); };
  browser.subscribe(snapshot => publish({ browser: snapshot }));
  const updateTask = (run, patch) => { if (active === run) publish({ task: { ...state.task, ...patch } }); };
  async function execute(run) {
    const chat = run.chat;
    try {
      const outcome = await execution.execute({ threadId: run.threadId, runId: run.id, timeoutMs,
        signal: run.controller.signal, details: chat.details, prepare: chat.prepare, onEvent: chat.onEvent, settle: chat.settle });
      emit({ event: 'chat_event', runId: run.id, threadId: run.threadId, data: chat.terminal(outcome) });
    } finally {
      if (active === run) { active = undefined; publish({ task: null }); }
      run.done.resolve();
    }
  }
  function start({ runId, threadId, request, agentId, experimentSkillId } = {}) {
    if (closing) throw new RuntimeError('unavailable', '应用正在关闭。');
    if (active || navigation || execution.isBusy()) throw new RuntimeError('unavailable', '另一项任务或导航仍在进行，请先停止或等待完成。');
    identifier(runId, 'runId'); identifier(threadId, 'threadId');
    if (seen.has(runId)) throw new RuntimeError('duplicate-run', '这次调用已接收，不能重复执行；请查看原执行记录。');
    const input = chatInput(request, modelName);
    if (agentId !== undefined) identifier(agentId, 'agentId');
    if (experimentSkillId !== undefined) identifier(experimentSkillId, 'experimentSkillId');
    const run = { id: runId, threadId, agentId, experimentSkillId, input, request, inputCount: request.messages.length,
      controller: new AbortController(), done: Promise.withResolvers() };
    run.chat = createChatRun({ run, execution, history, browser, workspace, workspaceFactory, modelFactory, resources,
      desktopVersion, modelParameters, redact, env, emit,
      running: () => updateTask(run, { phase: 'running' }),
      stopping: () => updateTask(run, { phase: 'stopping' }),
      browserRequested: () => publish({ browserRequest: state.browserRequest + 1 }),
    });
    seen.add(runId); active = run;
    publish({ task: { runId, threadId, title: input.title, phase: 'preparing' } });
    queueMicrotask(() => void execute(run));
    return { runId };
  }
  async function stop({ runId } = {}) {
    identifier(runId, 'runId');
    const run = active;
    if (!run) return { stopped: true };
    if (run.id !== runId) throw invalid('这项任务已结束，请停止当前任务。');
    if (!run.controller.signal.aborted) {
      updateTask(run, { phase: 'stopping' });
      run.controller.abort(new DOMException('Stopped', 'AbortError'));
    }
    await run.done.promise;
    return { stopped: true };
  }
  async function navigate(method, params) {
    if (closing || active || navigation || execution.isBusy()) throw new RuntimeError('unavailable', '请先停止当前任务或等待导航完成。');
    const url = method === 'navigate' ? httpUrl(params?.url, { normalize: true }) : undefined;
    navigation = Promise.resolve().then(() => browser.navigation(method, url));
    publish({ browserRequest: state.browserRequest + 1 });
    try { await navigation; return { navigated: true }; } finally { navigation = undefined; }
  }
  return {
    getState: () => state,
    dispatch(method, params) {
      if (method === 'status') return state;
      if (method === 'models_list') return modelName ? [{ id: modelName, label: modelName }] : [];
      if (method === 'chat_start') return start(params);
      if (method === 'stop') return stop(params);
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
      if (active) await stop({ runId: active.id });
      await execution.close();
      await navigation?.catch(() => {});
      await browser.close();
    },
  };
}
