import type { Skill } from "./data.ts"

export type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">

export function fileKey(skillId: string, path: string): string {
  return JSON.stringify([skillId, path])
}

function storageKey(skillId: string, path: string): string {
  return `cognacta:skill-draft:v1:${fileKey(skillId, path)}`
}

export function loadDrafts(
  storage: DraftStorage,
  skills: readonly Skill[]
): Record<string, string> {
  const drafts: Record<string, string> = {}
  for (const skill of skills) {
    for (const file of skill.files) {
      const content = storage.getItem(storageKey(skill.id, file.path))
      if (content !== null) drafts[fileKey(skill.id, file.path)] = content
    }
  }
  return drafts
}

export function saveDraft(
  storage: DraftStorage,
  skillId: string,
  path: string,
  content: string
): void {
  storage.setItem(storageKey(skillId, path), content)
}

export function removeDraft(
  storage: DraftStorage,
  skillId: string,
  path: string
): void {
  storage.removeItem(storageKey(skillId, path))
}
