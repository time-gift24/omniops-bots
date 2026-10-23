import { isAIMessage, isToolMessage, type BaseMessage } from '@langchain/core/messages';
import type { ProtocolEvent } from '@langchain/langgraph';
import type { ToolEvent } from '../graphs/browser-agent.ts';

export type ChatPart = { type: 'text'; text: string } | { type: 'tool-call'; call: {
  callId: string; name: string; inputText: string; output?: unknown; errorText?: string;
} };
export type ChatEvent = {
  type: string; partId?: number; kind?: string; name?: string; text?: string; content?: ChatPart;
  error?: { kind: string; message: string }; response?: unknown; metadata?: unknown;
};
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};
export const contentText = (content: unknown): string => typeof content === 'string' ? content : Array.isArray(content)
  ? content.map(value => object(value)).filter(part => part.type === 'text').map(part => typeof part.text === 'string' ? part.text : '').join('') : '';

/** One output part per model message/tool call; callbacks and snapshots share IDs. */
export function createChatEvents(emit: (event: ChatEvent) => void) {
  type Part = { partId: number; kind: 'text' | 'tool-call'; text: string; complete: boolean; content?: ChatPart };
  const parts = new Map<string, Part>();
  const streams = new Map<string, { id: string; assistant: boolean }>();
  const put = (key: string, kind: Part['kind'], name?: string): Part => {
    let part = parts.get(key);
    if (!part) {
      part = { partId: parts.size, kind, text: '', complete: false };
      parts.set(key, part);
      emit({ type: 'part-started', partId: part.partId, kind, ...(name ? { name } : {}) });
    }
    return part;
  };
  const complete = (part: Part, content: ChatPart) => {
    if (part.complete) return;
    part.content = content;
    part.complete = true;
    emit({ type: 'part-completed', partId: part.partId, content });
  };
  function tool(call: Pick<ToolEvent, 'callId' | 'name' | 'args'>, result?: unknown, error?: string, done = false) {
    if (!call.callId) return;
    const part = put(`tool:${call.callId}`, 'tool-call', call.name);
    const inputText = JSON.stringify(call.args ?? {}, null, 2);
    if (!part.text) {
      part.text = inputText;
      emit({ type: 'delta', partId: part.partId, text: inputText });
    }
    if (done) complete(part, { type: 'tool-call', call: { callId: call.callId, name: call.name, inputText, ...(error ? { errorText: error } : { output: result }) } });
  }
  function token(message: { type?: string; id?: string; content?: unknown; getType?: () => string }) {
    if (!['ai', 'AIMessageChunk'].includes(message.getType?.() ?? message.type ?? '')) return;
    const text = contentText(message.content);
    if (!text) return;
    const part = put(`text:${message.id || 'response'}`, 'text');
    if (part.complete) return;
    part.text += text;
    emit({ type: 'delta', partId: part.partId, text });
  }
  return {
    protocol(event: ProtocolEvent) {
      if (event.method !== 'messages') return;
      const data = object(event.params.data);
      const key = JSON.stringify([event.params.namespace, data.run_id ?? 'default']);
      if (data.event === 'message-start') {
        streams.set(key, { id: typeof data.id === 'string' ? data.id : `stream:${key}`, assistant: !data.role || ['ai', 'assistant'].includes(String(data.role)) });
      } else if (data.event === 'message-finish') streams.delete(key);
      else {
        const stream = streams.get(key);
        if (!stream?.assistant) return;
        const delta = object(data.delta), content = object(data.content);
        const text = data.event === 'content-block-delta' && delta.type === 'text-delta' ? delta.text :
          data.event === 'content-block-start' && content.type === 'text' ? content.text : undefined;
        if (typeof text === 'string' && text) token({ type: 'ai', id: stream.id, content: text });
      }
    },
    token,
    tool,
    snapshot(messages: BaseMessage[], initialIds: Set<string>) {
      const outputs = new Map(messages.filter(isToolMessage).map(message => [message.tool_call_id, message]));
      for (const message of messages) {
        if (!isAIMessage(message) || message.id && initialIds.has(message.id)) continue;
        const text = contentText(message.content);
        if (text) {
          const part = put(`text:${message.id || 'response'}`, 'text');
          if (!part.text && !part.complete) emit({ type: 'delta', partId: part.partId, text });
          part.text = text;
          complete(part, { type: 'text', text });
        }
        for (const call of message.tool_calls ?? []) {
          const output = outputs.get(call.id ?? ''), artifact = object(output?.artifact);
          let result: unknown = artifact.value ?? output?.content;
          if (typeof result === 'string') { try { result = JSON.parse(result); } catch {} }
          const value = object(result);
          const error = output?.status === 'error' || value.error || ['failed', 'timed_out', 'cancelled'].includes(String(value.status))
            ? String(value.error || contentText(output?.content) || '操作未完成。') : undefined;
          tool({ callId: call.id, name: call.name, args: artifact.executedArgs ?? call.args }, result, error, Boolean(output));
        }
      }
    },
    finish(): ChatPart[] {
      for (const part of parts.values()) if (!part.complete && part.kind === 'text') complete(part, { type: 'text', text: part.text });
      return [...parts.values()].flatMap(part => part.content ? [part.content] : []);
    },
  };
}
