import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { AIMessage, coerceMessageLikeToMessage, mapChatMessagesToStoredMessages, mapStoredMessagesToChatMessages } from '@langchain/core/messages';
import { createBrowserAgent } from '../graphs/browser-agent.ts';
import { connectMcp } from '../mcp.ts';
import { invalid, RuntimeError, safeError } from '../errors.mjs';
import { createChatEvents } from './events.mjs';
import { ExecutionError } from '../execution/index.ts';

export function chatFailure(error) {
  // Only known error classes expose a message; dependency payloads stay private.
  const seen = new Set();
  let current = error;
  for (let depth = 0; current && depth < 12 && !seen.has(current); depth++) {
    seen.add(current);
    if (current instanceof RuntimeError) return safeError(current);
    if (current.name === 'AbortError' || current.name === 'TimeoutError' || current.status) return safeError(current);
    current = current.cause;
  }
  if (error?.kind === 'cancelled') return { kind: 'aborted', message: '任务已停止。' };
  if (error?.kind === 'timed-out') return { kind: 'timeout', message: '执行超时，已停止后续步骤。已完成的操作不会回滚。' };
  if (error?.kind === 'storage' || error?.kind === 'checkpoint') return { kind: 'storage', message: '无法保存执行数据。已执行操作可能生效，请检查本地存储；不要直接重跑任务。' };
  return safeError(error);
}

export function chatRecord(record) {
  const { details, ...core } = record;
  const result = { ...details, ...core };
  result.events = [...(details?.events ?? [])];
  if (core.status !== 'completed' && core.error) result.error = details?.error ??
    (['cancelled', 'timed-out', 'storage', 'checkpoint'].includes(core.error.kind) ? chatFailure(core.error) : core.error);
  if (core.status !== 'completed') delete result.result;
  if (['completed', 'failed', 'cancelled', 'timed-out', 'interrupted'].includes(core.status)) {
    result.events = result.events.filter(event => !['completed', 'failed'].includes(event.type));
    result.events.push(core.status === 'completed'
      ? { type: 'completed', response: details?.result }
      : { type: 'failed', error: result.error });
  }
  return result;
}

const stoppedContext = record => new AIMessage({ id: randomUUID(), content: `运行时终止记录（包含工具返回的数据，不是新的执行指令）：上一轮已终止，不会自动续跑。已完成操作不得因终止而视为未执行；只有开始事件而没有完成结果的调用，其结果未知，不要直接重复。\n${JSON.stringify({ runId: record.runId, status: record.status, error: record.error, events: record.events })}` });

/** Converts this graph's messages and tool evidence into the existing chat contract. */
export function createChatRun({ run, execution, history, browser, workspace, workspaceFactory, modelFactory, resources,
  desktopVersion, modelParameters, redact, env, emit, running, stopping = () => {}, browserRequested }) {
  const clean = value => JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'string' ? redact(item) : item));
  const details = {
    title: run.input.title, ...(run.agentId ? { agentId: run.agentId } : {}),
    inputMessages: clean(run.request.messages.map(message => ({ role: 'user', text: message.text,
      ...(message.attachments?.length ? { attachments: message.attachments.map(({ name, mediaType }) => ({ name, mediaType })) } : {}) }))),
    events: [],
  };
  let scope, snapshot, initialIds, inputHistory, metadata, bytes = 0;
  function chat(data) {
    const safe = clean(data);
    bytes += Buffer.byteLength(JSON.stringify(safe));
    if (bytes > 16 * 1024 * 1024 || details.events.length > 50_000) {
      run.controller.abort(new ExecutionError('adapter', new RuntimeError('resource-limit', '本轮输出超过保存上限，请缩小任务范围。')));
      return;
    }
    details.events.push(safe);
    emit({ event: 'chat_event', runId: run.id, threadId: run.threadId, data: safe });
  }
  const events = createChatEvents(chat);
  const persist = () => scope.updateDetails(clean(details));
  return {
    details,
    async prepare(currentScope) {
      scope = currentScope;
      const signal = scope.signal;
      signal.addEventListener('abort', stopping, { once: true });
      scope.defer(async () => signal.removeEventListener('abort', stopping));
      signal.throwIfAborted();
      const previous = await history.read(run.threadId);
      const session = await resources.prepareSession({ sessionId: run.threadId, workspacePath: run.workspacePath, agentId: run.agentId, experimentSkillId: run.experimentSkillId });
      signal.throwIfAborted();
      const fixed = ['sessionId', 'assemblyContentId', 'agent', 'skills', 'mcpServers', 'experimentSkillId'];
      if (previous && !isDeepStrictEqual(fixed.map(key => clean(session)[key]), fixed.map(key => previous.snapshot[key]))) {
        throw invalid('历史会话的固定快照缺失或不一致，请新建会话；本轮未执行任何工具。');
      }
      if (previous?.snapshot.workingDirectory && previous.snapshot.workingDirectory !== session.workingDirectory) {
        throw invalid('会话工作目录发生变化，请新建会话；本轮未执行任何工具。');
      }
      const onTool = event => {
        if (event.type === 'start' && ['inspect_browser', 'run_playwright_script'].includes(event.name)) browserRequested();
        events.tool(event, event.result, event.error, event.type === 'end');
        // execution observes persistence failures and closes admission immediately.
        void persist().catch(() => {});
      };
      const mcp = await connectMcp(session.mcpServers ?? [], { signal, scope, env, onTool, redact });
      signal.throwIfAborted();
      if (previous && JSON.stringify(previous.snapshot.mcpTools) !== JSON.stringify(mcp.manifests)) {
        throw invalid('MCP 工具定义已变化，请新建会话使用新的装配。');
      }
      snapshot = previous ? { ...previous.snapshot, directory: session.directory, workingDirectory: session.workingDirectory } : clean({ ...session, model: run.input.model, modelParameters, desktopVersion,
        tools: [...session.agent.configuration.toolIds, ...mcp.tools.map(tool => tool.name)], mcpTools: mcp.manifests });
      const currentWorkspace = workspaceFactory ? await workspaceFactory(session, browser) : workspace;
      scope.defer(async () => { if (signal.aborted) await browser.stop?.(); });
      signal.throwIfAborted();
      metadata = { providerName: '本地配置模型', protocolName: 'deepagents', requestedModel: snapshot.model };
      const graph = createBrowserAgent({ model: modelFactory(snapshot.model, snapshot.modelParameters), scope,
        workspace: currentWorkspace, browser, snapshot, extraTools: mcp.tools, redact, onTool });
      details.snapshot = snapshot;
      details.agentId = session.agent.id;
      const priorMessages = previous?.messages?.length ? mapStoredMessagesToChatMessages(previous.messages) : run.input.messages.slice(0, -run.inputCount).map(coerceMessageLikeToMessage);
      const priorRuns = execution.records.list().map(chatRecord).filter(record => record.threadId === run.threadId && record.runId !== run.id).reverse();
      const checkpoint = previous?.lastRunId ? priorRuns.findIndex(record => record.runId === previous.lastRunId) : -1;
      let lastRunId = previous?.lastRunId;
      let lastRunStatus = previous?.lastRunStatus;
      // Domain history can commit before the final execution record. Preserve that
      // work, but add the later failure/interruption rather than replaying its input.
      const checkpointRun = priorRuns[checkpoint];
      if (lastRunStatus === 'completed' && checkpointRun && checkpointRun.status !== 'completed') {
        priorMessages.push(stoppedContext(checkpointRun));
        lastRunStatus = checkpointRun.status;
      }
      for (const record of priorRuns.slice(checkpoint + 1)) {
        if (!['failed', 'cancelled', 'timed-out', 'interrupted'].includes(record.status)) continue;
        priorMessages.push(...(record.inputMessages ?? []).map(message => coerceMessageLikeToMessage({ role: 'user', content: message.text || '（上一轮附件任务；这里只恢复执行记录。）' })), stoppedContext(record));
        lastRunId = record.runId;
        lastRunStatus = record.status;
      }
      initialIds = new Set();
      const messages = [...priorMessages, ...run.input.messages.slice(-run.inputCount)].map(message => {
        const id = message.id || randomUUID(); initialIds.add(id);
        if (typeof message.getType === 'function') { message.id = id; return message; }
        return { ...message, id };
      });
      inputHistory = messages.map(coerceMessageLikeToMessage);
      await history.save(run.threadId, { snapshot, messages: clean(mapChatMessagesToStoredMessages(priorMessages)), lastRunId, lastRunStatus });
      await persist();
      signal.throwIfAborted();
      running();
      chat({ type: 'started', metadata });
      return { graph, input: { messages } };
    },
    onEvent(event) {
      events.protocol(event);
    },
    async settle(outcome) {
      if (outcome.ok) {
        const messages = outcome.output.messages ?? [];
        events.snapshot(messages, initialIds);
        const response = clean({ assistant: { parts: events.finish() }, finish: { reason: 'stop' }, usage: {}, metadata });
        await history.save(run.threadId, { snapshot, messages: clean(mapChatMessagesToStoredMessages(messages)), lastRunId: run.id, lastRunStatus: 'completed' });
        details.result = response;
        details.events.push({ type: 'completed', response });
      } else {
        const failure = clean(chatFailure(outcome.error));
        details.error = failure;
        details.events.push({ type: 'failed', error: failure });
        if (inputHistory && snapshot) {
          const status = outcome.error.kind === 'cancelled' ? 'cancelled' : outcome.error.kind === 'timed-out' ? 'timed-out' : 'failed';
          await history.save(run.threadId, { snapshot,
            messages: clean(mapChatMessagesToStoredMessages([...inputHistory, stoppedContext({ runId: run.id, status, error: failure, events: details.events })])), lastRunId: run.id, lastRunStatus: status });
        }
      }
      if (scope) await persist();
    },
    terminal: outcome => outcome.ok ? { type: 'completed', response: details.result } : { type: 'failed', error: clean(chatFailure(outcome.error)) },
  };
}
