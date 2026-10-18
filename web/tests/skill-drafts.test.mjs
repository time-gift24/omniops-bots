import assert from "node:assert/strict"
import { test } from "node:test"
import { createServer } from "vite"

async function setup(t) {
  const server = await createServer({
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  })
  t.after(() => server.close())
  const drafts = await server.ssrLoadModule("/src/skills/drafts.ts")
  const { DEMO_SKILLS } = await server.ssrLoadModule("/src/skills/data.ts")
  const values = new Map()
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  }
  return { ...drafts, DEMO_SKILLS, storage, values }
}

test("草稿按技能和文件隔离，完整源码与空内容刷新后保留", async (t) => {
  const { fileKey, loadDrafts, saveDraft, DEMO_SKILLS, storage, values } =
    await setup(t)
  assert.deepEqual(loadDrafts(storage, DEMO_SKILLS), {})
  for (const skill of DEMO_SKILLS) {
    for (const file of skill.files)
      saveDraft(storage, skill.id, file.path, file.content)
  }
  saveDraft(storage, DEMO_SKILLS[0].id, "reference/template.md", "")
  const restored = loadDrafts(storage, DEMO_SKILLS)
  for (const skill of DEMO_SKILLS) {
    for (const file of skill.files) {
      const expected = file.path === "reference/template.md" ? "" : file.content
      assert.equal(restored[fileKey(skill.id, file.path)], expected)
    }
  }
  assert.notEqual(fileKey("a/b", "c"), fileKey("a", "b/c"))
  assert.ok(
    [...values.keys()].every((key) =>
      key.startsWith("cognacta:skill-draft:v1:")
    )
  )
})

test("恢复原始内容只删除目标草稿，重新加载回退到原始文件", async (t) => {
  const { fileKey, loadDrafts, saveDraft, removeDraft, DEMO_SKILLS, storage } =
    await setup(t)
  const skill = DEMO_SKILLS[0]
  const file = skill.files[0]
  saveDraft(storage, skill.id, file.path, "修改后的内容")
  saveDraft(storage, skill.id, skill.files[1].path, "保留另一个文件")
  removeDraft(storage, skill.id, file.path)
  const restored = loadDrafts(storage, DEMO_SKILLS)
  assert.equal(
    restored[fileKey(skill.id, file.path)] ?? file.content,
    file.content
  )
  assert.equal(
    restored[fileKey(skill.id, skill.files[1].path)],
    "保留另一个文件"
  )
})

test("存储读取、写入和删除失败均交由界面处理，已有草稿不变", async (t) => {
  const { fileKey, loadDrafts, saveDraft, removeDraft, DEMO_SKILLS, storage } =
    await setup(t)
  const skill = DEMO_SKILLS[0]
  const file = skill.files[0]
  saveDraft(storage, skill.id, file.path, "之前保存的版本")
  const failure = new Error("storage unavailable")
  const fail = () => {
    throw failure
  }
  assert.throws(
    () => loadDrafts({ ...storage, getItem: fail }, DEMO_SKILLS),
    (error) => error === failure
  )
  assert.throws(
    () =>
      saveDraft({ ...storage, setItem: fail }, skill.id, file.path, "新版本"),
    (error) => error === failure
  )
  assert.throws(
    () => removeDraft({ ...storage, removeItem: fail }, skill.id, file.path),
    (error) => error === failure
  )
  assert.equal(
    loadDrafts(storage, DEMO_SKILLS)[fileKey(skill.id, file.path)],
    "之前保存的版本"
  )
})
