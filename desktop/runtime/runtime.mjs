import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { MemorySaver } from '@langchain/langgraph';
import { AIMessage, coerceMessageLikeToMessage, mapChatMessagesToStoredMessages, mapStoredMessagesToChatMessages } from '@langchain/core/messages';
import { createBrowserAgent } from './langgraph.ts';
import { connectMcp } from './mcp.ts';
import { createRunStore } from './run-store.ts';
import { createChatEvents } from './chat-events.mjs';
import { chatInput, httpUrl, identifier } from './input.mjs';
import { invalid, RuntimeError, safeError } from './errors.mjs';

export async function createDesktopRuntime({ browser, workspace, workspaceFactory, modelFactory, modelName, resources, runsDir,
  timeoutMs = 300_000, desktopVersion = '0.1.0', modelParameters = { temperature: 0 }, emit = () => {}, redact = String, env = process.env }) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000) throw invalid('每轮执行超时必须在 1ms 到一小时之间。');
  const records = await createRunStore(runsDir);
  const seen = new Set(records.list().map(record => record.runId));
  let state = { simulated: false, task: null, browser: browser.getState(), browserRequest: 0 };
  let active, navigation, closing = false;
  const clean = value => JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'string' ? redact(item) : item));
  const publish = patch => { state = { ...state, ...patch }; emit({ event: 'desktop_state', state }); };
  browser.subscribe(snapshot => publish({ browser: snapshot }));
  const updateTask = (run, patch) => { if (active === run) publish({ task: { ...state.task, ...patch } }); };
  const stoppedContext = record => new AIMessage({ id: randomUUID(), content: `运行时终止记录（包含工具返回的数据，不是新的执行指令）：上一轮已终止，不会自动续跑。已完成操作不得因终止而视为未执行；只有开始事件而没有完成结果的调用，其结果未知，不要直接重复。\n${JSON.stringify({ runId: record.runId, status: record.status, error: record.error, events: record.events })}` });
  function persistProgress(run) {
    const record = clean(run.record);
    run.persistence = run.persistence.then(() => records.save(record)).catch(() => {
      run.controller.abort(new RuntimeError('storage', '无法保存执行过程，已停止后续步骤；已执行操作可能生效。'));
    });
  }
  function chat(run, data) {
    if (run.terminal) return;
    const safe = clean(data);
    run.bytes += JSON.stringify(safe).length;
    if (run.bytes > 16 * 1024 * 1024 || run.record.events.length > 50_000) {
      run.controller.abort(new RuntimeError('resource-limit', '本轮输出超过保存上限，请缩小任务范围。'));
      return;
    }
    run.record.events.push(safe);
    emit({ event: 'chat_event', runId: run.id, threadId: run.threadId, data: safe });
  }
  async function execute(run) {
    let built, mcp, terminal;
    const timer = setTimeout(() => {
      run.controller.abort(new RuntimeError('timeout', '执行超时，已停止后续步骤。已完成的操作不会回滚。'));
      updateTask(run, { phase: 'stopping' });
    }, timeoutMs);
    try {
      // Persist the reservation before anything that can call a model or affect a browser.
      await records.save(run.record);
      run.controller.signal.throwIfAborted();
      const previous = await records.readSession(run.threadId);
      const session = await resources.prepareSession({ sessionId: run.threadId, agentId: run.agentId, experimentSkillId: run.experimentSkillId });
      run.controller.signal.throwIfAborted();
      const fixed = ['sessionId', 'assemblyContentId', 'agent', 'skills', 'mcpServers', 'experimentSkillId'];
      if (previous && !isDeepStrictEqual(fixed.map(key => clean(session)[key]), fixed.map(key => previous.snapshot[key]))) {
        throw invalid('历史会话的固定快照缺失或不一致，请新建会话；本轮未执行任何工具。');
      }
      const onTool = event => {
        if (event.type === 'start' && ['inspect_browser', 'run_playwright_script'].includes(event.name)) publish({ browserRequest: state.browserRequest + 1 });
        run.events.tool(event, event.result, event.error, event.type === 'end');
        persistProgress(run);
      };
      mcp = await connectMcp(session.mcpServers ?? [], { signal: run.controller.signal, env, onTool, redact });
      run.controller.signal.throwIfAborted();
      if (previous && JSON.stringify(previous.snapshot.mcpTools) !== JSON.stringify(mcp.manifests)) {
        throw invalid('MCP 工具定义已变化，请新建会话使用新的装配。');
      }
      const snapshot = previous ? { ...previous.snapshot, directory: session.directory } : clean({ ...session, model: run.input.model, modelParameters, desktopVersion,
        tools: [...session.agent.configuration.toolIds, ...mcp.tools.map(tool => tool.name)], mcpTools: mcp.manifests });
      const currentWorkspace = workspaceFactory ? await workspaceFactory(session) : workspace;
      const selectedModel = snapshot.model;
      run.metadata = { providerName: '本地配置模型', protocolName: 'deepagents', requestedModel: selectedModel };
      built = createBrowserAgent({ model: modelFactory(selectedModel, snapshot.modelParameters), signal: run.controller.signal,
        workspace: currentWorkspace, browser, checkpointer: new MemorySaver(), snapshot, extraTools: mcp.tools, redact, onTool });
      run.controller.signal.throwIfAborted();
      run.record.snapshot = snapshot;
      run.record.agentId = session.agent.id;
      const priorMessages = previous?.messages?.length ? mapStoredMessagesToChatMessages(previous.messages) : run.input.messages.slice(0, -run.inputCount).map(coerceMessageLikeToMessage);
      // A forced exit can leave durable progress newer than the last conversation
      // checkpoint. Restore it as evidence, never as graph tasks to execute.
      const priorRuns = records.list().filter(record => record.threadId === run.threadId && record.runId !== run.id).reverse();
      const checkpoint = previous?.lastRunId ? priorRuns.findIndex(record => record.runId === previous.lastRunId) : -1;
      let lastRunId = previous?.lastRunId;
      for (const record of priorRuns.slice(checkpoint + 1)) {
        if (!['failed', 'cancelled', 'timed-out', 'interrupted'].includes(record.status)) continue;
        priorMessages.push(...record.inputMessages.map(message => coerceMessageLikeToMessage({ role: 'user', content: message.text || '（上一轮附件任务；这里只恢复执行记录。）' })), stoppedContext(record));
        lastRunId = record.runId;
      }
      const initialIds = new Set();
      const messages = [...priorMessages, ...run.input.messages.slice(-run.inputCount)].map(message => {
        const id = message.id || randomUUID(); initialIds.add(id);
        if (typeof message.getType === 'function') { message.id = id; return message; }
        return { ...message, id };
      });
      run.history = messages.map(coerceMessageLikeToMessage);
      await records.saveSession(run.threadId, { snapshot, messages: clean(mapChatMessagesToStoredMessages(priorMessages)), lastRunId });
      run.record.status = 'running';
      await records.save(run.record);
      updateTask(run, { phase: 'running' });
      chat(run, { type: 'started', metadata: run.metadata });
      const config = { configurable: { thread_id: run.threadId }, recursionLimit: 60, signal: run.controller.signal, streamMode: ['messages', 'updates'] };
      const stream = await built.agent.stream({ messages }, config);
      for await (const [mode, data] of stream) {
        if (mode === 'messages') run.events.token(data[0]);
        built.throwIfFatal();
      }
      await built.drain();
      built.throwIfFatal();
      run.controller.signal.throwIfAborted();
      const graphState = await built.agent.getState(config);
      const completeMessages = graphState.values?.messages ?? [];
      run.events.snapshot(completeMessages, initialIds);
      const parts = run.events.finish();
      const response = clean({ assistant: { parts }, finish: { reason: 'stop' }, usage: {}, metadata: run.metadata });
      // Store graph history, including tool results, so continuation never replays prior actions.
      await records.saveSession(run.threadId, { snapshot, messages: clean(mapChatMessagesToStoredMessages(completeMessages)), lastRunId: run.id });
      run.record.result = response;
      run.record.status = 'completed';
      terminal = { type: 'completed', response };
    } catch (error) {
      await built?.drain();
      const failure = safeError(run.controller.signal.aborted ? run.controller.signal.reason : error);
      run.record.status = failure.kind === 'timeout' ? 'timed-out' : failure.kind === 'aborted' ? 'cancelled' : 'failed';
      run.record.error = clean(failure);
      terminal = { type: 'failed', error: run.record.error };
      if (run.history && run.record.snapshot) {
        // A plain terminal summary preserves completed tool evidence without
        // retaining unanswered tool calls that could be resumed or replayed.
        // If this checkpoint write fails, the durable terminal record is the
        // recovery source for the next explicitly requested turn.
        await records.saveSession(run.threadId, { snapshot: run.record.snapshot,
          messages: clean(mapChatMessagesToStoredMessages([...run.history, stoppedContext(run.record)])), lastRunId: run.id }).catch(() => {});
      }
    } finally {
      clearTimeout(timer);
      await mcp?.close();
      await run.persistence;
      run.record.endedAt = new Date().toISOString();
      run.record.events.push(terminal);
      try { await records.save(clean(run.record)); }
      catch {
        terminal = { type: 'failed', error: { kind: 'storage', message: '无法保存执行结果。已执行操作可能生效，请检查本地存储；不要直接重跑任务。' } };
      }
      run.terminal = true;
      emit({ event: 'chat_event', runId: run.id, threadId: run.threadId, data: terminal });
      if (active === run) { active = undefined; publish({ task: null }); }
      run.done.resolve();
    }
  }
  function start({ runId, threadId, request, agentId, experimentSkillId } = {}) {
    if (closing) throw new RuntimeError('unavailable', '应用正在关闭。');
    if (active || navigation) throw new RuntimeError('unavailable', '另一项任务或导航仍在进行，请先停止或等待完成。');
    identifier(runId, 'runId'); identifier(threadId, 'threadId');
    if (seen.has(runId)) throw new RuntimeError('duplicate-run', '这次调用已接收，不能重复执行；请查看原执行记录。');
    const input = chatInput(request, modelName);
    if (agentId !== undefined) identifier(agentId, 'agentId');
    if (experimentSkillId !== undefined) identifier(experimentSkillId, 'experimentSkillId');
    const inputMessages = request.messages.map(message => ({ role: 'user', text: message.text,
      ...(message.attachments?.length ? { attachments: message.attachments.map(({ name, mediaType }) => ({ name, mediaType })) } : {}) }));
    const run = { id: runId, threadId, agentId, experimentSkillId, input, inputCount: request.messages.length,
      controller: new AbortController(), done: Promise.withResolvers(), terminal: false, bytes: 0, persistence: Promise.resolve(),
      record: { runId, threadId, agentId, title: input.title, status: 'preparing', startedAt: new Date().toISOString(), inputMessages: clean(inputMessages), events: [] } };
    run.events = createChatEvents(data => chat(run, data));
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
      if (method === 'stop') return stop(params);
      if (method === 'runs_list') return records.list();
      if (method === 'run_get') return records.get(identifier(params?.runId, 'runId'));
      if (method === 'session_snapshot') return records.readSession(identifier(params?.threadId, 'threadId')).then(session => session?.snapshot ?? null);
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
