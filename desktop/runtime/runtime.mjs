import { randomUUID } from 'node:crypto';
import { Command, MemorySaver } from '@langchain/langgraph';
import { createBrowserAgent, browserSchemas } from './agent.mjs';
import { createChatEvents } from './chat-events.mjs';
import { chatInput, httpUrl, identifier } from './input.mjs';
import { invalid, RuntimeError, safeError } from './errors.mjs';

const stable = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const fingerprint = action => action.name === 'run_playwright_script'
  ? stable({ name: action.name, sha256: action.args.sha256, parameters: action.args.parameters ?? {} })
  : stable({ name: action.name, args: action.args });

export function createDesktopRuntime({ browser, workspace, modelFactory, modelName, emit = () => {}, redact = String, getAgent }) {
  let state = { simulated: false, task: null, browser: browser.getState(), browserRequest: 0 };
  let active, navigation, closing = false;
  const publish = patch => { state = { ...state, ...patch }; emit({ event: 'desktop_state', state }); };
  browser.subscribe(snapshot => publish({ browser: snapshot }));
  const updateTask = (run, patch) => { if (active === run) publish({ task: { ...state.task, ...patch } }); };
  const chat = (run, data) => { if (!run.terminal) emit({ event: 'chat_event', runId: run.id, threadId: run.threadId, data }); };

  async function pendingAction(run, value, id) {
    run.controller.signal.throwIfAborted();
    const args = browserSchemas[value.name]?.parse(value.args);
    if (!args) throw new RuntimeError('invalid-response', 'Agent 请求了不支持的审批操作。');
    const action = { name: value.name, args, callId: value.tool_call_id || id };
    if (run.rejected.has(fingerprint(action))) return { action, automatic: true };
    let code, targetUrl;
    if (action.name === 'run_playwright_script') {
      const source = await workspace.read(args.name);
      code = source.code;
      if (source.sha256 !== args.sha256) return { action, automatic: true, changed: true };
      // A script can navigate away from the current page; only advertise an explicit URL.
      if (typeof args.parameters?.url === 'string') {
        try { targetUrl = httpUrl(args.parameters.url); } catch { /* The script parameters remain visible for review. */ }
      }
    } else targetUrl = args.url ? httpUrl(args.url) : state.browser.url || undefined;
    run.controller.signal.throwIfAborted();
    run.events.tool(action);
    publish({ browserRequest: state.browserRequest + 1 });
    const approval = {
      id, callId: action.callId,
      title: action.name === 'inspect_browser' ? (args.url ? '打开并读取网页' : '读取当前网页') : '运行浏览器脚本',
      description: action.name === 'inspect_browser' ? '读取页面结构与可见控件，供 Agent 决定下一步。' : '在内置浏览器中执行已保存的脚本；具体页面与操作以源码和参数为准。',
      ...(targetUrl ? { targetUrl } : {}), toolName: action.name,
      parameters: JSON.stringify(args, null, 2), ...(code ? { code } : {}),
    };
    const decision = Promise.withResolvers();
    run.pending = { id, action, decision };
    updateTask(run, { phase: 'awaiting-approval', approval, error: undefined });
    return { action, response: await decision.promise };
  }

  async function execute(run) {
    let built;
    try {
      run.controller.signal.throwIfAborted();
      const configuration = run.agentId ? getAgent?.(run.agentId) : undefined;
      if (run.agentId && !configuration) throw invalid('所选 Agent 不存在。');
      built = createBrowserAgent({
        model: modelFactory(run.input.model), signal: run.controller.signal, workspace, browser,
        checkpointer: new MemorySaver(), extraInstructions: run.input.instructions,
        toolIds: configuration?.toolIds, redact,
        onTool: event => run.events.tool(event, event.result, event.error, event.type === 'end'),
      });
      run.drain = built.drain;
      const config = { configurable: { thread_id: run.id }, recursionLimit: 60, signal: run.controller.signal, streamMode: ['messages', 'updates'] };
      const initialIds = new Set();
      let input = { messages: run.input.messages.map(message => { const id = randomUUID(); initialIds.add(id); return { ...message, id }; }) };
      for (let round = 0; ; round++) {
        if (round >= 60) throw new RuntimeError('unavailable', 'Agent 未能完成任务，请缩小任务范围后重试。');
        run.controller.signal.throwIfAborted();
        updateTask(run, { phase: 'running', approval: undefined, error: undefined });
        const stream = await built.agent.stream(input, config);
        for await (const [mode, data] of stream) if (mode === 'messages') run.events.token(data[0]);
        await built.drain();
        run.controller.signal.throwIfAborted();
        const snapshot = await built.agent.getState(config);
        const messages = snapshot.values?.messages ?? [];
        run.events.snapshot(messages, initialIds);
        const completed = new Set(messages.filter(message => message.getType?.() === 'tool').map(message => message.tool_call_id));
        const interrupt = (snapshot.tasks ?? []).flatMap(task => task.interrupts ?? [])
          .find(item => item.value?.type === 'tool_approval' && !run.handled.has(item.id) && !completed.has(item.value.tool_call_id));
        if (!interrupt) break;
        const pending = await pendingAction(run, interrupt.value, interrupt.id);
        run.controller.signal.throwIfAborted();
        const response = pending.automatic
          ? { type: 'reject', message: pending.changed ? '脚本源码已改变，请重新读取并申请新审批。' : '此操作已被用户拒绝。请采用不同方案，不要再次申请相同操作。' }
          : pending.response;
        if (!response) throw new DOMException('Stopped', 'AbortError');
        run.handled.add(interrupt.id);
        input = new Command({ resume: { [interrupt.id]: response } });
      }
      const parts = run.events.finish();
      chat(run, { type: 'completed', response: { assistant: { parts }, finish: { reason: 'stop' }, usage: {}, metadata: run.metadata } });
    } catch (error) {
      await built?.drain();
      const failure = run.controller.signal.aborted ? { kind: 'aborted', message: '任务已停止。' } : safeError(error);
      chat(run, { type: 'failed', error: failure });
    } finally {
      run.terminal = true;
      run.pending = undefined;
      if (active === run) { active = undefined; publish({ task: null }); }
      run.done.resolve();
    }
  }

  function start({ runId, threadId, request, agentId } = {}) {
    if (closing) throw new RuntimeError('unavailable', '应用正在关闭。');
    if (active || navigation) throw new RuntimeError('unavailable', '另一项任务或导航仍在进行，请先停止或等待完成。');
    identifier(runId, 'runId'); identifier(threadId, 'threadId');
    const input = chatInput(request, modelName);
    if (agentId !== undefined) identifier(agentId, 'agentId');
    const run = { id: runId, threadId, agentId, input, controller: new AbortController(), done: Promise.withResolvers(), rejected: new Set(), handled: new Set(), terminal: false };
    run.metadata = { providerName: '本地配置模型', protocolName: 'deepagents', requestedModel: input.model };
    run.events = createChatEvents(data => chat(run, data));
    active = run;
    publish({ task: { runId, threadId, title: input.title, phase: 'running' } });
    chat(run, { type: 'started', metadata: run.metadata });
    queueMicrotask(() => void execute(run));
    return { runId };
  }

  async function decide({ runId, approvalId, decision, reason } = {}) {
    const run = active;
    if (!run || run.id !== runId || run.pending?.id !== approvalId || state.task.phase !== 'awaiting-approval') throw invalid('这项审批已失效或已提交。');
    if (!['approve', 'reject'].includes(decision)) throw invalid('请选择允许或拒绝此操作。');
    if (reason !== undefined && (typeof reason !== 'string' || reason.length > 4000)) throw invalid('审批理由最多 4000 字符。');
    const pending = run.pending;
    updateTask(run, { phase: 'submitting', error: undefined });
    try {
      if (decision === 'approve' && pending.action.name === 'run_playwright_script') {
        if ((await workspace.read(pending.action.args.name)).sha256 !== pending.action.args.sha256) throw invalid('脚本源码已改变，请拒绝此操作，让 Agent 重新申请。');
      }
      if (active !== run || run.controller.signal.aborted) throw invalid('任务已停止，这项审批不再执行。');
      if (decision === 'reject') run.rejected.add(fingerprint(pending.action));
      run.pending = undefined;
      pending.decision.resolve({ type: decision, ...(decision === 'reject' ? { message: reason?.trim() || '用户拒绝此操作，请采用不同方案。' } : {}) });
      return { accepted: true };
    } catch (error) {
      if (active === run && !run.controller.signal.aborted) updateTask(run, { phase: 'awaiting-approval', error: safeError(error).message });
      throw error;
    }
  }

  async function stop({ runId } = {}) {
    identifier(runId, 'runId');
    const run = active;
    if (!run) return { stopped: true };
    if (run.id !== runId) throw invalid('这项任务已结束，请停止当前任务。');
    if (!run.controller.signal.aborted) {
      updateTask(run, { phase: 'stopping', approval: undefined, error: undefined });
      run.controller.abort(new DOMException('Stopped', 'AbortError'));
      run.pending?.decision.resolve(null);
      run.pending = undefined;
    }
    await run.done.promise;
    return { stopped: true };
  }

  async function navigate(method, params) {
    if (closing || active || navigation) throw new RuntimeError('unavailable', '请先停止当前任务或等待导航完成。');
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
      if (method === 'decide') return decide(params);
      if (method === 'stop') return stop(params);
      if (['navigate', 'back', 'forward', 'reload'].includes(method)) return navigate(method, params);
      throw invalid('不支持此本地操作。');
    },
    async close() {
      closing = true;
      if (active) await stop({ runId: active.id });
      await browser.close();
      await navigation?.catch(() => {});
    },
  };
}
