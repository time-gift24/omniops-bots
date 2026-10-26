"use client"

import { useAppDependencies } from "@/app/dependencies"
import { useCallback, useEffect, useRef, useState } from "react"

export type CopyFeedbackState = "idle" | "copied" | "error"

/** Shared clipboard state for actions that render their own button or menu. */
export function useCopyFeedback(duration = 1900) {
  const { host } = useAppDependencies()
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const [state, setState] = useState<CopyFeedbackState>("idle")
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const timeout = useRef<ReturnType<typeof setTimeout> | null>(null)

  const reset = useCallback(() => {
    if (timeout.current) clearTimeout(timeout.current)
    timeout.current = null
    setState("idle")
    setActiveKey(null)
  }, [])

  useEffect(
    () => () => {
      if (timeout.current) clearTimeout(timeout.current)
    },
    []
  )

  const copy = useCallback(
    async (value: string, key = "default") => {
      if (timeout.current) clearTimeout(timeout.current)
      setActiveKey(key)
      try {
        await host.copyText(value)
        if (!mounted.current) return true
        setState("copied")
        timeout.current = setTimeout(reset, duration)
        return true
      } catch {
        if (!mounted.current) return false
        setState("error")
        timeout.current = setTimeout(reset, duration)
        return false
      }
    },
    [duration, reset, host]
  )

  return { state, activeKey, copy, reset }
}
