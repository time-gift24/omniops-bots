import type { WorkspaceAccess } from "@/workspace/access"

const DIRECTORIES = [
  "/workspace/omniops-bots",
  "/workspace/客户支持",
  "/workspace/研发协作",
] as const

export function createDemoWorkspaceAccess(): WorkspaceAccess {
  return {
    async listDirectories() {
      return DIRECTORIES.map((path) => ({
        path,
        name: path.split("/").at(-1)!,
      }))
    },
    async resolveDirectory(path) {
      await new Promise((resolve) => setTimeout(resolve, 200))
      const selected = path.trim().replace(/\/+$/, "")
      if (!DIRECTORIES.some((directory) => directory === selected)) {
        throw new Error("未找到这个演示目录，请从列表选择后重试。")
      }
      return { path: selected, name: selected.split("/").at(-1)! }
    },
  }
}
