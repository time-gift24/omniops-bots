import assert from "node:assert/strict"
import { test } from "node:test"
import { createServer } from "vite"
import { fileURLToPath } from "node:url"

test("publication adapter retains immutable operation and exact history identity across safe DTOs", async t => {
  const vite = await createServer({ root: fileURLToPath(new URL("../", import.meta.url)), configFile: false, resolve: { alias: { "@": fileURLToPath(new URL("../src", import.meta.url)) } }, server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom", optimizeDeps: { noDiscovery: true, include: [] } })
  t.after(() => vite.close())
  const { createTauriPublications, readPublication, readPublicationPreview } = await vite.ssrLoadModule("/src/adapters/tauri/publication.ts")
  const { readSkill } = await vite.ssrLoadModule("/src/adapters/tauri/skills.ts")
  const calls = [], hash = "a".repeat(64), otherHash = "b".repeat(64)
  const preview = { kind: "skill", contentId: hash, baseline: "baseline", expectedContentId: otherHash, affectedAgents: [{ agentId: "agent", expectedContentId: otherHash }] }
  let prepared = { operationId: "operation", kind: "skill", localId: "local", officialId: "official", contentId: hash, phase: "prepared", files: [{ path: "SKILL.md", kind: "file", bytes: 10, sha256: hash }] }
  const source = createTauriPublications(async (method, params) => {
    calls.push([method, params])
    if (method === "resource_prepare") return prepared
    if (method === "resource_upload_draft") return prepared = { ...prepared, phase: "uploaded", draftRevisionId: "revision", revision: "revision", preview, publication: { releaseTag: "v.2.0.0", affectedAgents: [{ ...preview.affectedAgents[0], releaseTag: "v.3.0.0" }] } }
    if (method === "resource_publication_operations") return { items: [prepared] }
    if (method === "resource_publish_preview") return preview
    if (method === "resource_publish") return { ...prepared, phase: "published", release: { releaseId: "release", versions: [{ kind: "skill", id: "official", contentId: hash, releaseTag: params.releaseTag }] } }
    if (method === "resource_versions") return { items: [{ contentId: hash, releaseTag: "v.2.0.0", publishedAt: "2026-10-27T00:00:00Z" }], nextCursor: null }
    if (method === "resource_select_history") return { kind: "skill", officialId: "official", contentId: hash, localId: "copy" }
    throw new Error("Unexpected method")
  })
  assert.equal((await source.prepare({ kind: "skill", id: "local", officialId: "official" })).phase, "prepared")
  assert.equal(calls.some(([method]) => method === "resource_publish"), false)
  assert.equal((await source.uploadDraft("operation")).draftRevisionId, "revision")
  assert.deepEqual((await source.listOperations()).items[0].publication, prepared.publication)
  assert.deepEqual(await source.preview("operation"), preview)
  const submission = { operationId: "operation", ...prepared.publication }
  await source.publish(submission); await source.publish(submission)
  assert.deepEqual(calls.filter(([method]) => method === "resource_publish").map(([, input]) => input), [submission, submission])
  assert.equal((await source.versions({ kind: "skill", id: "official" })).items[0].contentId, hash)
  assert.equal((await source.selectHistory({ kind: "skill", id: "official", contentId: hash, editable: true })).localId, "copy")
  assert.throws(() => readPublication({ ...prepared, contentId: "bad" }))
  assert.throws(() => readPublicationPreview({ ...preview, affectedAgents: [{ agentId: "agent", expectedContentId: null }] }))
  assert.throws(() => readPublication({ ...prepared, preview: { ...preview, contentId: otherHash } }))
  assert.throws(() => readPublication({ ...prepared, phase: "published", release: { releaseId: "wrong", versions: [] } }))
  const officialSkill = readSkill({ id: `official/skill-id/${hash}`, origin: "official", readOnly: true, contentId: hash, name: "fixture", description: "", modifiedAt: null, entries: [] })
  assert.equal(officialSkill.officialId, "skill-id")
  assert.equal(officialSkill.id, `official/skill-id/${hash}`)
})
