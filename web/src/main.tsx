import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import "./index.css"
import App from "./App.tsx"
import { ThemeProvider } from "@/components/theme-provider.tsx"
import {
  AppDependenciesProvider,
  createAppDependencies,
} from "@/app/dependencies"
import { createDemoAdapters } from "@/adapters/demo"
import { Button } from "@/components/ui/button"
import { loadInitialThemePreferences } from "@/preferences/theme"

const root = createRoot(document.getElementById("root")!)
let disposed = false
let cleanup = () => {}

async function start() {
  root.render(
    <p role="status" className="p-6 text-sm text-muted-foreground">
      正在加载工作区…
    </p>
  )
  try {
    const tauri =
      "__TAURI_INTERNALS__" in window
        ? await (await import("@/adapters/tauri")).createTauriAdapters()
        : undefined
    if (disposed) {
      tauri?.dispose()
      return
    }
    const dependencies = createAppDependencies(
      tauri?.adapters ?? createDemoAdapters()
    )
    let unsubscribeWorkspaces: (() => void) | undefined
    if (tauri) {
      const scopes = () => {
        const state = dependencies.workspaces.getState()
        return state.sessions.flatMap((session) => {
          const workspace = state.workspaces.find(
            (entry) => entry.id === session.workspaceId
          )
          return workspace
            ? [
                {
                  workspaceId: workspace.id,
                  workspacePath: workspace.path,
                  sessionId: session.id,
                },
              ]
            : []
        })
      }
      const bound = new Set<string>()
      const captureBaselines = () => {
        for (const scope of scopes()) {
          const key = JSON.stringify(scope)
          if (bound.has(key)) continue
          bound.add(key)
          // Changes exposes failures and can retry; browser tasks remain available.
          void tauri.bindWorkspace(scope).catch(() => {})
        }
      }
      tauri.setContextResolver(async (threadId) => {
        if (threadId.startsWith("agent-test:"))
          return { agentId: threadId.slice("agent-test:".length) }
        const scope = scopes().find((entry) => entry.sessionId === threadId)
        return scope ? { workspacePath: scope.workspacePath } : {}
      })
      unsubscribeWorkspaces =
        dependencies.workspaces.subscribe(captureBaselines)
      captureBaselines()
    }
    cleanup = () => {
      unsubscribeWorkspaces?.()
      dependencies.workspaces.dispose()
      tauri?.dispose()
    }
    const initialPreferences = await loadInitialThemePreferences(
      dependencies.preferences
    )
    if (disposed) {
      cleanup()
      return
    }
    root.render(
      <StrictMode>
        <AppDependenciesProvider value={dependencies}>
          <ThemeProvider
            preferences={dependencies.preferences}
            initialPreferences={initialPreferences}
          >
            <App />
          </ThemeProvider>
        </AppDependenciesProvider>
      </StrictMode>
    )
  } catch {
    cleanup()
    if (!disposed)
      root.render(
        <div
          role="alert"
          className="grid h-full place-content-center gap-3 px-6 text-center"
        >
          <p className="text-sm">
            桌面服务启动失败，请检查本地运行环境后重试。
          </p>
          <Button variant="outline" onClick={() => void start()}>
            重试启动
          </Button>
        </div>
      )
  }
}
void start()

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    disposed = true
    root.unmount()
    cleanup()
  })
}
