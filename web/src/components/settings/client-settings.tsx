import { useEffect, useId, useRef, useState } from "react"
import { useAppDependencies } from "@/app/dependencies"
import type { DesktopRuntime, DesktopSettings } from "@/desktop/runtime"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useBackendData } from "@/components/workbench/use-backend-data"

export function ClientSettingsScreen() {
  const { desktop } = useAppDependencies()
  const [attempt, setAttempt] = useState(0)
  const settings = useBackendData(
    attempt,
    async () => {
      if (!desktop.readSettings) throw new Error("unsupported")
      return desktop.readSettings()
    },
    desktop
  )
  return (
    <section data-slot="client-settings" className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-6 py-8 sm:px-8">
        <h1 className="text-2xl font-medium tracking-tight">偏好设置</h1>
        {!desktop.readSettings || !desktop.saveSettings ? (
          <p className="mt-6 text-sm text-muted-foreground">
            当前接入暂不支持客户端设置。
          </p>
        ) : settings.status === "loading" ? (
          <p role="status" className="mt-6 text-sm text-muted-foreground">
            正在读取客户端设置…
          </p>
        ) : settings.status === "error" ? (
          <div className="mt-6 space-y-3">
            <p role="alert" className="text-sm text-destructive">
              客户端设置读取失败，请重试。
            </p>
            <Button
              variant="outline"
              onClick={() => setAttempt((value) => value + 1)}
            >
              重试
            </Button>
          </div>
        ) : (
          <SettingsForm desktop={desktop} initialSettings={settings.data} />
        )}
      </div>
    </section>
  )
}

function SettingsForm({
  desktop,
  initialSettings,
}: {
  desktop: DesktopRuntime
  initialSettings: DesktopSettings
}) {
  const id = useId()
  const [saved, setSaved] = useState(initialSettings.maxConcurrentRuns)
  const [draft, setDraft] = useState(String(saved))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const [success, setSuccess] = useState(false)
  const operation = useRef(false)
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const value = Number(draft)
  const valid =
    draft.trim() !== "" &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= 64
  const changed = draft !== String(saved)
  const invalid = changed && !valid
  return (
    <form
      noValidate
      className="mt-8 space-y-6"
      onSubmit={(event) => {
        event.preventDefault()
        if (!valid || !changed || operation.current || !desktop.saveSettings)
          return
        operation.current = true
        setSaving(true)
        setError("")
        setSuccess(false)
        void desktop
          .saveSettings({ maxConcurrentRuns: value })
          .then(
            (settings) => {
              if (!mounted.current) return
              setSaved(settings.maxConcurrentRuns)
              setDraft(String(settings.maxConcurrentRuns))
              setSuccess(true)
            },
            (cause: unknown) => {
              if (mounted.current)
                setError(
                  cause instanceof Error
                    ? cause.message
                    : "客户端设置保存失败，原设置仍生效，请重试。"
                )
            }
          )
          .finally(() => {
            operation.current = false
            if (mounted.current) setSaving(false)
          })
      }}
    >
      <div className="space-y-3">
        <label htmlFor={id} className="block text-sm font-medium">
          并发任务上限
        </label>
        <p
          id={`${id}-help`}
          className="max-w-prose text-sm leading-relaxed text-muted-foreground"
        >
          本地、实验和远端任务共用此上限。默认 4，支持 1 到 64 的整数。
          保存后立即用于新任务；调低上限不会停止正在执行的任务。
        </p>
        <Input
          id={id}
          type="number"
          inputMode="numeric"
          min={1}
          max={64}
          step={1}
          value={draft}
          disabled={saving}
          aria-invalid={invalid}
          aria-describedby={`${id}-help ${id}-effective${invalid ? ` ${id}-invalid` : ""}`}
          className="h-10 max-w-40 tabular-nums"
          onChange={(event) => {
            setDraft(event.target.value)
            setError("")
            setSuccess(false)
          }}
        />
        {invalid ? (
          <p
            id={`${id}-invalid`}
            role="alert"
            className="text-sm text-destructive"
          >
            请输入 1 到 64 的整数。
          </p>
        ) : null}
        <p id={`${id}-effective`} className="text-sm text-muted-foreground">
          当前生效上限：{saved}
        </p>
      </div>
      {desktop.getState().simulated ? (
        <p className="text-sm text-muted-foreground">
          网页演示仅预览此设置，数值仅在本次演示中保留。
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={!valid || !changed || saving}>
          {saving ? "正在保存…" : "保存设置"}
        </Button>
        {success ? (
          <p role="status" className="text-sm text-muted-foreground">
            {desktop.getState().simulated
              ? "演示设置已保存。"
              : "设置已保存，对新任务立即生效。"}
          </p>
        ) : null}
      </div>
    </form>
  )
}
