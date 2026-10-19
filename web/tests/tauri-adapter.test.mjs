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
const snapshot = (tasks, browserThreadId = null) => ({ ...empty(), tasks, browserThreadId })
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
  await runtime.desktop.selectBrowserThread("owner")
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
  const collision = await runtime.gatewayFor("owner").stream(input)[Symbol.asyncIterator]().next()
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
  await runtime.desktop.selectBrowserThread("t")
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

test("thread reservation precedes asynchronous input preparation, and unsubscribing does not stop a task", async t => {
  const { createTauriRuntime } = await load(t)
  const context = deferred()
  const host = bridge((_command, args) => args.method === "chat_start" ? { runId: args.params.runId } : {})
  const runtime = createTauriRuntime(host)
  await runtime.initialize()
  await runtime.desktop.selectBrowserThread("a")
  runtime.setContextResolver(() => context.promise)
  const first = runtime.gatewayFor("a"), second = runtime.gatewayFor("a")
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

test("concurrent preparations retain each thread through snapshots and cancelling one leaves the other runnable", async t => {
  const { createTauriRuntime } = await load(t)
  const preparation = new Map([["a", deferred()], ["b", deferred()]])
  const accepted = new Map()
  const host = bridge((command, args) => {
    if (command === "runtime_prepare_run") return preparation.get(args.threadId).promise
    if (args.method === "chat_start") {
      const run = args.params
      accepted.set(run.threadId, run)
      host.emit({ event: "chat_event", runId: run.runId, threadId: run.threadId, data: { type: "started", metadata } })
      return { runId: run.runId }
    }
  })
  const runtime = createTauriRuntime(host)
  await runtime.initialize()
  await runtime.desktop.selectBrowserThread("b")
  const first = runtime.gatewayFor("a"), second = runtime.gatewayFor("b")
  const a = first.stream(input)[Symbol.asyncIterator](), b = second.stream(input)[Symbol.asyncIterator]()
  const firstEvent = a.next(), secondEvent = b.next()
  const preparing = runtime.desktop.getState().tasks
  assert.deepEqual(preparing.map(task => [task.threadId, task.phase]), [["a", "preparing"], ["b", "preparing"]])
  assert.deepEqual(host.calls.filter(([command]) => command === "runtime_prepare_run").map(([, args]) => args.threadId), ["a", "b"])
  const collision = await runtime.gatewayFor("a").stream(input)[Symbol.asyncIterator]().next()
  assert.equal(collision.value.error.kind, "invalid-request")
  host.emit({ event: "desktop_state", state: snapshot([], "b") })
  assert.equal(runtime.desktop.getState().tasks.length, 2, "queued empty snapshot cannot erase either local preparation")
  assert.equal(runtime.desktop.getState().task.threadId, "b")
  await assert.rejects(runtime.desktop.navigate("https://example.com"), /等待/)
  await runtime.desktop.selectBrowserThread(null)
  await runtime.desktop.navigate("https://example.com")
  assert.equal(runtime.desktop.getState().task, null, "the manual page is independent from preparing tasks")
  const stopped = first.abort()
  assert.equal(runtime.desktop.getState().tasks.find(task => task.threadId === "a").phase, "stopping")
  preparation.get("a").resolve()
  await stopped
  assert.equal((await firstEvent).value.error.kind, "aborted")
  assert.equal((await a.next()).done, true)
  assert.deepEqual(runtime.desktop.getState().tasks.map(task => task.threadId), ["b"])
  preparation.get("b").resolve()
  assert.equal((await secondEvent).value.type, "started")
  assert.equal(accepted.has("a"), false)
  assert.equal(accepted.has("b"), true)
  const run = accepted.get("b")
  host.emit({ event: "chat_event", runId: run.runId, threadId: "a", data: completed("wrong thread") })
  assert.equal(runtime.desktop.getState().tasks.length, 1, "event identity includes both run and thread")
  host.emit({ event: "chat_event", runId: run.runId, threadId: "b", data: completed("finished b") })
  assert.equal((await b.next()).value.response.assistant.parts[0].text, "finished b")
  assert.equal((await b.next()).done, true)
  host.emit({ event: "desktop_state", state: snapshot(preparing, "b") })
  assert.deepEqual(runtime.desktop.getState().tasks, [], "late snapshots cannot resurrect runs after their streams have been removed")
})

test("concurrent stops retain separate acknowledgements and terminal events clear only their own task", async t => {
  const { createTauriRuntime } = await load(t)
  const accepted = new Map(), cleanup = new Map(), stopCounts = new Map()
  const host = bridge((_command, args) => {
    if (args.method === "chat_start") {
      const run = args.params
      accepted.set(run.threadId, run)
      cleanup.set(run.runId, deferred())
      host.emit({ event: "chat_event", runId: run.runId, threadId: run.threadId, data: { type: "started", metadata } })
      return { runId: run.runId }
    }
    if (args.method === "stop") {
      stopCounts.set(args.params.runId, (stopCounts.get(args.params.runId) ?? 0) + 1)
      return cleanup.get(args.params.runId).promise
    }
  })
  const runtime = createTauriRuntime(host)
  await runtime.initialize()
  await runtime.desktop.selectBrowserThread("b")
  const a = runtime.gatewayFor("a"), b = runtime.gatewayFor("b")
  const streams = [a.stream(input)[Symbol.asyncIterator](), b.stream(input)[Symbol.asyncIterator]()]
  await Promise.all(streams.map(stream => stream.next()))
  const stoppingA = a.abort(), stoppingB = b.abort()
  assert.equal(a.abort(), stoppingA)
  assert.equal(b.abort(), stoppingB)
  await tick()
  const before = runtime.desktop.getState().tasks
  assert.deepEqual(before.map(task => task.phase), ["stopping", "stopping"])
  for (const run of accepted.values()) host.emit({ event: "chat_event", runId: run.runId, threadId: run.threadId, data: { type: "failed", error: { kind: "aborted", message: "stopped" } } })
  host.emit({ event: "desktop_state", state: snapshot([], "b") })
  assert.equal(runtime.desktop.getState().tasks.length, 2, "each terminal event still needs its own stop acknowledgement")
  cleanup.get(accepted.get("a").runId).resolve({ stopped: true })
  await stoppingA
  assert.deepEqual(runtime.desktop.getState().tasks.map(task => task.threadId), ["b"])
  assert.equal(runtime.desktop.getState().task.phase, "stopping")
  host.emit({ event: "desktop_state", state: snapshot(before, "b") })
  assert.deepEqual(runtime.desktop.getState().tasks.map(task => task.threadId), ["b"])
  cleanup.get(accepted.get("b").runId).resolve({ stopped: true })
  await stoppingB
  assert.deepEqual([...stopCounts.values()], [1, 1])
  assert.deepEqual(runtime.desktop.getState().tasks, [])
  for (const stream of streams) { assert.equal((await stream.next()).value.error.kind, "aborted"); assert.equal((await stream.next()).done, true) }
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
  assert.deepEqual(host.calls.at(-1)[1].bounds, { x: 5, y: 6, width: 500, height: 600, pageId: "__manual__", visible: true, interactive: false })
  await runtime.desktop.setBrowserViewport(null)
  assert.equal(host.calls.at(-1)[1].bounds.visible, false)
  assert.equal(host.calls.some(([, args]) => args?.method === "stop"), false)
})

test("browser selection resends unchanged viewport bounds with the selected page identity", async t => {
  const { createTauriRuntime } = await load(t)
  const pending = deferred()
  let writes = 0
  const host = bridge(command => command === "browser_set_bounds" && writes++ === 0 ? pending.promise : {})
  const runtime = createTauriRuntime(host)
  await runtime.initialize()
  const bounds = { x: 5, y: 6, width: 500, height: 600, interactive: false }
  const initial = runtime.desktop.setBrowserViewport(bounds)
  await runtime.desktop.selectBrowserThread("a")
  await runtime.desktop.selectBrowserThread("b")
  pending.resolve({})
  await initial
  const sent = host.calls.filter(([command]) => command === "browser_set_bounds")
  assert.deepEqual(sent.map(([, args]) => args.bounds.pageId), ["__manual__", "b"])
  assert.deepEqual(sent.at(-1)[1].bounds, { ...bounds, pageId: "b", visible: true })
  assert.equal(runtime.desktop.getState().browserThreadId, "b")
  await runtime.desktop.selectBrowserThread(null)
  await tick()
  assert.equal(host.calls.at(-1)[1].bounds.pageId, "__manual__")
})

test("navigation captures its page identity and an outstanding page does not block another page", async t => {
  const { createTauriRuntime } = await load(t)
  const waiting = deferred()
  const host = bridge((_command, args) => args.method === "navigate" && args.params.threadId === "a" ? waiting.promise : {})
  const runtime = createTauriRuntime(host)
  await runtime.initialize()
  await runtime.desktop.selectBrowserThread("a")
  const first = runtime.desktop.navigate("https://example.com/a")
  await runtime.desktop.selectBrowserThread("b")
  await runtime.desktop.navigate("https://example.com/b")
  assert.deepEqual(host.calls.filter(([, args]) => args?.method === "navigate").map(([, args]) => args.params.threadId), ["a", "b"])
  await runtime.desktop.selectBrowserThread("a")
  await assert.rejects(runtime.desktop.reload(), /等待/)
  waiting.resolve({ navigated: true })
  await first
  await runtime.desktop.reload()
  assert.deepEqual(host.calls.filter(([, args]) => args?.method === "reload").at(-1)[1].params, { threadId: "a" })
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

test("native preparation gate precedes context and cancellation releases it without starting a model", async t => {
  const { createTauriRuntime } = await load(t)
  const preparation = deferred()
  let contextCalls = 0
  const host = bridge((command) => command === "runtime_prepare_run" ? preparation.promise : null)
  const runtime = createTauriRuntime(host)
  await runtime.initialize()
  await runtime.desktop.selectBrowserThread("preparing")
  runtime.setContextResolver(async () => { contextCalls++; return {} })
  const gateway = runtime.gatewayFor("preparing")
  const iterator = gateway.stream(input)[Symbol.asyncIterator]()
  const first = iterator.next()
  assert.equal(runtime.desktop.getState().task.phase, "preparing")
  assert.equal(contextCalls, 0)
  host.emit({ event: "exit_blocked" })
  assert.equal(runtime.desktop.getState().closeBlocked, true)
  const stopped = gateway.abort()
  preparation.resolve(null)
  await stopped
  assert.equal((await first).value.error.kind, "aborted")
  assert.equal(host.calls.filter(([command]) => command === "runtime_release_run").length, 1)
  assert.equal(runtime.desktop.getState().closeBlocked, false, "exit warning clears when the task stops")
  assert.equal(host.calls.some(([, args]) => args?.method === "chat_start"), false)
  assert.equal(runtime.desktop.getState().task, null)
})

test("failed native preparation gate exposes the failure, skips inputs and releases its reservation", async t => {
  const { createTauriRuntime } = await load(t)
  let contextCalls = 0
  const host = bridge(command => { if (command === "runtime_prepare_run") throw new Error("应用正在退出，请重新打开。") })
  const runtime = createTauriRuntime(host)
  await runtime.initialize()
  runtime.setContextResolver(async () => { contextCalls++; return {} })
  const events = []
  for await (const event of runtime.gatewayFor("closing").stream(input)) events.push(event)
  assert.match(events[0].error.message, /退出/)
  assert.equal(contextCalls, 0)
  await tick()
  assert.equal(host.calls.filter(([command]) => command === "runtime_release_run").length, 1)
  assert.equal(runtime.desktop.getState().task, null)
})

test("durable native sessions reject in-place retries but accept a manual next turn after failure", async t => {
  const { createTauriRuntime, ThreadStoreImpl } = await load(t)
  const requests = []
  const host = bridge((_command, args) => {
    if (args.method !== "chat_start") return null
    requests.push(args.params)
    const run = args.params
    queueMicrotask(() => {
      host.emit({ event: "chat_event", runId: run.runId, threadId: run.threadId, data: { type: "started", metadata } })
      host.emit({ event: "chat_event", runId: run.runId, threadId: run.threadId, data: requests.length === 1 ? { type: "failed", error: { kind: "unavailable", message: "temporary failure" } } : completed("next turn") })
    })
    return { runId: run.runId }
  })
  const runtime = createTauriRuntime(host)
  await runtime.initialize()
  const store = new ThreadStoreImpl("durable", runtime.gatewayFor("durable"))
  assert.equal(store.appendOnly, true)
  store.send("first")
  await tick()
  const before = store.snapshot()
  store.retry()
  store.retry("m-2")
  await tick()
  assert.equal(requests.length, 1)
  assert.deepEqual(store.snapshot(), before, "retry cannot replace any persisted reply")
  assert.equal(store.send("try again as a new turn"), true)
  await tick()
  assert.equal(requests.length, 2)
  assert.equal(requests[1].threadId, "durable")
  assert.equal(store.getState().messages[1].state, "failed")
  assert.equal(store.getState().messages.at(-1).parts[0].text, "next turn")
})
