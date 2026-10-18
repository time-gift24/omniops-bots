import type { FrontendAdapters } from "@/app/dependencies"
import type { WorkbenchScope } from "@/workbench/backend"
import { createBrowserStorage } from "../browser-storage"
import { RECOMMENDED_SITES } from "../recommendations"
import { safeHttpUrl } from "./attachments"
import { array, boolean, object, string } from "./protocol"
import {
  readAgents,
  readChanges,
  readDirectory,
  readFile,
  readFiles,
  readSkills,
} from "./resources"
import {
  createTauriRuntime,
  type TauriBridge,
  type RunContext,
} from "./runtime"

export async function createTauriAdapters(providedBridge?: TauriBridge) {
  let bridge = providedBridge
  if (!bridge) {
    const [{ invoke }, { listen }] = await Promise.all([
      import("@tauri-apps/api/core"),
      import("@tauri-apps/api/event"),
    ])
    bridge = {
      invoke,
      listen: (name, handler) =>
        listen(name, (event) => handler(event.payload)),
    }
  }
  const runtime = createTauriRuntime(bridge)
  await runtime.initialize()
  const storage = createBrowserStorage("desktop")
  const bindings = new Map<string, Promise<void>>()
  const request = async (method: string, params?: Record<string, unknown>) => {
    try {
      return await runtime.request(method, params)
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "message" in error &&
        typeof error.message === "string"
      )
        throw new Error(error.message, { cause: error })
      throw new Error("桌面操作未能完成，请重试。", { cause: error })
    }
  }
  const bindWorkspace = (scope: WorkbenchScope): Promise<void> => {
    const key = JSON.stringify(scope)
    let pending = bindings.get(key)
    if (!pending) {
      pending = request("workspace_bind", { scope })
        .then(() => {})
        .catch((error) => {
          bindings.delete(key)
          throw error
        })
      bindings.set(key, pending)
    }
    return pending
  }
  const scoped = async (
    method: string,
    scope: WorkbenchScope,
    extra?: Record<string, unknown>
  ) => {
    await bindWorkspace(scope)
    return request(method, { scope, ...extra })
  }
  const host = async (command: string, params: Record<string, unknown>) => {
    try {
      return await bridge.invoke(command, params)
    } catch {
      throw new Error("系统操作未能完成，请重试。")
    }
  }
  const adapters: FrontendAdapters = {
    backendId: "desktop",
    gatewayFor: runtime.gatewayFor,
    desktop: runtime.desktop,
    workbench: {
      listRecommendations: async () => RECOMMENDED_SITES,
      listWorkspaceFiles: async (scope) =>
        readFiles(await request("workspace_files", { scope })),
      readFilePreview: async (scope, path) =>
        readFile(await request("workspace_file", { scope, path })),
      getChangeSet: async (scope) =>
        readChanges(await scoped("workspace_changes", scope)),
    },
    agents: {
      load: async () => readAgents(await request("agents_load")),
      save: async (id, configuration) => {
        await request("agent_save", { id, configuration })
      },
    },
    skills: { list: async () => readSkills(await request("skills_list")) },
    models: {
      list: async () =>
        array(await request("models_list"), (entry) => {
          const raw = object(entry)
          return { id: string(raw.id), label: string(raw.label) }
        }),
    },
    workspaceAccess: {
      listDirectories: async () =>
        array(await request("workspace_directories"), readDirectory),
      resolveDirectory: async (path) =>
        readDirectory(await request("workspace_resolve", { path })),
    },
    skillDrafts: storage.skillDrafts,
    preferences: storage.themePreferences,
    host: {
      copyText: async (text) => {
        await host("host_copy_text", { text })
      },
      openExternal: async (url) => {
        await host("host_open_external", { url: safeHttpUrl(url) })
      },
      confirm: async (message) =>
        boolean(await host("host_confirm", { message })),
    },
  }
  return {
    adapters,
    bindWorkspace,
    setContextResolver(resolver: (threadId: string) => Promise<RunContext>) {
      runtime.setContextResolver(async (threadId) => {
        const context = await resolver(threadId)
        if (!context.agentId) return context
        return {
          ...context,
          instructions: string(
            await request("agent_instructions", { id: context.agentId })
          ),
        }
      })
    },
    dispose: runtime.dispose,
  }
}
