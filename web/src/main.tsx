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
import { loadInitialThemePreferences } from "@/preferences/theme"

const dependencies = createAppDependencies(createDemoAdapters())
const initialPreferences = await loadInitialThemePreferences(
  dependencies.preferences
)
const root = createRoot(document.getElementById("root")!)
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

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    root.unmount()
    dependencies.workspaces.dispose()
  })
}
