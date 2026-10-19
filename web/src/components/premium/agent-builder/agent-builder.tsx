"use client"

import { HugeiconsIcon } from "@hugeicons/react"
import {
  BotIcon,
  Copy01Icon,
  Settings02Icon,
} from "@hugeicons-pro/core-stroke-rounded"
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react"
import { createPortal } from "react-dom"
import {
  MarkdownEditor,
  type MarkdownEditorMode,
} from "@/components/markdown/markdown-editor"
import {
  MarkdownOutline,
  MarkdownReading,
  useHeadingScroll,
} from "@/components/markdown/markdown-reading"
import {
  findDocsHeading,
  type DocsSection,
} from "@/components/premium/docs-pages/docs-data"
import { useScrollspy } from "@/components/premium/docs-pages/use-scrollspy"
import { Breadcrumbs } from "@/components/ui/breadcrumbs"
import { Button } from "@/components/motion/button"
import { DocumentActions } from "@/components/markdown/document-actions"
import { cn } from "@/lib/utils"
import "@/components/premium/docs-pages/docs-article.css"
import type {
  AgentConfiguration,
  AgentResource,
  McpServer,
} from "@/agents/source"
import { AgentConfigurationPanel } from "./agent-configuration"

export type AgentBuilderProps = {
  initialConfiguration: AgentConfiguration
  active?: boolean
  copyBusy?: boolean
  initialDraft?: AgentConfiguration
  onDraftChange?: (configuration: AgentConfiguration) => void
  mcpServers: readonly McpServer[]
  tools: readonly AgentResource[]
  skills: readonly AgentResource[]
  onDebug?: () => void
  onBack?: () => void
  toolbarTarget?: HTMLElement | null
  onSave: (configuration: AgentConfiguration) => void | Promise<void>
  className?: string
  readOnly?: boolean
  showApproval?: boolean
  debugLabel?: string
  resourceManager?: import("react").ReactNode
  onCopy?: () => void
}

export function AgentBuilder({
  initialConfiguration,
  active = true,
  copyBusy = false,
  initialDraft = initialConfiguration,
  onDraftChange,
  mcpServers,
  tools,
  skills,
  onDebug,
  onBack,
  toolbarTarget,
  onSave,
  className,
  readOnly = false,
  showApproval = true,
  debugLabel,
  resourceManager,
  onCopy,
}: AgentBuilderProps) {
  const [configuration, setConfiguration] = useState(initialDraft)
  const [saved, setSaved] = useState(initialConfiguration)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [editing, setEditing] = useState(
    JSON.stringify(initialDraft) !== JSON.stringify(initialConfiguration)
  )
  const [mode, setMode] = useState<MarkdownEditorMode>("source")
  const [outline, setOutline] = useState<DocsSection[]>([])
  const scrollRef = useRef<HTMLDivElement>(null)
  const editorPreviewRef = useRef<HTMLDivElement>(null)
  const settingsId = useId()
  const lock = useRef(false)
  const dirty = JSON.stringify(configuration) !== JSON.stringify(saved)
  const currentConfiguration = useRef(configuration)
  const rootRef = useRef<HTMLDivElement>(null)
  const mounted = useRef(false)
  const [message, setMessage] = useState("")
  useLayoutEffect(() => {
    currentConfiguration.current = configuration
  }, [configuration])
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ""
    }
    window.addEventListener("beforeunload", warn)
    return () => window.removeEventListener("beforeunload", warn)
  }, [dirty])
  useEffect(() => {
    if (!active) return
    const shortcut = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        !(event.metaKey || event.ctrlKey) ||
        event.key.toLowerCase() !== "s"
      )
        return
      if (
        event.target instanceof Element &&
        event.target.closest('[aria-modal="true"]')
      )
        return
      event.preventDefault()
      if (editing && !saving) void save()
    }
    window.addEventListener("keydown", shortcut)
    return () => window.removeEventListener("keydown", shortcut)
  })

  const updateSections = useCallback(
    (sections: DocsSection[]) => setOutline(sections),
    []
  )
  const outlineSections = !editing || mode === "preview" ? outline : []
  const activeSection = useScrollspy(
    outlineSections.map((section) => section.id),
    editing ? editorPreviewRef : scrollRef
  )
  const resolveScroll = useCallback(
    () => editorPreviewRef.current ?? scrollRef.current,
    []
  )
  const { scrollToHeading } = useHeadingScroll(
    resolveScroll,
    editing ? mode : "reading"
  )
  const wide = editing && mode !== "preview"

  function change(next: AgentConfiguration) {
    setConfiguration(next)
    onDraftChange?.(next)
    setError("")
    setMessage("")
  }

  async function save() {
    if (lock.current || readOnly) return
    if (!dirty) {
      setEditing(false)
      return
    }
    if (!configuration.name.trim() || !configuration.instructions.trim()) {
      setError("请先填写名称和系统提示词，再保存。")
      if (!configuration.name.trim()) setSettingsOpen(true)
      else
        rootRef.current
          ?.querySelector<HTMLButtonElement>('[aria-label="编辑视图"] button')
          ?.click()
      requestAnimationFrame(() => {
        rootRef.current
          ?.querySelector<HTMLInputElement | HTMLTextAreaElement>(
            !configuration.name.trim()
              ? "aside input"
              : 'textarea[aria-label="系统提示词"]'
          )
          ?.focus()
      })
      return
    }
    lock.current = true
    setSaving(true)
    setError("")
    const snapshot = structuredClone(configuration)
    try {
      await onSave(snapshot)
      if (!mounted.current) return
      setSaved(snapshot)
      if (
        JSON.stringify(currentConfiguration.current) ===
        JSON.stringify(snapshot)
      ) {
        setEditing(false)
        setMessage("Agent 已保存")
      } else setMessage("已保存提交时的版本，新的修改尚未保存")
    } catch (cause) {
      if (mounted.current)
        setError(
          cause instanceof Error
            ? `保存失败：${cause.message}`
            : "保存失败，请重试。"
        )
    } finally {
      lock.current = false
      if (mounted.current) setSaving(false)
    }
  }

  const toolbar = (
    <div className="flex min-h-11 min-w-0 flex-1 items-center gap-2 py-1">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <Breadcrumbs
          items={[
            { label: "Agent", onSelect: onBack },
            {
              label: (
                <div className="flex min-w-0 items-center gap-2">
                  <span
                    aria-hidden="true"
                    className="grid size-6 shrink-0 place-items-center rounded-lg bg-accent text-accent-foreground"
                  >
                    <HugeiconsIcon icon={BotIcon} size={14} />
                  </span>
                  <h1
                    className="truncate text-sm font-medium"
                    title={configuration.name.trim() || "未命名 Agent"}
                  >
                    {configuration.name.trim() || "未命名 Agent"}
                  </h1>
                </div>
              ),
            },
          ]}
        />
        <span
          className="hidden shrink-0 text-xs text-muted-foreground @min-[400px]/agent-header:inline"
          role="status"
        >
          {dirty ? "未保存" : ""}
        </span>
      </div>
    </div>
  )

  const preview = (
    <MarkdownReading
      source={configuration.instructions}
      onSections={updateSections}
      empty={
        <p className="py-12 text-center text-sm text-muted-foreground">
          {readOnly
            ? "这个 Agent 尚未提供系统提示词。"
            : editing
              ? "输入系统提示词后，可在这里预览。"
              : "还没有系统提示词，点击「编辑」开始编写。"}
        </p>
      }
    />
  )

  return (
    <div
      className={cn(
        "@container/agent flex h-full min-h-0 w-full flex-col overflow-hidden bg-background text-foreground",
        className
      )}
      ref={rootRef}
    >
      {active &&
        (toolbarTarget ? (
          createPortal(toolbar, toolbarTarget)
        ) : (
          <div className="@container/agent-header flex shrink-0 px-3">
            {toolbar}
          </div>
        ))}
      <span role="status" className="sr-only">
        {message}
      </span>
      {error ? (
        <p
          className="shrink-0 border-b border-border px-4 py-2 text-xs text-destructive"
          role="alert"
        >
          {error}
        </p>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col @min-[480px]/agent:flex-row">
        <aside
          id={settingsId}
          aria-label="Agent 配置"
          className={cn(
            "max-h-[48%] min-h-0 shrink-0 overflow-y-auto border-b border-border bg-muted/30 px-4 py-4 @min-[480px]/agent:max-h-none @min-[480px]/agent:w-1/3 @min-[480px]/agent:min-w-64 @min-[480px]/agent:border-r @min-[480px]/agent:border-b-0 @min-[760px]/agent:max-w-[26rem] @min-[760px]/agent:px-6 @min-[760px]/agent:py-6",
            settingsOpen ? "block" : "hidden @min-[480px]/agent:block"
          )}
        >
          <AgentConfigurationPanel
            disabled={false}
            readOnly={readOnly || !editing}
            showApproval={showApproval}
            mcpServers={mcpServers}
            onChange={change}
            tools={tools}
            skills={skills}
            value={configuration}
          />
          {resourceManager}
        </aside>
        <div className="doc-action-surface doc-action-surface-vertical relative flex min-h-0 min-w-0 flex-1">
          {active ? (
            <DocumentActions
              vertical
              readOnly={readOnly}
              debugLabel={debugLabel}
              editing={editing}
              busy={saving}
              dirty={dirty}
              onEdit={() => {
                setEditing(true)
                setMode("source")
              }}
              onSave={() => void save()}
              onUndo={() => {
                change(saved)
                setEditing(false)
              }}
              onDebug={onDebug}
            >
              {onCopy ? (
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 text-muted-foreground/70 hover:text-foreground"
                  aria-label="复制为本地"
                  title="复制为本地 Agent"
                  disabled={copyBusy}
                  aria-busy={copyBusy}
                  onClick={onCopy}
                >
                  <HugeiconsIcon
                    icon={Copy01Icon}
                    size={16}
                    aria-hidden="true"
                  />
                </Button>
              ) : null}
              <Button
                size="icon"
                variant="ghost"
                aria-label="Agent 配置"
                title="Agent 配置"
                aria-controls={settingsId}
                aria-expanded={settingsOpen}
                onClick={() => setSettingsOpen((open) => !open)}
                className="size-7 text-muted-foreground/70 hover:text-foreground @min-[480px]/agent:hidden"
              >
                <HugeiconsIcon
                  icon={Settings02Icon}
                  size={16}
                  aria-hidden="true"
                />
              </Button>
            </DocumentActions>
          ) : null}
          <div
            ref={scrollRef}
            className={cn(
              "doc-reading-scroll min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain",
              editing && "overflow-hidden"
            )}
            tabIndex={0}
            aria-label="系统提示词"
          >
            <div
              className={cn("doc-reading-layout", wide && "doc-reading-wide")}
              style={editing ? { height: "100%", maxWidth: "none" } : undefined}
            >
              <article
                className={cn(
                  "doc-article min-w-0 pt-2!",
                  editing && "flex h-full min-h-0 flex-col p-3!"
                )}
              >
                {editing ? (
                  <MarkdownEditor
                    title="系统提示词"
                    ariaLabel="系统提示词"
                    className="min-h-0 min-w-0 flex-1"
                    value={configuration.instructions}
                    maxLength={12000}
                    placeholder="定义这个 Agent 的身份、职责、工作方式与边界。例如：你是客户支持助手，回答时优先使用已连接的工具核实信息……"
                    autoFocus
                    preview={preview}
                    previewScrollRef={editorPreviewRef}
                    onModeChange={setMode}
                    onChange={(instructions) =>
                      change({ ...configuration, instructions })
                    }
                  />
                ) : (
                  preview
                )}
              </article>
              {!wide && outlineSections.length > 0 ? (
                <MarkdownOutline
                  sections={outlineSections}
                  active={activeSection ?? ""}
                  onSelect={(id) => {
                    const node = findDocsHeading(resolveScroll(), id)
                    if (node) scrollToHeading(node)
                  }}
                />
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
