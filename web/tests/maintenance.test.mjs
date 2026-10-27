import assert from "node:assert/strict"
import { test } from "node:test"
import { createServer } from "vite"
import { fileURLToPath } from "node:url"

test("maintenance adapter validates safe projections, keeps consent explicit and separates native updater from runtime IPC", async t => {
  const vite = await createServer({ root: fileURLToPath(new URL("../", import.meta.url)), configFile: false, resolve: { alias: { "@": fileURLToPath(new URL("../src", import.meta.url)) } }, server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom", optimizeDeps: { noDiscovery: true, include: [] } })
  t.after(() => vite.close())
  const { createTauriRuntime } = await vite.ssrLoadModule("/src/adapters/tauri/runtime.ts")
  const { readConnection, readDiagnosticUpload, readDesktopSnapshot, readDiagnosticFilePreview, readSavedDiagnosticPackages } = await vite.ssrLoadModule("/src/adapters/tauri/protocol.ts")
  const { readRun, createRunSource } = await vite.ssrLoadModule("/src/adapters/tauri/runs.ts")
  const listeners = new Map(), calls = []
  const connection = { state: "connected", permissions: ["official-read", "task-call"], destination: "https://platform.example.invalid", account: "operator" }
  const update = { phase: "available", currentVersion: "0.1.0", version: "0.2.0", downloadedBytes: 0 }
  const bundle = { uploadId: "upload", threadId: "thread", packageFile: "/local/diagnostics/upload.zip", bundleSha256: "a".repeat(64), manifest: { schemaVersion: 1 }, preview: { files: [{ path: "thread.json", bytes: 123 }], missing: [], attachments: [], redactionPolicy: "v1" } }
  const receipt = { state: "received", uploadId: "upload", threadId: "thread", bundleSha256: bundle.bundleSha256, diagnosticId: "diagnostic", receivedAt: "2026-10-26T00:00:00Z", incomplete: false, missing: [] }
  const bridge = {
    async listen(event, listener) { listeners.set(event, listener); return () => listeners.delete(event) },
    async invoke(command, args) {
      calls.push([command, args])
      if (command.startsWith("updater_")) return { ...update, phase: command === "updater_download" ? "ready" : command === "updater_install" ? "installing" : update.phase }
      if (args.method === "status") return { simulated: false, connection, tasks: [], task: null, browserRequest: 0, browser: { url: "", title: "", status: "empty", canGoBack: false, canGoForward: false } }
      if (args.method === "diagnostic_threads") return { items: [{ threadId: "thread", title: "巡检", lastUpdated: "2026-10-26T00:00:00Z", checkpointAvailable: true }], nextCursor: null }
      if (args.method === "diagnostic_export") return bundle
      if (args.method === "diagnostic_saved_packages") return [{ ...bundle, createdAt: receipt.receivedAt }]
      if (args.method === "diagnostic_open_package") return bundle
      if (args.method === "diagnostic_preview_file") return { mediaType: "text/plain", text: "[REDACTED]", truncated: false }
      if (args.method === "diagnostic_upload" || args.method === "diagnostic_upload_status") return receipt
      return {}
    },
  }
  const runtime = createTauriRuntime(bridge)
  t.after(() => runtime.dispose())
  await runtime.initialize()
  assert.deepEqual(runtime.desktop.getState().connection, { ...connection, reason: undefined })
  assert.equal(readDesktopSnapshot({ ...runtime.desktop.getState(), diagnosticsOnly: true }).diagnosticsOnly, true)
  const threads = await runtime.desktop.listDiagnosticThreads()
  assert.equal(threads.items[0].threadId, "thread")
  assert.deepEqual(await runtime.desktop.exportDiagnostics("thread"), bundle)
  assert.equal((await runtime.desktop.listDiagnosticPackages())[0].uploadId, bundle.uploadId)
  assert.deepEqual(await runtime.desktop.openDiagnosticPackage(bundle.uploadId), bundle)
  assert.deepEqual(await runtime.desktop.previewDiagnosticFile(bundle.uploadId, "thread.json"), { mediaType: "text/plain", text: "[REDACTED]", truncated: false })
  assert.equal(calls.some(([, args]) => args?.method === "diagnostic_upload"), false, "preparation never uploads")
  const before = calls.length
  await assert.rejects(runtime.desktop.uploadDiagnostics("upload", false), /同意/)
  assert.equal(calls.length, before)
  assert.deepEqual(await runtime.desktop.uploadDiagnostics("upload", true), receipt)
  assert.deepEqual(await runtime.desktop.diagnosticUploadStatus("upload"), receipt)
  assert.equal((await runtime.desktop.readUpdate()).phase, "available")
  assert.ok(listeners.has("updater-state"))
  listeners.get("updater-state")({ ...update, phase: "downloading", downloadedBytes: 123, totalBytes: 456 })
  assert.equal(runtime.desktop.getState().update.downloadedBytes, 123)
  assert.equal((await runtime.desktop.downloadUpdate()).phase, "ready")
  assert.equal((await runtime.desktop.installUpdate()).phase, "installing")
  assert.equal(calls.some(([command, args]) => command === "runtime_request" && args.method.startsWith("updater_")), false)
  let invalidations = 0
  const unsubscribe = runtime.subscribeRuns(() => invalidations++)
  listeners.get("runtime-event")({ event: "delivery_changed" })
  unsubscribe()
  listeners.get("runtime-event")({ event: "delivery_changed" })
  assert.equal(invalidations, 1)
  assert.throws(() => readConnection({ ...connection, destination: "https://secret@platform.example.invalid/path" }))
  assert.throws(() => readConnection({ ...connection, permissions: ["arbitrary-admin"] }))
  assert.throws(() => readDiagnosticUpload({ ...receipt, bundleSha256: "wrong" }))
  assert.throws(() => readSavedDiagnosticPackages([{ ...bundle, createdAt: "invalid" }]))
  assert.throws(() => readDiagnosticFilePreview({ mediaType: "image/svg+xml", dataUrl: "data:image/svg+xml,<script/>", truncated: false }))
  assert.throws(() => readDiagnosticFilePreview({ mediaType: "image/png", dataUrl: "https://test.invalid/image.png", truncated: false }))
  assert.throws(() => readDiagnosticFilePreview({ mediaType: "text/plain", text: "界".repeat(400000), truncated: false }))
  const remote = readRun({ runId: "run", threadId: "thread", origin: "a2a", title: "远端任务", status: "completed", startedAt: "2026-10-26T00:00:00Z", delivery: { taskId: "task", state: "confirmed", receivedAt: receipt.receivedAt } })
  assert.equal(remote.origin, "a2a")
  assert.equal(remote.delivery.state, "confirmed")
  for (const output of [null, false, 0, { value: [null, false, 0] }]) {
    const record = readRun({ runId: "remote", threadId: "thread", origin: "a2a", title: "远端任务", status: "completed", startedAt: "2026-10-27T00:00:00Z", events: [], output })
    assert.ok(Object.hasOwn(record, "output"))
    assert.deepEqual(record.output, output)
  }
  assert.throws(() => readRun({ ...remote, output: { value: Infinity } }))
  const pinned = createRunSource(async () => [])
  pinned.runs.bindSession("historical-session", { agentId: "official", agentContentId: "b".repeat(64) })
  assert.equal(pinned.contextFor("historical-session").agentContentId, "b".repeat(64))
  assert.throws(() => pinned.runs.bindSession("historical-session", { agentId: "official", agentContentId: "c".repeat(64) }), /新建会话/)
})
