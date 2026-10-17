import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "vite";

async function loadModules(t) {
  const server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
  t.after(() => server.close());
  const binding = await server.ssrLoadModule("/src/chat/binding.ts");
  const { defaultThreadRegistry } = await server.ssrLoadModule("/src/chat/react.ts");
  return { ...binding, defaultThreadRegistry };
}

async function waitFor(check) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > 3000) throw new Error("waitFor timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("默认注册表并发运行的线程独立停止，另一线程继续接收增量", async (t) => {
  const { defaultThreadRegistry: registry } = await loadModules(t);
  const first = registry.acquire("first");
  const second = registry.acquire("second");
  t.after(() => {
    first.stop();
    second.stop();
    registry.release("first");
    registry.release("second");
    registry.evictIdle();
  });

  first.send("first");
  second.send("second");
  await waitFor(() => first.getState().status === "streaming" && second.getState().status === "streaming");
  first.stop();
  await waitFor(() => second.getState().messages.at(-1).parts.some((part) => part.text));
  assert.equal(first.getState().messages.at(-1).state, "stopped");
  assert.equal(second.getState().messages.at(-1).state, "streaming");
  assert.equal(second.streaming, true);
});

test("绑定工厂按线程创建网关，重新取得同一线程复用原实例", async (t) => {
  const { bindChatGateway, defaultThreadRegistry: registry } = await loadModules(t);
  const created = [];
  bindChatGateway((threadId) => {
    created.push(threadId);
    return { abort() {}, stream() { throw new Error("unexpected stream"); } };
  });
  const first = registry.acquire("first");
  assert.equal(registry.acquire("first"), first);
  assert.notEqual(registry.acquire("second"), first);
  assert.deepEqual(created, ["first", "second"]);
});
