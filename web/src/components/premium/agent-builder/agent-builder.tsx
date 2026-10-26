import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { ArrowUpRight, Check, Copy, SlidersHorizontal, X } from "lucide-react"
import { Button } from "@/components/arc/button/button"
import { Input } from "@/components/motion/input"
import { MarkdownEditor } from "@/components/markdown/markdown-editor"
import { Breadcrumbs } from "@/components/ui/breadcrumbs"
import { useToast } from "@/components/ui/toast"
import { useSaveShortcut } from "@/hooks/use-save-shortcut"
import { cn } from "@/lib/utils"
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
  /** Open a fresh Agent directly in edit mode. */
  initialEditing?: boolean
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
  initialEditing = false,
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
  debugLabel = "开始对话",
  resourceManager,
  onCopy,
}: AgentBuilderProps) {
  const [configuration, setConfiguration] = useState(initialDraft)
  const [saved, setSaved] = useState(initialConfiguration)
  const [saving, setSaving] = useState(false)
  const [hasSaved, setHasSaved] = useState(!initialEditing)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [notice, setNotice] = useState("")
  const lock = useRef(false)
  const mounted = useRef(false)
  const current = useRef(configuration)
  const root = useRef<HTMLDivElement>(null)
  const toast = useToast()
  const dirty = JSON.stringify(configuration) !== JSON.stringify(saved)
  const capabilities =
    configuration.mcpServerIds.length +
    configuration.toolIds.length +
    configuration.skillIds.length
  useLayoutEffect(() => {
    current.current = configuration
  }, [configuration])
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    if (initialEditing && !readOnly)
      root.current
        ?.querySelector<HTMLInputElement>('input[aria-label="名称"]')
        ?.focus({ preventScroll: true })
  }, [initialEditing, readOnly])
  useEffect(() => {
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ""
    }
    window.addEventListener("beforeunload", warn)
    return () => window.removeEventListener("beforeunload", warn)
  }, [dirty])
  useSaveShortcut({ active, enabled: !readOnly, onSave: () => void save() })
  function change(next: AgentConfiguration) {
    setConfiguration(next)
    onDraftChange?.(next)
    setNotice("")
    toast.dismissKey("agent-builder-error")
  }
  async function save() {
    if (lock.current || readOnly || (!dirty && hasSaved)) return
    if (!configuration.name.trim() || !configuration.instructions.trim()) {
      toast.notify({
        key: "agent-builder-error",
        title: "请填写名称和系统提示词。",
        tone: "error",
      })
      const field = root.current?.querySelector<
        HTMLInputElement | HTMLTextAreaElement
      >(
        !configuration.name.trim()
          ? 'input[aria-label="名称"]'
          : 'textarea[aria-label="系统提示词"]'
      )
      if (field?.hidden)
        root.current
          ?.querySelector<HTMLButtonElement>(
            `button[role="tab"][aria-controls="${field.id}"]`
          )
          ?.dispatchEvent(
            new KeyboardEvent("keydown", {
              key: "Enter",
              bubbles: true,
              cancelable: true,
            })
          )
      requestAnimationFrame(() => field?.focus())
      return
    }
    lock.current = true
    setSaving(true)
    setNotice("")
    toast.dismissKey("agent-builder-error")
    const snapshot = structuredClone(configuration)
    try {
      await onSave(snapshot)
      if (!mounted.current) return
      setSaved(snapshot)
      setHasSaved(true)
      setNotice(
        JSON.stringify(current.current) === JSON.stringify(snapshot)
          ? "已保存"
          : "已保存提交版本，新的修改尚未保存"
      )
    } catch (cause) {
      if (mounted.current)
        toast.notify({
          key: "agent-builder-error",
          title:
            cause instanceof Error
              ? `保存失败：${cause.message}`
              : "保存失败，请重试。",
          tone: "error",
        })
    } finally {
      lock.current = false
      if (mounted.current) setSaving(false)
    }
  }
  const breadcrumb = (
    <Breadcrumbs
      items={[
        { label: "Agent", onSelect: onBack },
        { label: configuration.name.trim() || "未命名 Agent" },
      ]}
    />
  )
  return (
    <div ref={root} className={cn("editor-workspace @container", className)}>
      {active &&
        (toolbarTarget ? (
          createPortal(breadcrumb, toolbarTarget)
        ) : (
          <div className="flex min-h-11 items-center px-5">{breadcrumb}</div>
        ))}
      {active ? (
        <div className="editor-actionbar" data-slot="editor-actions">
          <span className="editor-save-state" role="status">
            {saving
              ? "正在保存…"
              : dirty || !hasSaved
                ? "有未保存的修改"
                : notice || (readOnly ? "官方 Agent · 只读" : "所有修改已保存")}
          </span>
          <Button
            variant={settingsOpen ? "secondary" : "ghost"}
            size="sm"
            aria-label="Agent 能力"
            aria-expanded={settingsOpen}
            onClick={() => setSettingsOpen((open) => !open)}
          >
            <SlidersHorizontal size={15} />
            能力{capabilities ? ` ${capabilities}` : ""}
          </Button>
          {onCopy ? (
            <Button
              variant="secondary"
              size="sm"
              loading={copyBusy}
              disabled={copyBusy}
              onClick={onCopy}
            >
              <Copy size={14} />
              复制为本地
            </Button>
          ) : null}
          {!readOnly ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                disabled={!dirty || saving}
                onClick={() => change(saved)}
              >
                撤销修改
              </Button>
              <Button
                size="sm"
                loading={saving}
                disabled={saving || (!dirty && hasSaved)}
                onClick={() => void save()}
              >
                <Check size={15} />
                保存 Agent
              </Button>
            </>
          ) : null}
          {onDebug ? (
            <Button
              size="sm"
              variant="secondary"
              disabled={dirty || !hasSaved || saving}
              onClick={onDebug}
            >
              {debugLabel}
              <ArrowUpRight size={14} />
            </Button>
          ) : null}
        </div>
      ) : null}
      <div className="editor-content">
        <div className="agent-authoring">
          <div className="agent-identity">
            <Input
              label="名称"
              aria-label="名称"
              value={configuration.name}
              maxLength={80}
              readOnly={readOnly}
              placeholder="Agent 名称"
              onChange={(name) => change({ ...configuration, name })}
            />
            <Input
              label="简介"
              aria-label="简介"
              value={configuration.description}
              maxLength={160}
              readOnly={readOnly}
              placeholder="一句话说明它负责什么"
              onChange={(description) =>
                change({ ...configuration, description })
              }
            />
          </div>
          <MarkdownEditor
            title="系统提示词"
            ariaLabel="系统提示词"
            value={configuration.instructions}
            readOnly={readOnly}
            maxLength={12000}
            placeholder="描述这个 Agent 的身份、职责、工作方式和边界。"
            onChange={(instructions) =>
              change({ ...configuration, instructions })
            }
          />
        </div>
        <aside
          aria-label="Agent 配置"
          className="agent-capabilities"
          hidden={!settingsOpen}
        >
          <div className="agent-capabilities-header">
            能力配置
            <Button
              variant="ghost"
              size="sm"
              className="editor-icon"
              aria-label="关闭能力配置"
              onClick={() => setSettingsOpen(false)}
            >
              <X size={16} />
            </Button>
          </div>
          <AgentConfigurationPanel
            disabled={false}
            readOnly={readOnly}
            showApproval={showApproval}
            mcpServers={mcpServers}
            tools={tools}
            skills={skills}
            value={configuration}
            onChange={change}
          />
          {resourceManager}
        </aside>
      </div>
    </div>
  )
}
