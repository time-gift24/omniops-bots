import * as React from "react"

type Theme = "dark" | "light" | "system"
type ResolvedTheme = "dark" | "light"
type Palette = "official" | "claude"

type ThemeProviderProps = {
  children: React.ReactNode
  defaultTheme?: Theme
  storageKey?: string
  paletteStorageKey?: string
  disableTransitionOnChange?: boolean
}

type ThemeProviderState = {
  theme: Theme
  setTheme: (theme: Theme) => void
  palette: Palette
  setPalette: (palette: Palette) => void
}

const COLOR_SCHEME_QUERY = "(prefers-color-scheme: dark)"
const THEME_VALUES: Theme[] = ["dark", "light", "system"]

const ThemeProviderContext = React.createContext<
  ThemeProviderState | undefined
>(undefined)

function isTheme(value: string | null): value is Theme {
  if (value === null) {
    return false
  }

  return THEME_VALUES.includes(value as Theme)
}

function isPalette(value: string | null): value is Palette {
  return value === "official" || value === "claude"
}

function getSystemTheme(): ResolvedTheme {
  if (window.matchMedia(COLOR_SCHEME_QUERY).matches) {
    return "dark"
  }

  return "light"
}

function disableTransitionsTemporarily() {
  const style = document.createElement("style")
  style.appendChild(
    document.createTextNode(
      "*,*::before,*::after{-webkit-transition:none!important;transition:none!important}"
    )
  )
  document.head.appendChild(style)

  return () => {
    window.getComputedStyle(document.body)
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        style.remove()
      })
    })
  }
}

function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false
  }

  if (target.isContentEditable) {
    return true
  }

  const editableParent = target.closest(
    "input, textarea, select, [contenteditable='true']"
  )
  if (editableParent) {
    return true
  }

  return false
}

export function ThemeProvider({
  children,
  defaultTheme = "system",
  storageKey = "theme",
  paletteStorageKey = "cognacta-palette",
  disableTransitionOnChange = true,
  ...props
}: ThemeProviderProps) {
  const [theme, setThemeState] = React.useState<Theme>(() => {
    try {
      const storedTheme = localStorage.getItem(storageKey)
      if (isTheme(storedTheme)) return storedTheme
    } catch {
      // Storage can be unavailable; the in-memory theme still works.
    }

    return defaultTheme
  })
  const [palette, setPaletteState] = React.useState<Palette>(() => {
    try {
      const storedPalette = localStorage.getItem(paletteStorageKey)
      if (isPalette(storedPalette)) return storedPalette
    } catch {
      // Storage can be unavailable; the in-memory palette still works.
    }

    return "official"
  })

  const setTheme = React.useCallback(
    (nextTheme: Theme) => {
      try {
        localStorage.setItem(storageKey, nextTheme)
      } catch {
        // Persistence must not prevent a theme change.
      }
      setThemeState(nextTheme)
    },
    [storageKey]
  )

  const setPalette = React.useCallback(
    (nextPalette: Palette) => {
      try {
        localStorage.setItem(paletteStorageKey, nextPalette)
      } catch {
        // Persistence must not prevent a palette change.
      }
      setPaletteState(nextPalette)
    },
    [paletteStorageKey]
  )

  const applyTheme = React.useCallback(
    (nextTheme: Theme, nextPalette: Palette) => {
      const root = document.documentElement
      const resolvedTheme =
        nextTheme === "system" ? getSystemTheme() : nextTheme
      const restoreTransitions = disableTransitionOnChange
        ? disableTransitionsTemporarily()
        : null

      root.classList.remove("light", "dark")
      root.classList.add(resolvedTheme)
      root.style.colorScheme = resolvedTheme
      root.dataset.palette = nextPalette

      if (restoreTransitions) {
        restoreTransitions()
      }
    },
    [disableTransitionOnChange]
  )

  React.useEffect(() => {
    applyTheme(theme, palette)

    if (theme !== "system") {
      return undefined
    }

    const mediaQuery = window.matchMedia(COLOR_SCHEME_QUERY)
    const handleChange = () => {
      applyTheme("system", palette)
    }

    mediaQuery.addEventListener("change", handleChange)

    return () => {
      mediaQuery.removeEventListener("change", handleChange)
    }
  }, [theme, palette, applyTheme])

  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) {
        return
      }

      if (event.metaKey || event.ctrlKey || event.altKey) {
        return
      }

      if (isEditableTarget(event.target)) {
        return
      }

      if (event.key.toLowerCase() !== "d") {
        return
      }

      const nextTheme =
        theme === "dark"
          ? "light"
          : theme === "light"
            ? "dark"
            : getSystemTheme() === "dark"
              ? "light"
              : "dark"
      setTheme(nextTheme)
    }

    window.addEventListener("keydown", handleKeyDown)

    return () => {
      window.removeEventListener("keydown", handleKeyDown)
    }
  }, [theme, setTheme])

  React.useEffect(() => {
    let storage: Storage
    try {
      storage = window.localStorage
    } catch {
      return
    }
    const handleStorageChange = (event: StorageEvent) => {
      if (event.storageArea !== storage) {
        return
      }

      if (event.key === null) {
        setThemeState(defaultTheme)
        setPaletteState("official")
        return
      }

      if (event.key === storageKey) {
        setThemeState(isTheme(event.newValue) ? event.newValue : defaultTheme)
      }

      if (event.key === paletteStorageKey) {
        setPaletteState(isPalette(event.newValue) ? event.newValue : "official")
      }
    }

    window.addEventListener("storage", handleStorageChange)

    return () => {
      window.removeEventListener("storage", handleStorageChange)
    }
  }, [defaultTheme, storageKey, paletteStorageKey])

  const value = React.useMemo(
    () => ({
      theme,
      setTheme,
      palette,
      setPalette,
    }),
    [theme, setTheme, palette, setPalette]
  )

  return (
    <ThemeProviderContext.Provider {...props} value={value}>
      {children}
    </ThemeProviderContext.Provider>
  )
}

export const useTheme = () => {
  const context = React.useContext(ThemeProviderContext)

  if (context === undefined) {
    throw new Error("useTheme must be used within a ThemeProvider")
  }

  return context
}
