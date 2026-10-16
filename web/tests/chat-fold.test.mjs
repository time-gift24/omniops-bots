import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "vite";

async function loadFold(t) {
  const server = await createServer({ server: { middlewareMode: true }, appType: "custom" });
  t.after(() => server.close());
  return server.ssrLoadModule("/src/chat/fold.ts");
}

test("完整流式回合：事件依次折叠为运行中 → 完成的视图状态", async (t) => {
  const { createThreadState, appendUserMessage, foldChatEvent } = await loadFold(t);

  let state = createThreadState("t1");
  state = appendUserMessage(state, "为什么构建这么慢？");
  assert.equal(state.status, "submitted");
  assert.equal(state.messages.at(-1).role, "user");

  const metadata = { providerName: "p", protocolName: "mock", requestedModel: "m" };
  state = foldChatEvent(state, { type: "started", metadata });
  assert.equal(state.status, "streaming");
  assert.equal(state.messages.at(-1).role, "assistant");

  state = foldChatEvent(state, { type: "part-started", partId: 0, kind: "reasoning" });
  state = foldChatEvent(state, { type: "delta", partId: 0, text: "先想" });
  state = foldChatEvent(state, { type: "delta", partId: 0, text: "一下" });
  state = foldChatEvent(state, {
    type: "part-completed",
    partId: 0,
    content: { type: "reasoning", text: "先想一下" },
  });

  state = foldChatEvent(state, { type: "part-started", partId: 1, kind: "tool-call", name: "searchCode" });
  state = foldChatEvent(state, { type: "delta", partId: 1, text: '{"query":' });
  state = foldChatEvent(state, { type: "delta", partId: 1, text: '"x"}' });
  state = foldChatEvent(state, {
    type: "part-completed",
    partId: 1,
    content: {
      type: "tool-call",
      call: { callId: "c1", name: "searchCode", inputText: '{"query":"x"}', output: { files: ["a.ts"] } },
    },
  });

  state = foldChatEvent(state, { type: "part-started", partId: 2, kind: "text" });
  state = foldChatEvent(state, { type: "delta", partId: 2, text: "因为缓存键" });
  state = foldChatEvent(state, {
    type: "part-completed",
    partId: 2,
    content: { type: "text", text: "因为缓存键" },
  });
  state = foldChatEvent(state, { type: "usage", usage: { inputTokens: 10 } });
  state = foldChatEvent(state, {
    type: "completed",
    response: {
      assistant: { parts: [{ type: "text", text: "因为缓存键" }] },
      finish: { reason: "stop" },
      usage: { inputTokens: 10, outputTokens: 20 },
      metadata,
    },
  });

  const reply = state.messages.at(-1);
  assert.equal(state.status, "idle");
  assert.equal(reply.state, "done");
  assert.deepEqual(
    reply.parts.map((part) => part.kind),
    ["reasoning", "tool", "text"],
  );
  assert.equal(reply.parts[0].text, "先想一下");
  assert.equal(reply.parts[1].state, "done");
  assert.equal(reply.parts[1].name, "searchCode");
  assert.equal(reply.parts[1].inputText, '{"query":"x"}');
  assert.equal(reply.parts[2].text, "因为缓存键");
  assert.equal(state.usage.outputTokens, 20);
});

test("流中错误：保留已输出内容并标记失败", async (t) => {
  const { createThreadState, appendUserMessage, foldChatEvent } = await loadFold(t);

  let state = createThreadState("t1");
  state = appendUserMessage(state, "hi");
  state = foldChatEvent(state, { type: "started", metadata: { providerName: "p", protocolName: "x", requestedModel: "m" } });
  state = foldChatEvent(state, { type: "part-started", partId: 0, kind: "text" });
  state = foldChatEvent(state, { type: "delta", partId: 0, text: "半截回复" });
  state = foldChatEvent(state, {
    type: "failed",
    error: { kind: "transport", message: "断流" },
  });

  const reply = state.messages.at(-1);
  assert.equal(state.status, "failed");
  assert.equal(state.error.kind, "transport");
  assert.equal(reply.state, "failed");
  assert.equal(reply.parts[0].text, "半截回复");
});

test("工具步骤失败：步骤标记 error，其余部分不受影响", async (t) => {
  const { createThreadState, appendUserMessage, foldChatEvent } = await loadFold(t);

  let state = createThreadState("t1");
  state = appendUserMessage(state, "hi");
  state = foldChatEvent(state, { type: "started", metadata: { providerName: "p", protocolName: "x", requestedModel: "m" } });
  state = foldChatEvent(state, { type: "part-started", partId: 0, kind: "tool-call", name: "searchCode" });
  state = foldChatEvent(state, {
    type: "part-completed",
    partId: 0,
    content: {
      type: "tool-call",
      call: { callId: "c1", name: "searchCode", inputText: "{}", errorText: "503" },
    },
  });
  state = foldChatEvent(state, { type: "part-started", partId: 1, kind: "text" });
  state = foldChatEvent(state, { type: "delta", partId: 1, text: "仍然回答" });

  const reply = state.messages.at(-1);
  assert.equal(reply.parts[0].state, "error");
  assert.equal(reply.parts[0].errorText, "503");
  assert.equal(reply.parts[1].text, "仍然回答");
});

test("停止：进行中的回复保留已输出内容并标记 stopped", async (t) => {
  const { createThreadState, appendUserMessage, foldChatEvent, markStopped } = await loadFold(t);

  let state = createThreadState("t1");
  state = appendUserMessage(state, "hi");
  state = foldChatEvent(state, { type: "started", metadata: { providerName: "p", protocolName: "x", requestedModel: "m" } });
  state = foldChatEvent(state, { type: "part-started", partId: 0, kind: "text" });
  state = foldChatEvent(state, { type: "delta", partId: 0, text: "已输出" });
  state = markStopped(state);

  const reply = state.messages.at(-1);
  assert.equal(state.status, "idle");
  assert.equal(reply.state, "stopped");
  assert.equal(reply.parts[0].text, "已输出");
});
