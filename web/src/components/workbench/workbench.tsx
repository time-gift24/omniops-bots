"use client"

import {
  type Ref,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react"
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react"
import { motion, useReducedMotion } from "motion/react"
import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  BotIcon,
  Cancel01Icon,
  FileTextIcon,
  FolderOpenIcon,
  GitMergeIcon,
  Globe02Icon,
  MoreVerticalIcon,
  PanelRightCloseIcon,
  PlusSignIcon,
  ReloadIcon,
  Search01Icon,
} from "@hugeicons-pro/core-stroke-rounded"
import { Button } from "@/components/ui/button"
import { ChatScreen } from "@/components/chat/chat-screen"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group"
import { MorphicTooltip } from "@/components/premium/morphic-tooltip/morphic-tooltip"
import { SPRING_PANEL } from "@/lib/ease"
import { cn } from "@/lib/utils"
import type {
  RecommendedSite,
  WorkbenchBackend,
  WorkbenchScope,
} from "@/workbench/backend"
import { ChangesView } from "./changes-view"
import { FilesView, FileView } from "./files-view"
import { StartPage } from "./start-page"
import { useBackendData } from "./use-backend-data"
import { useAppDependencies } from "@/app/dependencies"
import type { ModelChoice } from "@/models/source"
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard"

const MIN_WIDTH = 320
const DEFAULT_WIDTH = 400
const MAX_WIDTH = 640
const DEBUG_SUGGESTIONS = [
  "你能帮我做什么？",
  "查一下订单 1024 的最新状态",
  "这周的客户问题有什么共同点？",
] as const

function clampWidth(value: number): number {
  const viewportCap = Math.round(window.innerWidth * 0.6)
  return Math.min(Math.max(value, MIN_WIDTH), Math.min(MAX_WIDTH, viewportCap))
}

export type WorkbenchView =
  | { type: "start" }
  | { type: "page"; url: string }
  | { type: "files" }
  | { type: "changes" }
  | { type: "file"; path: string }
  | { type: "agent-debug"; agentId: string; name: string }

export type WorkbenchTab = { id: string; view: WorkbenchView }
export type WorkbenchHandle = {
  openAgentDebug(agentId: string, name: string): void
}

function basename(path: string): string {
  const segment = path.split("/").filter(Boolean).pop()
  return segment ?? path
}

function viewTitle(view: WorkbenchView): string {
  switch (view.type) {
    case "start":
      return "新标签页"
    case "page":
      return view.url
    case "files":
      return "文件"
    case "changes":
      return "变更"
    case "file":
      return basename(view.path)
    case "agent-debug":
      return `${view.name} 调试`
  }
}

function viewIcon(view: WorkbenchView): IconSvgElement {
  switch (view.type) {
    case "start":
    case "page":
      return Globe02Icon
    case "files":
      return FolderOpenIcon
    case "changes":
      return GitMergeIcon
    case "file":
      return FileTextIcon
    case "agent-debug":
      return BotIcon
  }
}

function TabButton({
  tab,
  active,
  onSelect,
  onClose,
}: {
  tab: WorkbenchTab
  active: boolean
  onSelect: () => void
  onClose?: () => void
}) {
  return (
    <div
      role="tab"
      aria-selected={active}
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault()
          onSelect()
        }
      }}
      className={cn(
        "group/tab flex h-8 max-w-36 min-w-0 shrink-0 cursor-default items-center gap-1.5 rounded-full pr-1.5 pl-3 text-xs outline-none select-none focus-visible:ring-2 focus-visible:ring-ring",
        active
          ? "bg-accent font-medium text-accent-foreground"
          : "text-muted-foreground hover:bg-muted hover:text-foreground"
      )}
    >
      <HugeiconsIcon
        icon={viewIcon(tab.view)}
        size={13}
        strokeWidth={1.7}
        aria-hidden="true"
        className="shrink-0 text-muted-foreground"
      />
      <span className="min-w-0 flex-1 truncate">{viewTitle(tab.view)}</span>
      {onClose ? (
        <button
          type="button"
          aria-label={`关闭标签页 ${viewTitle(tab.view)}`}
          onClick={(event) => {
            event.stopPropagation()
            onClose()
          }}
          className="grid size-4.5 shrink-0 place-items-center rounded-full text-muted-foreground opacity-0 transition-opacity outline-none group-focus-within/tab:opacity-100 group-hover/tab:opacity-100 hover:bg-foreground/10 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
        >
          <HugeiconsIcon icon={Cancel01Icon} size={10} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  )
}

function PageView({ url }: { url: string }) {
  return (
    <div className="flex h-full flex-col p-3">
      <div className="grid min-h-0 flex-1 place-items-center rounded-xl border border-border bg-card">
        <div className="flex max-w-64 flex-col items-center gap-2 p-6 text-center">
          <span className="grid size-10 place-items-center rounded-full bg-accent text-accent-foreground">
            <HugeiconsIcon
              icon={Globe02Icon}
              size={20}
              strokeWidth={1.7}
              aria-hidden="true"
            />
          </span>
          <p className="max-w-full truncate text-sm font-medium">{url}</p>
          <p className="text-xs leading-relaxed text-muted-foreground">
            页面渲染区域。接入 WebView 后，这里会直接显示目标页面内容。
          </p>
        </div>
      </div>
    </div>
  )
}

export function WorkbenchPanel({
  ref,
  id,
  open,
  onClose,
  backend,
  scope,
  models,
}: {
  ref?: Ref<WorkbenchHandle>
  id?: string
  open: boolean
  onClose: () => void
  backend: WorkbenchBackend
  scope: WorkbenchScope | null
  models: readonly ModelChoice[]
}) {
  const { host } = useAppDependencies()
  const { copy } = useCopyToClipboard()
  const [hostError, setHostError] = useState("")
  const reduce = useReducedMotion()
  const counter = useRef(1)
  const [width, setWidth] = useState(DEFAULT_WIDTH)
  const [dragging, setDragging] = useState(false)
  const dragState = useRef<{ pointerId: number; rightEdge: number } | null>(
    null
  )

  // 拖拽期间禁用文本选择，结束后恢复。
  useEffect(() => {
    if (!dragging) return
    const previous = document.body.style.userSelect
    document.body.style.userSelect = "none"
    return () => {
      document.body.style.userSelect = previous
    }
  }, [dragging])
  const [tabs, setTabs] = useState<readonly WorkbenchTab[]>([
    { id: "tab-1", view: { type: "start" } },
  ])
  const [activeId, setActiveId] = useState("tab-1")
  const [draftUrl, setDraftUrl] = useState("")
  useImperativeHandle(
    ref,
    () => ({
      openAgentDebug(agentId, name) {
        const id = `agent-debug:${agentId}`
        const view: WorkbenchView = { type: "agent-debug", agentId, name }
        setTabs((current) =>
          current.some((tab) => tab.id === id)
            ? current.map((tab) => (tab.id === id ? { ...tab, view } : tab))
            : [...current, { id, view }]
        )
        setActiveId(id)
        setDraftUrl("")
      },
    }),
    []
  )
  // 推荐位在面板层级缓存一次，返回起始页不重新请求。
  const sites = useBackendData(
    "recommendations",
    () => backend.listRecommendations(),
    backend
  )
  const activeTab = tabs.find((tab) => tab.id === activeId) ?? tabs[0]
  const view = activeTab?.view ?? { type: "start" as const }
  const browserView = view.type === "start" || view.type === "page"

  function selectTab(id: string) {
    const tab = tabs.find((entry) => entry.id === id)
    setActiveId(id)
    setDraftUrl(tab?.view.type === "page" ? tab.view.url : "")
  }

  function updateActiveView(next: WorkbenchView) {
    if (!activeTab) return
    setTabs((current) =>
      current.map((tab) =>
        tab.id === activeTab.id ? { ...tab, view: next } : tab
      )
    )
  }

  function addTab() {
    counter.current += 1
    const id = `tab-${counter.current}`
    setTabs((current) => [...current, { id, view: { type: "start" } }])
    setActiveId(id)
    setDraftUrl("")
  }

  function closeTab(id: string) {
    setTabs((current) => {
      const index = current.findIndex((tab) => tab.id === id)
      const next = current.filter((tab) => tab.id !== id)
      if (id === activeId) {
        const neighbor = next[Math.min(index, next.length - 1)]
        if (neighbor) {
          setActiveId(neighbor.id)
          setDraftUrl(neighbor.view.type === "page" ? neighbor.view.url : "")
        }
      }
      return next
    })
  }

  function navigate(url: string) {
    const value = url.trim()
    if (!value) return
    updateActiveView({ type: "page", url: value })
    setDraftUrl(value)
  }

  function openSite(site: RecommendedSite) {
    navigate(site.url)
  }

  function handleResizeStart(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return
    const panel = event.currentTarget.parentElement
    if (!panel) return
    event.preventDefault()
    dragState.current = {
      pointerId: event.pointerId,
      rightEdge: panel.getBoundingClientRect().right,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    setDragging(true)
  }

  function handleResizeMove(event: React.PointerEvent<HTMLDivElement>) {
    const drag = dragState.current
    if (!drag || drag.pointerId !== event.pointerId) return
    setWidth(clampWidth(drag.rightEdge - event.clientX))
  }

  function handleResizeEnd(event: React.PointerEvent<HTMLDivElement>) {
    const drag = dragState.current
    if (!drag || drag.pointerId !== event.pointerId) return
    dragState.current = null
    setDragging(false)
  }

  function handleResizeKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? 64 : 16
    if (event.key === "ArrowLeft") {
      event.preventDefault()
      setWidth((current) => clampWidth(current + step))
    } else if (event.key === "ArrowRight") {
      event.preventDefault()
      setWidth((current) => clampWidth(current - step))
    }
  }

  return (
    <motion.aside
      id={id}
      aria-label="工作台"
      initial={false}
      animate={{ width: open ? width : 0 }}
      transition={reduce || dragging ? { duration: 0 } : SPRING_PANEL}
      className="h-full shrink-0 overflow-hidden max-md:fixed max-md:inset-y-0 max-md:right-0 max-md:z-40 max-md:max-w-[calc(100vw-4rem)]"
    >
      <div
        inert={!open}
        style={{ width }}
        className="relative ml-auto flex h-full max-w-full flex-col border-l border-border bg-background"
      >
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="调整工作台宽度"
          aria-valuenow={width}
          aria-valuemin={MIN_WIDTH}
          aria-valuemax={MAX_WIDTH}
          tabIndex={0}
          title="拖拽调整宽度，双击恢复默认"
          onPointerDown={handleResizeStart}
          onPointerMove={handleResizeMove}
          onPointerUp={handleResizeEnd}
          onPointerCancel={handleResizeEnd}
          onDoubleClick={() => setWidth(DEFAULT_WIDTH)}
          onKeyDown={handleResizeKeyDown}
          className="group absolute inset-y-0 left-0 z-20 w-2 -translate-x-1/2 cursor-col-resize outline-none max-md:hidden"
        >
          <span
            aria-hidden="true"
            className={cn(
              "absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-colors duration-150 motion-reduce:transition-none",
              dragging
                ? "bg-primary/60"
                : "group-hover:bg-primary/50 group-focus-visible:bg-primary/50"
            )}
          />
        </div>
        <div className="flex h-12 shrink-0 items-center gap-1 px-3">
          <MorphicTooltip content="收起工作台" side="bottom" align="start">
            <Button
              variant="ghost"
              size="icon"
              aria-label="收起工作台"
              onClick={onClose}
              className="size-9 shrink-0 rounded-full"
            >
              <HugeiconsIcon
                icon={PanelRightCloseIcon}
                size={16}
                aria-hidden="true"
              />
            </Button>
          </MorphicTooltip>
          <div
            role="tablist"
            aria-label="工作台标签页"
            className="flex min-w-0 flex-1 [scrollbar-width:none] items-center gap-0.5 overflow-x-auto"
          >
            {tabs.map((tab) => (
              <TabButton
                key={tab.id}
                tab={tab}
                active={tab.id === activeId}
                onSelect={() => selectTab(tab.id)}
                onClose={tabs.length > 1 ? () => closeTab(tab.id) : undefined}
              />
            ))}
          </div>
          <MorphicTooltip content="新建标签页" side="bottom" align="end">
            <Button
              variant="ghost"
              size="icon"
              aria-label="新建标签页"
              onClick={addTab}
              className="size-9 shrink-0 rounded-full"
            >
              <HugeiconsIcon icon={PlusSignIcon} size={16} aria-hidden="true" />
            </Button>
          </MorphicTooltip>
        </div>

        {browserView ? (
          <div className="flex h-12 shrink-0 items-center gap-1 px-3">
            <Button
              variant="ghost"
              size="icon"
              aria-label="后退"
              disabled
              className="size-9 rounded-full"
            >
              <HugeiconsIcon
                icon={ArrowLeft01Icon}
                size={16}
                aria-hidden="true"
              />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="前进"
              disabled
              className="size-9 rounded-full"
            >
              <HugeiconsIcon
                icon={ArrowRight01Icon}
                size={16}
                aria-hidden="true"
              />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="重新加载"
              disabled={view.type !== "page"}
              className="size-9 rounded-full"
            >
              <HugeiconsIcon icon={ReloadIcon} size={16} aria-hidden="true" />
            </Button>
            <form
              className="min-w-0 flex-1"
              onSubmit={(event) => {
                event.preventDefault()
                navigate(draftUrl)
              }}
            >
              <InputGroup className="h-8 rounded-full border-transparent bg-muted/70 has-[[data-slot=input-group-control]:focus-visible]:border-ring has-[[data-slot=input-group-control]:focus-visible]:bg-background">
                <InputGroupAddon align="inline-start" className="pl-2.5">
                  <HugeiconsIcon
                    icon={Search01Icon}
                    size={14}
                    aria-hidden="true"
                  />
                </InputGroupAddon>
                <InputGroupInput
                  value={draftUrl}
                  onChange={(event) => setDraftUrl(event.target.value)}
                  placeholder="搜索或输入网址"
                  aria-label="地址栏"
                  className="text-xs"
                />
              </InputGroup>
            </form>
            <DropdownMenu>
              <MorphicTooltip content="更多" side="bottom" align="end">
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="更多操作"
                    className="size-9 rounded-full"
                  >
                    <HugeiconsIcon
                      icon={MoreVerticalIcon}
                      size={16}
                      aria-hidden="true"
                    />
                  </Button>
                </DropdownMenuTrigger>
              </MorphicTooltip>
              <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuItem
                  disabled={view.type !== "page"}
                  onSelect={() => {
                    if (view.type === "page") void copy(view.url)
                  }}
                >
                  复制链接
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={view.type !== "page"}
                  onSelect={() => {
                    if (view.type === "page") {
                      setHostError("")
                      void host
                        .openExternal(view.url)
                        .catch(() =>
                          setHostError("无法打开链接，请检查权限后重试。")
                        )
                    }
                  }}
                >
                  在默认浏览器中打开
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={addTab}>
                  新建标签页
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ) : view.type === "agent-debug" ? null : (
          <div className="flex h-12 shrink-0 items-center gap-1 px-3">
            <Button
              variant="ghost"
              size="icon"
              aria-label="返回新标签页"
              onClick={() => updateActiveView({ type: "start" })}
              className="size-9 rounded-full"
            >
              <HugeiconsIcon
                icon={ArrowLeft01Icon}
                size={16}
                aria-hidden="true"
              />
            </Button>
            <p className="min-w-0 flex-1 truncate px-1 text-sm font-medium">
              {view.type === "file" ? basename(view.path) : viewTitle(view)}
            </p>
          </div>
        )}

        {hostError ? (
          <p role="alert" className="px-3 py-1 text-xs text-destructive">
            {hostError}
          </p>
        ) : null}
        <div className="@container min-h-0 flex-1 overflow-hidden">
          {view.type === "start" ? (
            <StartPage
              sites={sites}
              onOpenChanges={() => updateActiveView({ type: "changes" })}
              onOpenFiles={() => updateActiveView({ type: "files" })}
              onNewTab={addTab}
              onOpenSite={openSite}
            />
          ) : view.type === "page" ? (
            <PageView url={view.url} />
          ) : view.type === "files" ? (
            <FilesView
              backend={backend}
              scope={scope}
              onOpenFile={(path) => updateActiveView({ type: "file", path })}
            />
          ) : view.type === "file" ? (
            <FileView backend={backend} scope={scope} path={view.path} />
          ) : view.type === "changes" ? (
            <ChangesView backend={backend} scope={scope} />
          ) : null}
          {tabs.map((tab) =>
            tab.view.type === "agent-debug" ? (
              <div
                key={tab.id}
                role="tabpanel"
                aria-label={viewTitle(tab.view)}
                className={tab.id === activeId ? "h-full min-h-0" : "hidden"}
              >
                <ChatScreen
                  models={models}
                  threadId={`agent-test:${tab.view.agentId}`}
                  suggestions={DEBUG_SUGGESTIONS}
                />
              </div>
            ) : null
          )}
        </div>
      </div>
    </motion.aside>
  )
}
