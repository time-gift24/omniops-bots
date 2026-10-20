import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { test } from "node:test"

const configRoot = new URL("../../crates/omniops-bots-desktop/", import.meta.url)
const readConfig = async (path) =>
  JSON.parse(await readFile(new URL(path, configRoot), "utf8"))

test("macOS places the shared header beneath native window controls", async () => {
  const config = await readConfig("tauri.conf.json")
  const mac = await readConfig("tauri.macos.conf.json")
  assert.equal(mac.app?.windows, undefined)
  const window = config.app.windows[0]
  assert.equal(window.label, "main")
  assert.notEqual(window.decorations, false)
  assert.equal(window.titleBarStyle, "Overlay")
  assert.equal(window.hiddenTitle, true)
  assert.deepEqual(window.trafficLightPosition, { x: 14, y: 26 })
})

test("Windows removes the duplicate native title bar and retains window constraints", async () => {
  const config = await readConfig("tauri.conf.json")
  const windows = await readConfig("tauri.windows.conf.json")
  const { titleBarStyle, hiddenTitle, trafficLightPosition, ...shared } =
    config.app.windows[0]
  assert.deepEqual(windows.app.windows, [{ ...shared, decorations: false }])
})

test("title bar commands are restricted to the main application window", async () => {
  const capability = await readConfig("capabilities/default.json")
  assert.deepEqual(capability.windows, ["main"])
  assert.deepEqual(capability.permissions, [
    "core:default",
    "core:window:allow-start-dragging",
    "core:window:allow-minimize",
    "core:window:allow-toggle-maximize",
    "core:window:allow-close",
  ])
})
