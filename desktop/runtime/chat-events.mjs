export const contentText = content => typeof content === 'string' ? content : (content || []).filter(part => part.type === 'text').map(part => part.text).join('');

/** One output part per model message/tool call; callbacks and snapshots share IDs. */
export function createChatEvents(emit) {
  const parts = new Map();
  const put = (key, kind, name) => {
    if (!parts.has(key)) {
      const part = { partId: parts.size, kind, text: '', complete: false };
      parts.set(key, part);
      emit({ type: 'part-started', partId: part.partId, kind, ...(name ? { name } : {}) });
    }
    return parts.get(key);
  };
  const complete = (part, content) => {
    if (part.complete) return;
    part.content = content;
    part.complete = true;
    emit({ type: 'part-completed', partId: part.partId, content });
  };
  function tool(call, result, error, done = false) {
    if (!call.callId) return;
    const part = put(`tool:${call.callId}`, 'tool-call', call.name);
    const inputText = JSON.stringify(call.args ?? {}, null, 2);
    if (!part.text) {
      part.text = inputText;
      emit({ type: 'delta', partId: part.partId, text: inputText });
    }
    if (done) complete(part, { type: 'tool-call', call: { callId: call.callId, name: call.name, inputText, ...(error ? { errorText: error } : { output: result }) } });
  }
  return {
    token(message) {
      if (!['ai', 'AIMessageChunk'].includes(message?.getType?.() ?? message?.type)) return;
      const text = contentText(message.content);
      if (!text) return;
      const part = put(`text:${message.id || 'response'}`, 'text');
      if (part.complete) return;
      part.text += text;
      emit({ type: 'delta', partId: part.partId, text });
    },
    tool,
    snapshot(messages, initialIds) {
      const outputs = new Map(messages.filter(message => (message.getType?.() ?? message.type) === 'tool').map(message => [message.tool_call_id, message]));
      for (const message of messages) {
        if ((message.getType?.() ?? message.type) !== 'ai' || initialIds.has(message.id)) continue;
        const text = contentText(message.content);
        if (text) {
          const part = put(`text:${message.id || 'response'}`, 'text');
          if (!part.text && !part.complete) emit({ type: 'delta', partId: part.partId, text });
          part.text = text;
          complete(part, { type: 'text', text });
        }
        for (const call of message.tool_calls ?? []) {
          const output = outputs.get(call.id);
          let result = output?.artifact?.value ?? output?.content;
          if (typeof result === 'string') { try { result = JSON.parse(result); } catch {} }
          const error = output?.status === 'error' || result?.error || ['failed', 'timed_out', 'cancelled'].includes(result?.status)
            ? String(result?.error || contentText(output?.content) || '操作未完成。') : undefined;
          tool({ callId: call.id, name: call.name, args: output?.artifact?.executedArgs ?? call.args }, result, error, Boolean(output));
        }
      }
    },
    finish() {
      for (const part of parts.values()) if (!part.complete && part.kind === 'text') complete(part, { type: 'text', text: part.text });
      return [...parts.values()].flatMap(part => part.content ? [part.content] : []);
    },
  };
}
