import { fileKey, type SkillDraftCache } from "../skills/drafts.ts"
import {
  isPalette,
  isTheme,
  type ThemePreferences,
} from "../preferences/theme.ts"

type BrowserStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">
type StorageEvents = Pick<Window, "addEventListener" | "removeEventListener">

export function createBrowserStorage(
  backendId: string,
  {
    getStorage = () => window.localStorage,
    events = window,
  }: {
    getStorage?: () => BrowserStorage
    events?: StorageEvents
  } = {}
): { skillDrafts: SkillDraftCache; themePreferences: ThemePreferences } {
  if (!backendId.trim()) throw new Error("backendId must not be empty")
  // 旧键只属于 demo；继续使用同一个键，删除后不会从兼容回退中复活。
  const key = (legacyKey: string) =>
    backendId === "demo"
      ? legacyKey
      : `cognacta:backend:${encodeURIComponent(backendId)}:${legacyKey}`
  const draftKey = (skillId: string, path: string) =>
    key(`cognacta:skill-draft:v1:${fileKey(skillId, path)}`)
  const themeKey = key("theme")
  const paletteKey = key("cognacta-palette")

  return {
    skillDrafts: {
      async load(skills) {
        const storage = getStorage()
        const drafts: Record<string, string> = {}
        for (const skill of skills) {
          for (const file of skill.files) {
            const content = storage.getItem(draftKey(skill.id, file.path))
            if (content !== null) drafts[fileKey(skill.id, file.path)] = content
          }
        }
        return drafts
      },
      async save(skillId, path, content) {
        getStorage().setItem(draftKey(skillId, path), content)
      },
      async remove(skillId, path) {
        getStorage().removeItem(draftKey(skillId, path))
      },
    },
    themePreferences: {
      async readTheme() {
        const value = getStorage().getItem(themeKey)
        return isTheme(value) ? value : null
      },
      async readPalette() {
        const value = getStorage().getItem(paletteKey)
        return isPalette(value) ? value : null
      },
      async writeTheme(theme) {
        getStorage().setItem(themeKey, theme)
      },
      async writePalette(palette) {
        getStorage().setItem(paletteKey, palette)
      },
      subscribe(listener) {
        let storage: BrowserStorage
        try {
          storage = getStorage()
        } catch {
          return () => {}
        }
        const changed = (event: StorageEvent) => {
          if (event.storageArea !== storage) return
          if (event.key === null) listener({ theme: null, palette: null })
          else if (event.key === themeKey)
            listener({ theme: isTheme(event.newValue) ? event.newValue : null })
          else if (event.key === paletteKey)
            listener({
              palette: isPalette(event.newValue) ? event.newValue : null,
            })
        }
        events.addEventListener("storage", changed)
        return () => events.removeEventListener("storage", changed)
      },
    },
  }
}
