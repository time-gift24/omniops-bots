"use client"

import { HugeiconsIcon } from "@hugeicons/react"
import { BotIcon, Settings02Icon } from "@hugeicons-pro/core-stroke-rounded"
import { useEffect, useId, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { MarkdownEditor } from "@/components/markdown/markdown-editor"
import { Breadcrumbs } from "@/components/ui/breadcrumbs"
import {
  Button,
  type ButtonState,
  StatefulButton,
} from "@/components/motion/button"
import { cn } from "@/lib/utils"
import {
  AGENT_SKILLS,
  AGENT_TOOLS,
  type AgentConfiguration,
  type AgentResource,
  DEFAULT_AGENT,
  type McpServer,
  MCP_SERVERS,
} from "./agent-builder-data"
import { AgentConfigurationPanel } from "./agent-configuration"

export type AgentBuilderProps = {
  initialConfiguration?: AgentConfiguration
  mcpServers?: readonly McpServer[]
  tools?: readonly AgentResource[]
  skills?: readonly AgentResource[]
  onDebug?: () => void
  toolbarTarget?: HTMLElement | null
  onSave?: (configuration: AgentConfiguration) => void | Promise<void>
  className?: string
}

export function AgentBuilder({
  initialConfiguration = DEFAULT_AGENT,
  mcpServers = MCP_SERVERS,
  tools = AGENT_TOOLS,
  skills = AGENT_SKILLS,
  onDebug,
  toolbarTarget,
  onSave,
  className,
}: AgentBuilderProps) {
  const [configuration, setConfiguration] = useState(initialConfiguration)
  const [saved, setSaved] = useState(initialConfiguration)
  const [saveState, setSaveState] = useState<ButtonState>("idle")
  const [error, setError] = useState("")
  const [settingsOpen, setSettingsOpen] = useState(false)
  const settingsId = useId()
  const lock = useRef(false)
  const resetTimer = useRef<number | undefined>(undefined)
  const dirty = JSON.stringify(configuration) !== JSON.stringify(saved)
  const saving = saveState === "loading"

  useEffect(() => () => window.clearTimeout(resetTimer.current), [])

  function settle(state: ButtonState) {
    setSaveState(state)
    window.clearTimeout(resetTimer.current)
    resetTimer.current = window.setTimeout(() => setSaveState("idle"), 1800)
  }

  function change(next: AgentConfiguration) {
    setConfiguration(next)
    setError("")
    window.clearTimeout(resetTimer.current)
    setSaveState("idle")
  }

  async function save() {
    if (lock.current || !dirty) return
    if (!configuration.name.trim() || !configuration.instructions.trim()) {
      setError("请先填写名称和指令，再保存。")
      setSettingsOpen(true)
      return
    }
    lock.current = true
    setSaveState("loading")
    setError("")
    try {
      await onSave?.(configuration)
      setSaved(configuration)
      settle("success")
    } catch {
      setError("保存失败，请重试。")
      settle("error")
    } finally {
      lock.current = false
    }
  }

  const toolbar = (
    <div className="flex min-h-11 min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 py-1 @min-[400px]/agent-header:flex-nowrap">
      <div className="flex min-w-0 flex-1 basis-full items-center gap-2 @min-[400px]/agent-header:basis-auto">
        <Breadcrumbs
          items={[
            "Agent",
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
            </div>,
          ]}
        />
        <span
          className="hidden shrink-0 text-xs text-muted-foreground @min-[400px]/agent-header:inline"
          role="status"
        >
          {dirty ? "未保存" : ""}
        </span>
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-1">
        <Button
          disabled={!dirty || saving}
          onClick={() => change(saved)}
          size="sm"
          variant="ghost"
          className={cn(
            "px-2.5",
            !dirty && "hidden @min-[400px]/agent-header:inline-flex"
          )}
        >
          撤销
        </Button>
        {onDebug ? (
          <Button
            size="sm"
            variant="outline"
            onClick={onDebug}
            aria-label="调试"
            title="调试"
            className="px-2.5"
          >
            <HugeiconsIcon icon={BotIcon} size={14} aria-hidden="true" />
            <span className="hidden @min-[400px]/agent-header:inline">
              调试
            </span>
          </Button>
        ) : null}
        <StatefulButton
          disabled={(!dirty && saveState === "idle") || saving}
          errorText="重试"
          loadingText="保存中"
          onClick={() => void save()}
          size="sm"
          state={saveState}
          successText="已保存"
          className="min-w-14 px-3"
        >
          保存
        </StatefulButton>
      </div>
    </div>
  )

  return (
    <div
      className={cn(
        "@container/agent flex h-full min-h-0 w-full flex-col overflow-hidden bg-background text-foreground",
        className
      )}
      onKeyDown={(event) => {
        if (
          (event.metaKey || event.ctrlKey) &&
          event.key.toLowerCase() === "s"
        ) {
          event.preventDefault()
          if (!saving) void save()
        }
      }}
    >
      {toolbarTarget ? (
        createPortal(toolbar, toolbarTarget)
      ) : (
        <div className="@container/agent-header flex shrink-0 border-b border-border px-3">
          {toolbar}
        </div>
      )}
      {error ? (
        <p
          className="shrink-0 border-b border-border px-4 py-2 text-xs text-destructive"
          role="alert"
        >
          {error}
        </p>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col border-t border-border @min-[480px]/agent:flex-row">
        <aside
          id={settingsId}
          aria-label="Agent 配置"
          className={cn(
            "max-h-[48%] min-h-0 shrink-0 overflow-y-auto border-b border-border bg-muted/20 px-4 py-4 @min-[480px]/agent:max-h-none @min-[480px]/agent:w-56 @min-[480px]/agent:border-r @min-[480px]/agent:border-b-0 @min-[760px]/agent:w-60",
            settingsOpen ? "block" : "hidden @min-[480px]/agent:block"
          )}
        >
          <AgentConfigurationPanel
            disabled={saving}
            mcpServers={mcpServers}
            onChange={change}
            tools={tools}
            skills={skills}
            value={configuration}
          />
        </aside>
        <MarkdownEditor
          title={
            <span className="flex items-center gap-3">
              <span>指令</span>
              <button
                type="button"
                aria-label="Agent 配置"
                aria-controls={settingsId}
                aria-expanded={settingsOpen}
                onClick={() => setSettingsOpen((open) => !open)}
                className="inline-flex min-h-7 items-center gap-1 rounded-md px-1 text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring @min-[480px]/agent:hidden"
              >
                <HugeiconsIcon
                  icon={Settings02Icon}
                  size={13}
                  aria-hidden="true"
                />
                配置
              </button>
            </span>
          }
          ariaLabel="指令"
          className="min-h-0 min-w-0 flex-1 rounded-none border-0"
          value={configuration.instructions}
          maxLength={12000}
          disabled={saving}
          onChange={(instructions) =>
            change({ ...configuration, instructions })
          }
        />
      </div>
    </div>
  )
}
