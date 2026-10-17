import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "vite";

const metadata = { providerName: "test", protocolName: "test", requestedModel: "test" };
const completed = {
  type: "completed",
  response: { assistant: { parts: [{ type: "text", text: "answer" }] }, finish: { reason: "stop" }, usage: {}, metadata },
};
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function setup(t, gatewayFor = () => ({
  abort() {},
  async *stream() { yield { type: "started", metadata }; yield completed; },
})) {
  const server = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom", optimizeDeps: { noDiscovery: true, include: [] } });
  t.after(() => server.close());
  const { createThreadStoreRegistry } = await server.ssrLoadModule("/src/chat/registry.ts");
  const { createWorkspaceStore } = await server.ssrLoadModule("/src/workspace/store.ts");
  const registry = createThreadStoreRegistry(gatewayFor);
  const store = createWorkspaceStore(registry);
  t.after(() => store.dispose());
  return { store, registry };
}

test("目录规范化去重；无效路径不改变工作区和选择", async (t) => {
  const { store } = await setup(t);
  assert.deepEqual(store.getState().workspaces, []);
  assert.deepEqual(store.getState().sessions, []);
  assert.equal(store.startSession(), null);
  const workspace = store.addWorkspace(" /Users/me//Projects/old/../cognacta/./ ");
  assert.equal(workspace.path, "/Users/me/Projects/cognacta");
  assert.equal(workspace.name, "cognacta");
  assert.equal(store.addWorkspace("/Users/me/Projects/cognacta"), workspace);
  assert.equal(store.getState().workspaces.length, 1);
  assert.equal(store.getState().activeSessionId, null);
  const before = store.getState();
  for (const path of ["", "   ", "./project", "~/project", "file:///project", "/a\nb", "/a\0b"]) {
    assert.throws(() => store.addWorkspace(path), /绝对目录路径/);
    assert.equal(store.getState(), before);
  }
  assert.equal(store.addWorkspace("/../../").path, "/");
});

test("新会话按指定、当前、最近工作区选择，同组空会话同步复用并展开", async (t) => {
  const { store, registry } = await setup(t);
  const first = store.addWorkspace("/projects/first");
  const second = store.addWorkspace("/projects/second");
  const recentId = store.startSession();
  assert.equal(store.getState().sessions[0].workspaceId, second.id);
  assert.equal(store.startSession(), recentId);
  assert.equal(store.startSession(second.id), recentId);
  assert.equal(store.getState().sessions.length, 1);

  const firstId = store.startSession(first.id);
  store.addWorkspace("/projects/latest");
  assert.equal(store.startSession(), firstId, "当前会话优先于最近添加工作区");
  store.toggleWorkspace(first.id);
  assert.ok(!store.getState().expandedWorkspaceIds.includes(first.id));
  store.selectSession(firstId);
  assert.ok(store.getState().expandedWorkspaceIds.includes(first.id));
  assert.equal(store.getState().activeSessionId, firstId);
  assert.equal(store.getState().recentWorkspaceId, first.id);

  registry.get(firstId).send("开始第一轮");
  const nextId = store.startSession();
  assert.notEqual(nextId, firstId);
  for (let click = 0; click < 12; click += 1) assert.equal(store.startSession(), nextId);
  assert.equal(store.getState().sessions.filter((session) => session.workspaceId === first.id).length, 2);
  store.selectSession(recentId);
  assert.equal(store.startSession(), recentId);
  const before = store.getState();
  assert.equal(store.startSession("missing"), null);
  store.selectSession("missing");
  store.toggleWorkspace("missing");
  assert.equal(store.getState(), before);
  await flush();
});

test("后台生成保留引用，只有回合和状态边界广播，标题为首条用户消息", async (t) => {
  const content = Promise.withResolvers();
  const finish = Promise.withResolvers();
  let aborted = 0;
  let now = 100;
  t.mock.method(Date, "now", () => now);
  t.after(() => { content.resolve(); finish.resolve(); });
  const { store, registry } = await setup(t, () => ({
    abort() { aborted += 1; },
    async *stream() {
      yield { type: "started", metadata };
      yield { type: "part-started", partId: 0, kind: "text" };
      await content.promise;
      yield { type: "delta", partId: 0, text: "ans" };
      yield { type: "delta", partId: 0, text: "wer" };
      yield { type: "usage", usage: { outputTokens: 2 } };
      await finish.promise;
      yield completed;
    },
  }));
  const workspace = store.addWorkspace("/projects/test");
  const id = store.startSession(workspace.id);
  const thread = registry.get(id);
  let notices = 0;
  const unsubscribe = store.subscribe(() => { notices += 1; });
  assert.equal(thread.send("   "), false);
  assert.equal(store.getState().sessions[0].blank, true);
  now = 200;
  thread.send(`第一行\n 第二行 ${"😀".repeat(50)}`);
  const submitted = store.getState().sessions[0];
  assert.equal(submitted.blank, false);
  assert.equal(submitted.status, "submitted");
  assert.equal(submitted.updatedAt, 200);
  assert.ok(submitted.title.startsWith("第一行 第二行 "));
  assert.equal(Array.from(submitted.title).length, 49);
  assert.ok(submitted.title.endsWith("…"));
  now = 300;
  await flush();
  assert.equal(store.getState().sessions[0].status, "streaming");
  assert.equal(store.getState().sessions[0].updatedAt, 200);
  const nextId = store.startSession();
  registry.evictIdle();
  assert.equal(registry.get(id), thread, "侧边栏持有会话，切换后不被驱逐");
  assert.equal(aborted, 0);
  const before = store.getState();
  const beforeNotices = notices;
  content.resolve();
  await flush();
  assert.equal(store.getState(), before);
  assert.equal(notices, beforeNotices, "delta / usage 不广播工作区变化");
  assert.equal(thread.getState().messages.at(-1).parts[0].text, "answer");

  now = 400;
  finish.resolve();
  await flush();
  const done = store.getState().sessions.find((session) => session.id === id);
  assert.equal(done.status, "idle");
  assert.equal(done.updatedAt, 400);
  assert.equal(done.title, submitted.title);
  assert.equal(store.getState().activeSessionId, nextId);
  assert.equal(aborted, 0);
  now = 500;
  thread.send("第二轮使用不同标题");
  assert.equal(store.getState().sessions.find((session) => session.id === id).title, submitted.title);
  await flush();
  unsubscribe();
  store.dispose();
  registry.evictIdle();
  assert.equal(registry.snapshot(id), undefined);
  assert.equal(registry.snapshot(nextId), undefined);
});

test("失败、重试和停止同步到会话状态；dispose 不停止进行中的回复", async (t) => {
  const finish = Promise.withResolvers();
  let attempts = 0;
  let aborted = 0;
  t.after(() => finish.resolve());
  const { store, registry } = await setup(t, () => ({
    abort() { aborted += 1; },
    async *stream() {
      attempts += 1;
      if (attempts === 1) throw new Error("测试失败");
      yield { type: "started", metadata };
      await finish.promise;
      yield completed;
    },
  }));
  const workspace = store.addWorkspace("/project");
  const id = store.startSession(workspace.id);
  const thread = registry.get(id);
  thread.send("保留原始标题");
  await flush();
  assert.equal(store.getState().sessions[0].status, "failed");
  assert.equal(store.getState().sessions[0].blank, false);
  thread.retry();
  assert.equal(store.getState().sessions[0].status, "submitted");
  await flush();
  thread.stop();
  assert.equal(store.getState().sessions[0].status, "idle");
  assert.equal(aborted, 1);
  thread.retry();
  await flush();
  store.dispose();
  registry.evictIdle();
  assert.ok(registry.snapshot(id), "dispose 后仍生成的会话不会被驱逐");
  assert.equal(thread.streaming, true);
  assert.equal(aborted, 1, "释放工作区不调用 stop / abort");
  finish.resolve();
  await flush();
  assert.equal(thread.getState().messages.at(-1).state, "done");
  registry.evictIdle();
  assert.equal(registry.snapshot(id), undefined);
});
