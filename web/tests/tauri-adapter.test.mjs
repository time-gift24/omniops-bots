import assert from "node:assert/strict"
import { test } from "node:test"
import { createServer } from "vite"
import { fileURLToPath } from "node:url"

async function load(t) {
  const server = await createServer({ configFile: false, resolve: { alias: { "@": fileURLToPath(new URL("../src", import.meta.url)) } }, server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom", optimizeDeps: { noDiscovery: true, include: [] } })
  t.after(() => server.close())
  return { ...(await server.ssrLoadModule("/src/adapters/tauri/runtime.ts")), ...(await server.ssrLoadModule("/src/adapters/tauri/attachments.ts")), ...(await server.ssrLoadModule("/src/adapters/tauri/index.ts")), ...(await server.ssrLoadModule("/src/chat/thread-store.ts")) }
}
const deferred = () => Promise.withResolvers()
const tick = () => new Promise(resolve => setTimeout(resolve, 0))
const metadata = { providerName: "test", protocolName: "deepagents", requestedModel: "test-model" }
const empty = () => ({ simulated: false, task: null, browserRequest: 0, browser: { url: "", title: "", status: "empty", canGoBack: false, canGoForward: false } })
const input = { messages: [{ role: "user", text: "browse" }] }
const completed = text => ({ type: "completed", response: { assistant: { parts: [{ type: "text", text }] }, metadata, usage: {}, finish: { reason: "stop" } } })
function bridge(handler = () => null) {
  let listener
  const calls = []
  return {
    calls,
    emit(event) { listener?.(event) },
    async listen(name, callback) { assert.equal(name, "runtime-event"); listener = callback; calls.push(["listen"]); return () => { listener = undefined; calls.push(["unlisten"]) } },
    async invoke(command, args) {
      calls.push([command, args])
      if (command === "runtime_request" && args.method === "status") return empty()
      if (command === "runtime_request" && args.method === "skill_library_info") return { kind: "desktop", root: "/home/test/.omnimind-ops/skills" }
      return handler(command, args)
    },
  }
}

test("events before start acknowledgement are buffered; stop waits for acknowledgement and backend cleanup", async t => {
  const { createTauriRuntime } = await load(t)
  const ack = deferred(), cleaned = deferred()
  let args
  const host = bridge((_command, request) => {
    if (request.method === "chat_start") { args = request.params; host.emit({ event: "chat_event", ...args, data: { type: "started", metadata } }); return ack.promise }
    if (request.method === "stop") return cleaned.promise
  })
  const runtime = createTauriRuntime(host)
  await runtime.initialize()
  const gateway = runtime.gatewayFor("owner")
  const stream = gateway.stream(input)[Symbol.asyncIterator]()
  assert.equal((await stream.next()).value.type, "started")
  assert.equal(host.calls[0][0], "listen")
  const stopping = gateway.abort()
  assert.equal(runtime.desktop.getState().task.phase, "stopping")
  await tick()
  assert.equal(host.calls.some(([, value]) => value?.method === "stop"), false)
  ack.resolve({ runId: args.runId })
  await tick()
  assert.equal(host.calls.filter(([, value]) => value?.method === "stop").length, 1)
  assert.equal(runtime.desktop.getState().task.phase, "stopping")
  host.emit({ event: "desktop_state", state: { ...empty(), task: { runId: args.runId, threadId: "owner", title: "browse", phase: "running" } } })
  assert.equal(runtime.desktop.getState().task.phase, "stopping", "late running snapshot cannot replace stopping")
  host.emit({ event: "chat_event", runId: args.runId, threadId: "owner", data: { type: "failed", error: { kind: "aborted", message: "stopped" } } })
  host.emit({ event: "desktop_state", state: empty() })
  assert.equal(runtime.desktop.getState().task.phase, "stopping", "terminal and null state cannot release the slot before acknowledgement")
  const collision = await runtime.gatewayFor("other").stream(input)[Symbol.asyncIterator]().next()
  assert.equal(collision.value.error.kind, "invalid-request")
  cleaned.resolve({ stopped: true })
  await stopping
  assert.equal((await stream.next()).value.error.kind, "aborted")
  assert.equal((await stream.next()).done, true)
  assert.equal(runtime.desktop.getState().task, null)
})

test("failed stop acknowledgement remains retryable after the stream is terminal", async t => {
  const { createTauriRuntime } = await load(t)
  let run, stops = 0
  const firstStop = deferred()
  const host = bridge((_command, args) => {
    if (args.method === "chat_start") { run = args.params; host.emit({ event: "chat_event", runId: run.runId, threadId: run.threadId, data: { type: "started", metadata } }); return { runId: run.runId } }
    if (args.method === "stop") return stops++ === 0 ? firstStop.promise : { stopped: true }
  })
  const runtime = createTauriRuntime(host)
  await runtime.initialize()
  const gateway = runtime.gatewayFor("t")
  const iterator = gateway.stream(input)[Symbol.asyncIterator]()
  await iterator.next()
  const stopping = gateway.abort()
  await tick()
  host.emit({ event: "chat_event", runId: run.runId, threadId: "t", data: { type: "failed", error: { kind: "aborted", message: "stopped" } } })
  await iterator.next()
  await iterator.next()
  firstStop.reject(new Error("ack failed"))
  await assert.rejects(stopping)
  assert.equal(runtime.desktop.getState().task.runId, run.runId)
  await gateway.abort()
  assert.equal(stops, 2)
  assert.equal(runtime.desktop.getState().task, null)
})

test("one slot is acquired before asynchronous input preparation, and unsubscribing does not stop a task", async t => {
  const { createTauriRuntime } = await load(t)
  const context = deferred()
  const host = bridge((_command, args) => args.method === "chat_start" ? { runId: args.params.runId } : {})
  const runtime = createTauriRuntime(host)
  await runtime.initialize()
  runtime.setContextResolver(() => context.promise)
  const first = runtime.gatewayFor("a"), second = runtime.gatewayFor("b")
  const iterator = first.stream(input)[Symbol.asyncIterator]()
  const firstEvent = iterator.next()
  const unsubscribe = runtime.desktop.subscribe(() => {})
  unsubscribe()
  const collision = await second.stream(input)[Symbol.asyncIterator]().next()
  assert.equal(collision.value.error.kind, "invalid-request")
  assert.equal(runtime.desktop.getState().task.threadId, "a")
  const stopped = first.abort()
  context.resolve({})
  await stopped
  assert.equal((await firstEvent).value.error.kind, "aborted")
  assert.equal(host.calls.some(([, args]) => args?.method === "chat_start"), false)
})

test("approval submission locks synchronously, failed stale submission cannot replace newer approval", async t => {
  const { createTauriRuntime } = await load(t)
  const submitted = deferred()
  const host = bridge((_command, args) => args.method === "decide" ? submitted.promise : {})
  const runtime = createTauriRuntime(host)
  await runtime.initialize()
  const approval = id => ({ id, callId: id, title: "Inspect", description: "Read page", toolName: "inspect_browser", parameters: "{}" })
  const state = { ...empty(), task: { runId: "r", threadId: "t", phase: "awaiting-approval", title: "Browse", approval: approval("one") } }
  host.emit({ event: "desktop_state", state })
  const deciding = runtime.desktop.decide({ runId: "r", approvalId: "one", decision: "reject", reason: "try another page" })
  await assert.rejects(runtime.desktop.decide({ runId: "r", approvalId: "one", decision: "approve" }), /已更新/)
  host.emit({ event: "desktop_state", state: { ...state, task: { ...state.task, approval: approval("two") } } })
  submitted.reject(new Error("lost acknowledgement"))
  await assert.rejects(deciding, /内容已保留/)
  assert.equal(runtime.desktop.getState().task.approval.id, "two")
  assert.equal(runtime.desktop.getState().task.phase, "awaiting-approval")
})

test("runtime exit and IPC failures settle active streams and do not leak the task slot", async t => {
  const { createTauriRuntime } = await load(t)
  for (const mode of ["exit", "invoke", "malformed", "structured"]) {
    let run
    const host = bridge((_command, args) => {
      if (args.method === "chat_start") {
        run = args.params
        if (mode === "invoke") throw new Error("private transport details")
        if (mode === "structured") throw { kind: "unavailable", message: "请配置本地模型后重启。" }
        return { runId: run.runId }
      }
    })
    const runtime = createTauriRuntime(host)
    await runtime.initialize()
    const iterator = runtime.gatewayFor("a").stream(input)[Symbol.asyncIterator]()
    const result = iterator.next()
    await tick()
    if (mode === "exit") host.emit({ event: "runtime_exit", error: "private process details" })
    if (mode === "malformed") host.emit({ event: "chat_event", runId: run.runId, threadId: "a", data: { type: "delta", partId: -1, text: "bad" } })
    const terminal = (await result).value
    assert.equal(terminal.type, "failed")
    if (mode === "structured") assert.deepEqual(terminal.error, { kind: "unavailable", message: "请配置本地模型后重启。" })
    assert.equal((await iterator.next()).done, true)
    assert.equal(runtime.desktop.getState().task, null)
  }
})

test("file attachments preserve bytes, URLs are validated, and model/history/instructions reach chat_start", async t => {
  const { createTauriRuntime, serializeRequest } = await load(t)
  const request = { ...input, model: "selected", instructions: "user instructions", history: [{ role: "assistant", text: "past" }], messages: [{ role: "user", text: "browse", attachments: [{ name: "input.txt", mediaType: "text/plain", file: new File(["你好"], "input.txt", { type: "text/plain" }) }] }] }
  const serialized = await serializeRequest(request)
  assert.equal(Buffer.from(serialized.messages[0].attachments[0].data, "base64").toString("utf8"), "你好")
  assert.equal("file" in serialized.messages[0].attachments[0], false)
  for (const attachment of [
    { name: "secret", mediaType: "image/png", url: "https://user:password@example.com/secret.png" },
    { name: "local", mediaType: "image/png", url: "file:///secret.png" },
    { name: "binary", mediaType: "application/octet-stream", file: new File(["a"], "binary") },
    { name: "large", mediaType: "text/plain", file: new File([new Uint8Array(8 * 1024 * 1024 + 1)], "large") },
  ]) await assert.rejects(serializeRequest({ messages: [{ role: "user", text: "x", attachments: [attachment] }] }))
  let received
  const host = bridge((_command, args) => {
    if (args.method === "chat_start") { received = args.params; host.emit({ event: "chat_event", runId: received.runId, threadId: received.threadId, data: completed("done") }); return { runId: received.runId } }
  })
  const runtime = createTauriRuntime(host)
  await runtime.initialize()
  runtime.setContextResolver(async () => ({ agentId: "saved-agent", workspacePath: "/work", instructions: "saved instructions" }))
  for await (const _event of runtime.gatewayFor("agent-test:saved-agent").stream(request)) { /* drain */ }
  assert.equal(received.agentId, "saved-agent")
  assert.equal(received.workspacePath, "/work")
  assert.equal(received.request.model, "selected")
  assert.equal(received.request.instructions, "saved instructions\n\nuser instructions")
  assert.deepEqual(received.request.history, request.history)
})

test("native viewport writes coalesce while pending and hiding never stops a task", async t => {
  const { createTauriRuntime } = await load(t)
  const pending = deferred()
  let writes = 0
  const host = bridge(command => command === "browser_set_bounds" && writes++ === 0 ? pending.promise : {})
  const runtime = createTauriRuntime(host)
  const first = runtime.desktop.setBrowserViewport({ x: 1, y: 2, width: 300, height: 400, interactive: true })
  void runtime.desktop.setBrowserViewport(null)
  void runtime.desktop.setBrowserViewport({ x: 5, y: 6, width: 500, height: 600, interactive: false })
  pending.resolve({})
  await first
  assert.equal(host.calls.length, 2)
  assert.deepEqual(host.calls.at(-1)[1].bounds, { x: 5, y: 6, width: 500, height: 600, visible: true, interactive: false })
  await runtime.desktop.setBrowserViewport(null)
  assert.equal(host.calls.at(-1)[1].bounds.visible, false)
  assert.equal(host.calls.some(([, args]) => args?.method === "stop"), false)
})

test("workspace binding failure only blocks Changes, can retry, and file operations retain exact scopes", async t => {
  const previousWindow = globalThis.window
  globalThis.window = { localStorage: { getItem() { return null }, setItem() {}, removeItem() {} }, addEventListener() {}, removeEventListener() {} }
  t.after(() => { if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow })
  const { createTauriAdapters } = await load(t)
  let attempts = 0
  const host = bridge((_command, args) => {
    if (args.method === "workspace_bind" && attempts++ === 0) throw { kind: "unavailable", message: "基线过大" }
    if (args.method === "workspace_files") return [{ name: "a", path: "a", size: "1 B" }]
    if (args.method === "workspace_changes") return { fileCount: 0, added: 0, removed: 0, files: [] }
    return null
  })
  const runtime = await createTauriAdapters(host)
  const scope = { workspaceId: "w", workspacePath: "/actual/path", sessionId: "s" }
  await assert.rejects(runtime.bindWorkspace(scope), /基线过大/)
  assert.equal((await runtime.adapters.workbench.listWorkspaceFiles(scope))[0].path, "a")
  assert.equal((await runtime.adapters.workbench.getChangeSet(scope)).fileCount, 0)
  assert.equal(attempts, 2)
  assert.deepEqual(host.calls.find(([, args]) => args?.method === "workspace_files")[1].params.scope, scope)
})

test("new sends and historical retry carry exactly preceding conversation without duplicate current input", async t => {
  const { ThreadStoreImpl } = await load(t)
  const requests = []
  const store = new ThreadStoreImpl("thread", { async *stream(request) { requests.push(request); yield { type: "started", metadata }; yield completed(`reply ${request.messages[0].text}`) }, abort() {} })
  store.send("one")
  await tick()
  const firstAssistant = store.getState().messages[1].id
  store.send("two")
  await tick()
  assert.deepEqual(requests[1].history, [{ role: "user", text: "one" }, { role: "assistant", text: "reply one" }])
  store.retry(firstAssistant)
  await tick()
  assert.equal(requests[2].history, undefined)
  assert.equal(requests[2].messages[0].text, "one")
  assert.equal(store.getState().messages[3].parts[0].text, "reply two")
})
