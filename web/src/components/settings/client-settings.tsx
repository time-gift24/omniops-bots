import { useEffect, useId, useRef, useState, type RefObject } from "react"
import { useAppDependencies } from "@/app/dependencies"
import type { DesktopRuntime, DesktopSettings } from "@/desktop/runtime"
import { themeOptions } from "./appearance-options"
import { useTheme } from "@/components/theme-provider"
import { Button } from "@/components/arc/button/button"
import { RadioGroup } from "@/components/arc/radio-group/radio-group"
import { Badge } from "@/components/arc/badge/badge"
import { Input } from "@/components/motion/input"
import { useToast } from "@/components/ui/toast"
import { useBackendData } from "@/components/workbench/use-backend-data"
import { Select } from "@/components/premium/select/select"
import { settingsSections, type SettingsSection } from "./settings-navigation"
import { ProviderSettings } from "./provider-settings"
import "./client-settings.css"

function AppearancePreview() {
  return (
    <figure className="settings-preview">
      <div className="settings-preview-window" aria-hidden="true">
        <div className="settings-preview-sidebar">
          <span className="settings-preview-brand" />
          <i />
          <i />
          <i />
          <span className="settings-preview-active" />
          <i />
        </div>
        <div className="settings-preview-main">
          <div className="settings-preview-toolbar">
            <i />
            <i />
            <i />
          </div>
          <span className="settings-preview-message" />
          <div className="settings-preview-answer">
            <i />
            <i />
            <i />
          </div>
          <span className="settings-preview-composer">
            <b />
          </span>
        </div>
      </div>
      <figcaption>界面预览</figcaption>
    </figure>
  )
}

export function ClientSettingsScreen({
  scrollRef,
  activeSection,
  onSectionChange,
}: {
  scrollRef: RefObject<HTMLDivElement | null>
  activeSection: SettingsSection
  onSectionChange: (section: SettingsSection) => void
}) {
  const { desktop } = useAppDependencies()
  const { theme, setTheme } = useTheme()
  const [attempt, setAttempt] = useState(0)
  const settings = useBackendData(
    attempt,
    async () => {
      if (!desktop.readSettings) throw new Error("unsupported")
      return desktop.readSettings()
    },
    desktop
  )
  function navigate(section: string) {
    onSectionChange(section as SettingsSection)
    scrollRef.current?.scrollTo({ top: 0, behavior: "instant" })
  }
  return (
    <div
      ref={scrollRef}
      data-slot="client-settings"
      className="settings-content h-full overflow-y-auto overscroll-contain"
    >
      <div className="settings-mobile-navigation">
        <Select
          label="设置分区"
          value={activeSection}
          options={settingsSections.map(({ id, label }) => ({ id, label }))}
          onValueChange={navigate}
          className="w-full"
          buttonClassName="w-full"
        />
      </div>
      <div className="settings-body">
        <section
          id="client-settings-theme"
          hidden={activeSection !== "theme"}
          data-settings-section="theme"
          tabIndex={-1}
          aria-labelledby="settings-theme-heading"
          className="settings-section"
        >
          <div className="settings-section-heading">
            <h2 id="settings-theme-heading">主题</h2>
            <p>选择适合当前环境的界面外观。</p>
          </div>
          <div className="settings-appearance">
            <RadioGroup
              label="主题"
              name="settings-theme"
              value={theme}
              onValueChange={(value) => setTheme(value as typeof theme)}
              options={themeOptions.map((option) => ({
                value: option.value,
                label: option.label,
                description: {
                  light: "明亮清晰的工作界面",
                  dark: "适合低光环境",
                  system: "与系统外观保持一致",
                }[option.value],
              }))}
            />
            <AppearancePreview />
          </div>
          <div className="settings-inline-note">
            <span>当前主题</span>
            <Badge size="sm">
              {themeOptions.find((option) => option.value === theme)?.label}
            </Badge>
          </div>
        </section>
        <ProviderSettings active={activeSection === "providers"} />
        <section
          id="client-settings-tasks"
          hidden={activeSection !== "tasks"}
          data-settings-section="tasks"
          tabIndex={-1}
          aria-labelledby="settings-tasks-heading"
          className="settings-section"
        >
          <div className="settings-section-heading">
            <h2 id="settings-tasks-heading">Agent 运行</h2>
            <p>管理这个客户端的任务并发。</p>
          </div>
          {!desktop.readSettings || !desktop.saveSettings ? (
            <p className="settings-empty">当前接入暂不支持客户端设置。</p>
          ) : settings.status === "loading" ? (
            <p role="status" className="settings-empty">
              正在读取客户端设置…
            </p>
          ) : settings.status === "error" ? (
            <div className="settings-empty">
              <p role="alert" className="text-sm text-destructive">
                客户端设置读取失败，请重试。
              </p>
              <Button
                variant="secondary"
                onClick={() => setAttempt((value) => value + 1)}
              >
                重试
              </Button>
            </div>
          ) : (
            <SettingsForm desktop={desktop} initialSettings={settings.data} />
          )}
        </section>
      </div>
    </div>
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
  const toast = useToast()
  const [saved, setSaved] = useState(initialSettings.maxConcurrentRuns)
  const [draft, setDraft] = useState(String(saved))
  const [saving, setSaving] = useState(false)
  const operation = useRef(false)
  const mounted = useRef(false)
  const clearNotices = () => {
    toast.dismissKey("client-settings-error")
    toast.dismissKey("client-settings-notice")
  }
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
      className="settings-runtime-form"
      onSubmit={(event) => {
        event.preventDefault()
        if (!valid || !changed || operation.current || !desktop.saveSettings)
          return
        operation.current = true
        setSaving(true)
        clearNotices()
        void desktop
          .saveSettings({ maxConcurrentRuns: value })
          .then(
            (settings) => {
              if (!mounted.current) return
              setSaved(settings.maxConcurrentRuns)
              setDraft(String(settings.maxConcurrentRuns))
              toast.notify({
                key: "client-settings-notice",
                title: "设置已保存。",
                tone: "success",
              })
            },
            (cause: unknown) => {
              if (mounted.current)
                toast.notify({
                  key: "client-settings-error",
                  title:
                    cause instanceof Error
                      ? cause.message
                      : "客户端设置保存失败，原设置仍生效，请重试。",
                  tone: "error",
                })
            }
          )
          .finally(() => {
            operation.current = false
            if (mounted.current) setSaving(false)
          })
      }}
    >
      <div className="settings-runtime-row">
        <div>
          <label htmlFor={id} className="block text-sm font-medium">
            同时运行的任务数
          </label>
          <p id={`${id}-help`} className="mt-1 text-sm text-muted-foreground">
            例如设为 4，可在 4 个会话中同时运行 Agent，包含浏览器任务。
          </p>
        </div>
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Input
              id={id}
              type="number"
              inputMode="numeric"
              min={1}
              max={64}
              step={1}
              value={draft}
              disabled={saving}
              error={invalid}
              aria-invalid={invalid}
              aria-describedby={`${id}-help ${id}-range${changed ? ` ${id}-effective` : ""}${invalid ? ` ${id}-invalid` : ""}`}
              className="w-full max-w-24"
              classNames={{
                field: "h-10 bg-background",
                input: "text-sm tabular-nums",
              }}
              onChange={(value) => {
                setDraft(value)
                clearNotices()
              }}
            />
            <span className="text-sm text-muted-foreground" aria-hidden="true">
              个
            </span>
          </div>
          <p id={`${id}-range`} className="text-sm text-muted-foreground">
            1–64 个
          </p>
          {invalid ? (
            <p
              id={`${id}-invalid`}
              role="alert"
              className="text-sm text-destructive"
            >
              请输入 1 到 64 的整数。
            </p>
          ) : null}
          {changed ? (
            <p id={`${id}-effective`} className="text-sm text-muted-foreground">
              当前上限：{saved} 个
            </p>
          ) : null}
        </div>
      </div>
      {changed ? (
        <p className="text-sm text-muted-foreground">
          保存后用于新任务，不会中断正在运行的任务。
        </p>
      ) : null}
      {desktop.getState().simulated ? (
        <p className="text-sm text-muted-foreground">
          网页演示：此项设置刷新后恢复默认。
        </p>
      ) : null}
      <div className="settings-form-actions">
        <span className="mr-auto text-xs text-muted-foreground" role="status">
          {changed ? "有未保存的更改" : "所有更改已保存"}
        </span>
        <Button
          type="button"
          variant="ghost"
          disabled={!changed || saving}
          onClick={() => {
            setDraft(String(saved))
            clearNotices()
          }}
        >
          撤销
        </Button>
        <Button
          className="rounded-full"
          type="submit"
          disabled={!valid || !changed || saving}
        >
          {saving ? "正在保存…" : "保存设置"}
        </Button>
      </div>
    </form>
  )
}
