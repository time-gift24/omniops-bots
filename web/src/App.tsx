import {
  Component,
  lazy,
  Suspense,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  BotIcon,
  Folder01Icon,
  PackageIcon,
  PanelRightIcon,
  Search01Icon,
} from "@hugeicons-pro/core-stroke-rounded"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { defaultThreadRegistry } from "@/chat/react"
import { ChatScreen } from "@/components/chat/chat-screen"
import {
  type AgentConfiguration,
  DEFAULT_AGENT,
} from "@/components/premium/agent-builder/agent-builder-data"
import { MorphicTooltip } from "@/components/premium/morphic-tooltip/morphic-tooltip"
import {
  defaultSections,
  SidebarRail,
} from "@/components/premium/sidebar-blocks/sidebar-rail"
import { Button } from "@/components/ui/button"
import { Breadcrumbs } from "@/components/ui/breadcrumbs"
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import {
  WorkbenchPanel,
  type WorkbenchHandle,
} from "@/components/workbench/workbench"
import { WorkspacePanel } from "@/components/workspace/workspace-panel"
import { WorkspacePicker } from "@/components/workspace/workspace-picker"
import { EASE_OUT } from "@/lib/ease"
import { createMockWorkbenchBackend } from "@/workbench/mock-backend"
import { createWorkspaceStore } from "@/workspace/store"
import { ThemePicker } from "@/components/theme-picker"
import { DEMO_SKILLS } from "@/skills/data"

const AgentBuilder = lazy(() =>
  import("@/components/premium/agent-builder/agent-builder").then((module) => ({
    default: module.AgentBuilder,
  }))
)
const SkillScreen = lazy(() =>
  import("@/components/skills/skill-screen").then((module) => ({
    default: module.SkillScreen,
  }))
)

class PageLoadBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  render() {
    if (!this.state.failed) return this.props.children
    return (
      <div
        role="alert"
        className="grid h-full place-content-center gap-3 px-6 text-center"
      >
        <p className="text-sm">页面加载失败，请稍后刷新重试。</p>
        <p className="text-xs text-muted-foreground">
          刷新会清空未保存的草稿，请先切换栏目保存。
        </p>
        <Button variant="outline" onClick={() => window.location.reload()}>
          刷新页面
        </Button>
      </div>
    )
  }
}

type AgentEntry = {
  id: string
  configuration: AgentConfiguration
  draft?: AgentConfiguration
}

const INITIAL_AGENTS: readonly AgentEntry[] = [
  { id: "customer-support", configuration: DEFAULT_AGENT },
  {
    id: "weekly-data-report",
    configuration: {
      name: "数据周报",
      description: "汇总业务数据，生成每周报告。",
      instructions:
        "你是数据分析助手。每周一汇总上周的核心业务指标，通过只读查询核实数据，引用指标字典中的口径。产出结构化的周报：亮点、异常、下周关注点。",
      mcpServerIds: ["database", "feishu"],
      toolIds: ["search"],
      skillIds: ["weekly-report"],
      requireApproval: false,
    },
  },
]

type View =
  | { kind: "chat" }
  | { kind: "agent"; agentId: string }
  | { kind: "skill" }
  | { kind: "page"; sectionId: string; itemId: string }

export function App() {
  const [store] = useState(() => createWorkspaceStore(defaultThreadRegistry))
  const state = useSyncExternalStore(
    store.subscribe,
    store.getState,
    store.getState
  )
  const [picker, setPicker] = useState<"add" | "choose" | null>(null)
  const [skillSearchOpen, setSkillSearchOpen] = useState(false)
  const [agents, setAgents] = useState<readonly AgentEntry[]>(INITIAL_AGENTS)
  const [view, setView] = useState<View>({ kind: "chat" })
  const [agentToolbarTarget, setAgentToolbarTarget] =
    useState<HTMLDivElement | null>(null)
  const [openedSkillId, setOpenedSkillId] = useState<string | null>(null)
  const [workbenchOpen, setWorkbenchOpen] = useState(true)
  // 后端接入时替换为真实实现，UI 只依赖 WorkbenchBackend 接口。
  const [workbenchBackend] = useState(() => createMockWorkbenchBackend())
  const workbenchId = useId()
  const workbenchRef = useRef<WorkbenchHandle>(null)
  const workbenchToggleRef = useRef<HTMLButtonElement>(null)
  const reduce = useReducedMotion()
  const contentRef = useRef<HTMLDivElement>(null)
  const lifetime = useRef({ version: 0 })
  useEffect(() => {
    const lifecycle = lifetime.current
    const current = ++lifecycle.version
    return () => {
      // StrictMode and Fast Refresh reconnect before this microtask runs.
      queueMicrotask(() => {
        if (current === lifecycle.version) store.dispose()
      })
    }
  }, [store])
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (
        event.defaultPrevented ||
        event.repeat ||
        !(event.metaKey || event.ctrlKey) ||
        event.key.toLowerCase() !== "j"
      )
        return
      event.preventDefault()
      setWorkbenchOpen((open) => !open)
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])
  const wasWorkbenchOpen = useRef(workbenchOpen)
  useEffect(() => {
    // 面板从打开变为关闭时，焦点还给悬浮开关。
    if (wasWorkbenchOpen.current && !workbenchOpen)
      workbenchToggleRef.current?.focus({ preventScroll: true })
    wasWorkbenchOpen.current = workbenchOpen
  }, [workbenchOpen])
  const activeSession = state.sessions.find(
    (session) => session.id === state.activeSessionId
  )
  const activeWorkspace = state.workspaces.find(
    (workspace) => workspace.id === activeSession?.workspaceId
  )
  const activeAgent =
    view.kind === "agent"
      ? agents.find((agent) => agent.id === view.agentId)
      : undefined
  const activeSkill = DEMO_SKILLS.find((skill) => skill.id === openedSkillId)
  const activeSectionId =
    view.kind === "agent"
      ? "agents"
      : view.kind === "skill"
        ? "skills"
        : view.kind === "page"
          ? view.sectionId
          : "workspace"
  const activeItemId =
    view.kind === "agent"
      ? `agent:${view.agentId}`
      : view.kind === "skill"
        ? `skill:${openedSkillId}`
        : view.kind === "page"
          ? view.itemId
          : (activeSession?.id ?? "")
  const agentSection = {
    id: "agents",
    label: "Agent",
    icon: BotIcon,
    groups: [
      {
        label: "我的 Agent",
        items: agents.map((agent) => ({
          id: `agent:${agent.id}`,
          label: agent.configuration.name,
          icon: BotIcon,
        })),
      },
    ],
  }
  const sections = [
    ...defaultSections.slice(0, 1).map((section) =>
      section.id === "workspace"
        ? {
            ...section,
            groups: state.workspaces.map((workspace) => ({
              label: workspace.name,
              items: [
                {
                  id: `workspace:${workspace.id}`,
                  label: workspace.name,
                  icon: Folder01Icon,
                },
                ...state.sessions
                  .filter(
                    (session) =>
                      session.workspaceId === workspace.id &&
                      (!session.blank || session.id === state.activeSessionId)
                  )
                  .map((session) => ({
                    id: session.id,
                    label: session.blank ? "新会话" : session.title,
                  })),
              ],
            })),
            renderContent: (close: () => void) => (
              <WorkspacePanel
                state={state}
                store={store}
                onAdd={() => setPicker("add")}
                onNavigate={() => {
                  setView({ kind: "chat" })
                  close()
                  contentRef.current?.focus({ preventScroll: true })
                }}
              />
            ),
          }
        : section
    ),
    agentSection,
    {
      id: "skills",
      label: "技能",
      icon: PackageIcon,
      groups: [
        {
          label: "我的技能",
          action: (
            <MorphicTooltip content="搜索技能" side="bottom">
              <Button
                variant="ghost"
                size="icon"
                aria-label="搜索技能"
                aria-haspopup="dialog"
                onClick={() => setSkillSearchOpen(true)}
                className="size-7 rounded-full text-muted-foreground hover:text-foreground"
              >
                <HugeiconsIcon
                  icon={Search01Icon}
                  aria-hidden="true"
                  size={14}
                />
              </Button>
            </MorphicTooltip>
          ),
          items: DEMO_SKILLS.map((skill) => ({
            id: `skill:${skill.id}`,
            label: skill.name,
            icon: PackageIcon,
          })),
        },
      ],
    },
    ...defaultSections.slice(1),
  ]
  const activePage = sections
    .find((section) => section.id === activeSectionId)
    ?.groups.flatMap((group) => group.items)
    .find((item) => item.id === activeItemId)

  return (
    <>
      <SidebarRail
        workspaceName="Cognacta"
        railActions={<ThemePicker />}
        activeSectionId={activeSectionId}
        activeItemId={activeItemId}
        onSectionSelect={(section) => {
          if (section.id === "workspace") setView({ kind: "chat" })
        }}
        workspaceHeaderClassName={workbenchOpen ? undefined : "pr-10"}
        workspaceHeader={
          view.kind === "agent" ? (
            <div
              ref={setAgentToolbarTarget}
              className="@container/agent-header flex min-w-0 flex-1"
            />
          ) : view.kind === "skill" ? (
            <Breadcrumbs items={["技能", activeSkill?.name ?? "技能"]} />
          ) : view.kind === "chat" ? (
            <Breadcrumbs
              items={[
                "工作区",
                ...(activeWorkspace && activeSession
                  ? [
                      activeWorkspace.name,
                      activeSession.blank ? "新会话" : activeSession.title,
                    ]
                  : []),
              ]}
            />
          ) : undefined
        }
        endPanel={
          <WorkbenchPanel
            ref={workbenchRef}
            id={workbenchId}
            open={workbenchOpen}
            backend={workbenchBackend}
            onClose={() => setWorkbenchOpen(false)}
          />
        }
        headerOverlay={
          <AnimatePresence>
            {workbenchOpen ? null : (
              <motion.div
                initial={reduce ? false : { opacity: 0, scale: 0.92 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.92 }}
                transition={
                  reduce ? { duration: 0 } : { duration: 0.2, ease: EASE_OUT }
                }
                className="absolute top-1.5 right-3 z-30"
              >
                <MorphicTooltip content="打开工作台（⌘J）" side="left">
                  <Button
                    ref={workbenchToggleRef}
                    variant="ghost"
                    size="icon"
                    aria-label="打开工作台"
                    aria-expanded={false}
                    aria-controls={workbenchId}
                    onClick={() => setWorkbenchOpen(true)}
                    className="size-9 translate-x-1 rounded-full border border-border bg-popover/80 opacity-60 backdrop-blur-md transition-[opacity,translate] duration-200 ease-out hover:translate-x-0 hover:opacity-100 focus-visible:translate-x-0 focus-visible:opacity-100 motion-reduce:transition-none"
                  >
                    <HugeiconsIcon
                      icon={PanelRightIcon}
                      aria-hidden="true"
                      size={16}
                    />
                  </Button>
                </MorphicTooltip>
              </motion.div>
            )}
          </AnimatePresence>
        }
        contentClassName="p-0 sm:p-0"
        sections={sections}
        createLabel="新会话"
        onCreate={() => {
          setView({ kind: "chat" })
          if (!store.startSession()) setPicker("choose")
        }}
        onItemSelect={(item, section) => {
          if (section.id === "skills") {
            setOpenedSkillId(item.id.slice("skill:".length))
            setView({ kind: "skill" })
            return
          }
          if (section.id === "agents") {
            // 页面切换保留导航焦点，不触发工作台关闭后的焦点回移。
            wasWorkbenchOpen.current = false
            setWorkbenchOpen(false)
            setView({ kind: "agent", agentId: item.id.slice("agent:".length) })
            return
          }
          if (section.id !== "workspace") {
            setView({ kind: "page", sectionId: section.id, itemId: item.id })
            return
          }
          setView({ kind: "chat" })
          if (item.id.startsWith("workspace:"))
            store.startSession(item.id.slice("workspace:".length))
          else store.selectSession(item.id)
        }}
      >
        <div className="h-full min-h-0">
          <div
            ref={contentRef}
            tabIndex={-1}
            className="h-full min-h-0 outline-none"
          >
            {openedSkillId ? (
              <div
                className={view.kind === "skill" ? "h-full min-h-0" : "hidden"}
              >
                <PageLoadBoundary>
                  <Suspense
                    fallback={
                      <p
                        role="status"
                        className="p-6 text-sm text-muted-foreground"
                      >
                        正在加载技能…
                      </p>
                    }
                  >
                    <SkillScreen
                      skillId={openedSkillId}
                      active={view.kind === "skill"}
                    />
                  </Suspense>
                </PageLoadBoundary>
              </div>
            ) : null}
            {view.kind === "page" ? (
              <div className="grid h-full place-content-center gap-3 px-6 text-center">
                <h1 className="text-xl font-medium">{activePage?.label}</h1>
                <p className="text-sm text-muted-foreground">
                  项目、页面和资料，触手可及。
                </p>
              </div>
            ) : view.kind === "skill" ? null : view.kind === "agent" &&
              activeAgent ? (
              <PageLoadBoundary>
                <Suspense
                  fallback={
                    <p
                      role="status"
                      className="p-6 text-sm text-muted-foreground"
                    >
                      正在加载Agent…
                    </p>
                  }
                >
                  <AgentBuilder
                    key={activeAgent.id}
                    initialConfiguration={activeAgent.configuration}
                    initialDraft={activeAgent.draft}
                    onDraftChange={(draft) =>
                      setAgents((current) =>
                        current.map((agent) =>
                          agent.id === activeAgent.id
                            ? { ...agent, draft }
                            : agent
                        )
                      )
                    }
                    toolbarTarget={agentToolbarTarget}
                    onDebug={() => {
                      workbenchRef.current?.openAgentDebug(
                        activeAgent.id,
                        activeAgent.configuration.name
                      )
                      setWorkbenchOpen(true)
                    }}
                    onSave={(configuration) =>
                      setAgents((current) =>
                        current.map((agent) =>
                          agent.id === activeAgent.id
                            ? { ...agent, configuration, draft: undefined }
                            : agent
                        )
                      )
                    }
                  />
                </Suspense>
              </PageLoadBoundary>
            ) : activeSession && activeWorkspace ? (
              <ChatScreen
                key={activeSession.id}
                threadId={activeSession.id}
                workspaceName={activeWorkspace.name}
                onChooseWorkspace={() => setPicker("choose")}
              />
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
                <h1 className="text-2xl font-medium tracking-tight">
                  开始一段新对话
                </h1>
                <p className="max-w-sm text-sm leading-relaxed text-muted-foreground">
                  选择一个工作区，让对话围绕同一项工作展开。
                </p>
                <Button
                  onClick={() => setPicker("choose")}
                  className="h-9 gap-2 rounded-full px-4"
                >
                  <HugeiconsIcon
                    icon={Folder01Icon}
                    size={16}
                    aria-hidden="true"
                  />
                  选择工作区
                </Button>
              </div>
            )}
          </div>
        </div>
      </SidebarRail>
      <CommandDialog
        open={skillSearchOpen}
        onOpenChange={setSkillSearchOpen}
        title="搜索技能"
        description="搜索并打开技能"
        fallbackFocusRef={contentRef}
      >
        <CommandInput
          placeholder="查找技能…"
          wrapperClassName="h-12 rounded-none border-0 border-b border-border bg-transparent px-4 focus-within:ring-0"
        />
        <CommandList className="max-h-[min(24rem,60dvh)]">
          <CommandEmpty>没有找到技能。</CommandEmpty>
          <CommandGroup heading="我的技能">
            {DEMO_SKILLS.map((skill) => (
              <CommandItem
                key={skill.id}
                value={`${skill.name} ${skill.description}`}
                onSelect={() => {
                  setOpenedSkillId(skill.id)
                  setView({ kind: "skill" })
                  setSkillSearchOpen(false)
                }}
              >
                <HugeiconsIcon
                  icon={PackageIcon}
                  aria-hidden="true"
                  size={16}
                  strokeWidth={1.7}
                  className="text-muted-foreground"
                />
                <span className="truncate">{skill.name}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </CommandDialog>
      <WorkspacePicker
        key={picker ?? "closed"}
        open={picker !== null}
        onOpenChange={(open) => {
          if (!open) setPicker(null)
        }}
        workspaces={state.workspaces}
        addOnly={picker === "add"}
        onPick={(id) => store.startSession(id)}
        onAdd={(path) => store.startSession(store.addWorkspace(path).id)}
        fallbackFocusRef={contentRef}
      />
    </>
  )
}

export default App
