import type { FrontendAdapters } from "@/app/dependencies"
import { createBrowserHost } from "./browser-host"
import { createBrowserStorage } from "./browser-storage"
import { createDemoDesktopRuntime } from "./demo/desktop"
import { createDemoAgentSource, createDemoModelSource } from "./demo/resources"
import { createDemoSkillSource } from "./demo/skills"
import { createMockWorkbenchBackend } from "./demo/workbench"
import { createDemoWorkspaceAccess } from "./demo/workspace"

/** Development entry and tests select implementations here, never in shared UI. */
export function createDemoAdapters(
  overrides: Partial<FrontendAdapters> = {}
): FrontendAdapters {
  const backendId = overrides.backendId ?? "demo"
  const runtime = createDemoDesktopRuntime()
  const storage =
    !overrides.skillDrafts || !overrides.preferences
      ? createBrowserStorage(backendId)
      : undefined
  return {
    backendId,
    gatewayFor: overrides.gatewayFor ?? runtime.gatewayFor,
    desktop: overrides.desktop ?? runtime.desktop,
    workbench: overrides.workbench ?? createMockWorkbenchBackend(),
    agents: overrides.agents ?? createDemoAgentSource(),
    skills: overrides.skills ?? createDemoSkillSource(),
    models: overrides.models ?? createDemoModelSource(),
    workspaceAccess: overrides.workspaceAccess ?? createDemoWorkspaceAccess(),
    skillDrafts: overrides.skillDrafts ?? storage!.skillDrafts,
    preferences: overrides.preferences ?? storage!.themePreferences,
    host: overrides.host ?? createBrowserHost(),
  }
}
