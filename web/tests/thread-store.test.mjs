import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "vite";

async function loadModules(t) {
  const server = await createServer({ server: { middlewareMode: true }, appType: "custom" });
  t.after(() => server.close());
  const { ThreadStoreImpl } = await server.ssrLoadModule("/src/chat/thread-store.ts");
  const { createThreadStoreRegistry } = await server.ssrLoadModule("/src/chat/registry.ts");
  const { createMockGateway } = await server.ssrLoadModule("/src/chat/mock-gateway.ts");
  return { ThreadStoreImpl, createThreadStoreRegistry, createMockGateway };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** 等到条件满足或超时。 */
async function waitFor(check, timeoutMs = 3000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("send → 流式完成：状态回到 idle，回复完整", async (t) => {
  const { ThreadStoreImpl, createMockGateway } = await loadModules(t);
  const store = new ThreadStoreImpl("t1", createMockGateway({ delayMs: 1 }));

  store.send("为什么构建这么慢？");
  assert.equal(store.getState().status, "submitted");
  await waitFor(() => store.getState().status === "idle" && !store.streaming);

  const reply = store.getState().messages.at(-1);
  assert.equal(reply.role, "assistant");
  assert.equal(reply.state, "done");
  assert.ok(reply.parts.some((part) => part.kind === "tool"));
  assert.ok(reply.parts.at(-1).text.includes("缓存键"));
});

test("卸载后流继续折叠，重挂载（再次订阅）即见最新状态", async (t) => {
  const { ThreadStoreImpl, createMockGateway } = await loadModules(t);
  const store = new ThreadStoreImpl("t1", createMockGateway({ delayMs: 5 }));

  const seen = [];
  const unsubscribe = store.subscribe(() => seen.push(store.getState()));
  store.send("[slow] 慢一点");
  unsubscribe(); // 界面卸载
  assert.equal(store.listenerCount, 0);

  await waitFor(() => store.getState().status === "idle", 15000);
  const eventsDuringUnmounted = seen.length; // 卸载后不再通知，但状态已折叠
  const reply = store.getState().messages.at(-1);
  assert.equal(reply.state, "done");
  assert.ok(eventsDuringUnmounted > 0);

  // 重挂载：同步拿到包含全部内容的状态
  let latest = null;
  store.subscribe(() => { latest = store.getState(); });
  latest = store.getState();
  assert.equal(latest.messages.at(-1).state, "done");
});

test("stop 保留已输出内容；流式中的线程不被驱逐", async (t) => {
  const { createThreadStoreRegistry, createMockGateway } = await loadModules(t);
  const registry = createThreadStoreRegistry(() => createMockGateway({ delayMs: 20 }));
  const store = registry.acquire("t1");

  store.send("[slow] 长回复");
  await waitFor(() => store.getState().messages.at(-1)?.role === "assistant" &&
    store.getState().messages.at(-1).parts.some((p) => p.kind === "text" && p.text.length > 0));

  registry.release("t1");
  registry.evictIdle(); // 流式中：不可驱逐
  assert.ok(registry.snapshot("t1"), "streaming store must survive eviction");

  store.stop();
  const reply = store.getState().messages.at(-1);
  assert.equal(reply.state, "stopped");
  assert.ok(reply.parts.some((p) => p.kind === "text" && p.text.length > 0));

  // 结束后且无订阅：可被驱逐
  registry.evictIdle();
  assert.equal(registry.snapshot("t1"), undefined);
});

test("发送失败：状态 failed 且 retry 重发同一输入", async (t) => {
  const { createThreadStoreRegistry, createMockGateway } = await loadModules(t);
  const registry = createThreadStoreRegistry(() => createMockGateway({ delayMs: 1 }));
  const store = registry.acquire("t1");

  store.send("[fail-send] 会失败");
  await waitFor(() => store.getState().status === "failed");
  assert.equal(store.getState().error.kind, "transport");

  store.retry();
  await waitFor(() => store.getState().status === "failed");
  // mock 对同一文本仍失败，但重试确实重新发起了一轮（消息数不变、状态再次流转）
  assert.equal(store.getState().messages.filter((m) => m.role === "user").length, 1);
  await flush();
});

test("snapshot 可 JSON 序列化", async (t) => {
  const { ThreadStoreImpl, createMockGateway } = await loadModules(t);
  const store = new ThreadStoreImpl("t1", createMockGateway({ delayMs: 1 }));
  store.send("hi");
  await waitFor(() => store.getState().status === "idle");
  const snapshot = store.snapshot();
  assert.equal(snapshot.version, 1);
  assert.doesNotThrow(() => JSON.stringify(snapshot));
});
