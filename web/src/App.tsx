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
import { useAppDependencies } from "@/app/dependencies"
import type { AgentEntry, AgentResources } from "@/agents/source"
import type { Skill } from "@/skills/source"
import type { ModelChoice } from "@/models/source"
import { useBackendData } from "@/components/workbench/use-backend-data"
import { ChatScreen } from "@/components/chat/chat-screen"
import { TaskBanner } from "@/components/desktop/task-banner"
import { MorphicTooltip } from "@/components/premium/morphic-tooltip/morphic-tooltip"
import {
  defaultSections,
  SidebarRail,
  type SidebarRailItem,
  type SidebarRailSection,
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
import { ThemePicker } from "@/components/theme-picker"

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

type View =
  | { kind: "chat" }
  | { kind: "agent"; agentId: string }
  | { kind: "skill" }
  | { kind: "page"; sectionId: string; itemId: string }
  | { kind: "section"; sectionId: string; workspaceId?: string }

export function App() {
  const dependencies = useAppDependencies()
  const [attempt, setAttempt] = useState(0)
  const agents = useBackendData(
    attempt,
    () => dependencies.agents.load(),
    dependencies.agents
  )
  const skills = useBackendData(
    attempt,
    () => dependencies.skills.list(),
    dependencies.skills
  )
  const models = useBackendData(
    attempt,
    () => dependencies.models.list(),
    dependencies.models
  )
  if (
    agents.status === "error" ||
    skills.status === "error" ||
    models.status === "error"
  ) {
    return (
      <div
        role="alert"
        className="grid h-full place-content-center gap-3 text-center"
      >
        <p>资源加载失败，请重试。</p>
        <Button
          variant="outline"
          onClick={() => setAttempt((current) => current + 1)}
        >
          重试
        </Button>
      </div>
    )
  }
  if (
    agents.status !== "ready" ||
    skills.status !== "ready" ||
    models.status !== "ready"
  ) {
    return (
      <p role="status" className="p-6 text-sm text-muted-foreground">
        正在加载工作区…
      </p>
    )
  }
  return (
    <WorkspaceApp
      initialAgents={agents.data.agents}
      resources={agents.data.resources}
      skills={skills.data}
      models={models.data}
    />
  )
}

function WorkspaceApp({
  initialAgents,
  resources,
  skills,
  models,
}: {
  initialAgents: readonly AgentEntry[]
  resources: AgentResources
  skills: readonly Skill[]
  models: readonly ModelChoice[]
}) {
  const {
    workspaces: store,
    workbench: workbenchBackend,
    agents: agentSource,
    desktop,
    threads,
  } = useAppDependencies()
  const desktopState = useSyncExternalStore(
    desktop.subscribe,
    desktop.getState,
    desktop.getState
  )
  const state = useSyncExternalStore(
    store.subscribe,
    store.getState,
    store.getState
  )
  const [picker, setPicker] = useState<"add" | "choose" | null>(null)
  const [skillSearchOpen, setSkillSearchOpen] = useState(false)
  const [agents, setAgents] = useState<readonly AgentEntry[]>(initialAgents)
  const [openedAgentId, setOpenedAgentId] = useState<string | null>(null)
  const [view, setView] = useState<View>({ kind: "chat" })
  const [agentToolbarTarget, setAgentToolbarTarget] =
    useState<HTMLDivElement | null>(null)
  const [skillToolbarTarget, setSkillToolbarTarget] =
    useState<HTMLDivElement | null>(null)
  const [openedSkillId, setOpenedSkillId] = useState<string | null>(null)
  const [workbenchOpen, setWorkbenchOpen] = useState(true)
  const [navigationExpanded, setNavigationExpanded] = useState(true)
  const [compactWindow, setCompactWindow] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(width < 1100px)").matches
  )
  const workbenchId = useId()
  const workbenchRef = useRef<WorkbenchHandle>(null)
  const workbenchToggleRef = useRef<HTMLButtonElement>(null)
  const reduce = useReducedMotion()
  const contentRef = useRef<HTMLDivElement>(null)
  const lifetime = useRef({ version: 0 })
  useEffect(() => {
    const media = window.matchMedia("(width < 1100px)")
    const onChange = () => setCompactWindow(media.matches)
    media.addEventListener("change", onChange)
    return () => media.removeEventListener("change", onChange)
  }, [])
  useEffect(() => {
    let previous = desktop.getState().browserRequest
    if (previous > 0) workbenchRef.current?.openBrowser()
    return desktop.subscribe(() => {
      const next = desktop.getState().browserRequest
      if (next === previous) return
      previous = next
      workbenchRef.current?.openBrowser()
      setWorkbenchOpen(true)
    })
  }, [desktop])
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
  const activeAgent = agents.find((agent) => agent.id === openedAgentId)
  const activeSkill = skills.find((skill) => skill.id === openedSkillId)
  const activeSectionId =
    view.kind === "agent"
      ? "agents"
      : view.kind === "skill"
        ? "skills"
        : view.kind === "page" || view.kind === "section"
          ? view.sectionId
          : "workspace"
  const activeItemId =
    view.kind === "agent"
      ? `agent:${view.agentId}`
      : view.kind === "skill"
        ? `skill:${openedSkillId}`
        : view.kind === "page"
          ? view.itemId
          : view.kind === "section"
            ? ""
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
                state={
                  view.kind === "section"
                    ? { ...state, activeSessionId: null }
                    : state
                }
                store={store}
                onAdd={() => setPicker("add")}
                onCreate={(workspaceId) => {
                  startSession(workspaceId)
                  close()
                }}
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
          items: skills.map((skill) => ({
            id: `skill:${skill.id}`,
            label: skill.name,
            icon: PackageIcon,
          })),
        },
      ],
    },
  ]
  const activeSection = sections.find(
    (section) => section.id === activeSectionId
  )
  const activePage = activeSection?.groups
    .flatMap((group) => group.items)
    .find((item) => item.id === activeItemId)
  const overviewWorkspace =
    view.kind === "section"
      ? state.workspaces.find((workspace) => workspace.id === view.workspaceId)
      : undefined
  const overviewItems: readonly SidebarRailItem[] =
    view.kind === "section" && view.sectionId === "workspace"
      ? overviewWorkspace
        ? state.sessions
            .filter((session) => session.workspaceId === overviewWorkspace.id)
            .map((session) => ({
              id: session.id,
              label: session.blank ? "新会话" : session.title,
            }))
        : state.workspaces.map((workspace) => ({
            id: `workspace:${workspace.id}`,
            label: workspace.name,
          }))
      : (activeSection?.groups.flatMap((group) => group.items) ?? [])

  function openSection(sectionId: string, workspaceId?: string) {
    contentRef.current?.focus({ preventScroll: true })
    setView({ kind: "section", sectionId, workspaceId })
  }

  function startSession(workspaceId?: string) {
    setView({ kind: "chat" })
    contentRef.current?.focus({ preventScroll: true })
    if (!store.startSession(workspaceId)) setPicker("choose")
  }

  function returnToTask() {
    const task = desktop.getState().task
    if (!task) return
    if (task.threadId.startsWith("agent-test:")) {
      const agentId = task.threadId.slice("agent-test:".length)
      const agent = agents.find((entry) => entry.id === agentId)
      if (!agent) return
      setOpenedAgentId(agentId)
      setView({ kind: "agent", agentId })
      workbenchRef.current?.openAgentDebug(agentId, agent.configuration.name)
      setWorkbenchOpen(true)
    } else {
      store.selectSession(task.threadId)
      setView({ kind: "chat" })
      if (compactWindow) setWorkbenchOpen(false)
    }
  }

  function selectItem(item: SidebarRailItem, section: SidebarRailSection) {
    if (section.id === "skills") {
      setOpenedSkillId(item.id.slice("skill:".length))
      setView({ kind: "skill" })
      return
    }
    if (section.id === "agents") {
      wasWorkbenchOpen.current = false
      setWorkbenchOpen(false)
      const agentId = item.id.slice("agent:".length)
      setOpenedAgentId(agentId)
      setView({ kind: "agent", agentId })
      return
    }
    if (section.id !== "workspace") {
      setView({ kind: "page", sectionId: section.id, itemId: item.id })
      return
    }
    if (item.id.startsWith("workspace:"))
      startSession(item.id.slice("workspace:".length))
    else {
      setView({ kind: "chat" })
      store.selectSession(item.id)
    }
  }

  return (
    <>
      <SidebarRail
        workspaceName="omniops-bots"
        expanded={navigationExpanded && (!compactWindow || !workbenchOpen)}
        onExpandedChange={(expanded) => {
          setNavigationExpanded(expanded)
          if (expanded && compactWindow) setWorkbenchOpen(false)
        }}
        railActions={<ThemePicker />}
        activeSectionId={activeSectionId}
        activeItemId={activeItemId}
        onSectionSelect={(section) => {
          if (compactWindow) setWorkbenchOpen(false)
          if (section.id === "workspace") setView({ kind: "chat" })
        }}
        onParentSelect={(section) => openSection(section.id)}
        workspaceHeaderClassName={workbenchOpen ? undefined : "pr-10"}
        workspaceHeader={
          view.kind === "agent" ? (
            <div
              ref={setAgentToolbarTarget}
              className="@container/agent-header flex min-w-0 flex-1"
            />
          ) : view.kind === "skill" ? (
            <div className="@container/skill-header flex min-w-0 flex-1 items-center gap-2">
              <Breadcrumbs
                items={[
                  { label: "技能", onSelect: () => openSection("skills") },
                  { label: activeSkill?.name ?? "技能" },
                ]}
              />
              <div ref={setSkillToolbarTarget} className="ml-auto shrink-0" />
            </div>
          ) : view.kind === "chat" ? (
            <Breadcrumbs
              items={[
                { label: "工作区", onSelect: () => openSection("workspace") },
                ...(activeWorkspace && activeSession
                  ? [
                      {
                        label: activeWorkspace.name,
                        onSelect: () =>
                          openSection("workspace", activeWorkspace.id),
                      },
                      {
                        label: activeSession.blank
                          ? "新会话"
                          : activeSession.title,
                      },
                    ]
                  : []),
              ]}
            />
          ) : view.kind === "section" ? (
            <Breadcrumbs
              items={[
                {
                  label: activeSection?.label ?? "工作区",
                  onSelect: () => openSection(view.sectionId),
                },
                ...(overviewWorkspace
                  ? [{ label: overviewWorkspace.name }]
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
            scope={
              activeSession && activeWorkspace
                ? {
                    workspaceId: activeWorkspace.id,
                    workspacePath: activeWorkspace.path,
                    sessionId: activeSession.id,
                  }
                : null
            }
            models={models}
            onClose={() => setWorkbenchOpen(false)}
            onReturnToApproval={returnToTask}
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
        onCreate={() => startSession()}
        onItemSelect={selectItem}
      >
        <div className="flex h-full min-h-0 flex-col">
          {desktopState.task && (
            <TaskBanner
              task={desktopState.task}
              simulated={desktopState.simulated}
              onReturn={returnToTask}
              onStop={() => {
                const task = desktop.getState().task
                if (task) threads.get(task.threadId).stop()
              }}
            />
          )}
          <div
            ref={contentRef}
            tabIndex={-1}
            className="min-h-0 flex-1 outline-none"
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
                      skills={skills}
                      skillId={openedSkillId}
                      active={view.kind === "skill"}
                      toolbarTarget={
                        view.kind === "skill" ? skillToolbarTarget : null
                      }
                    />
                  </Suspense>
                </PageLoadBoundary>
              </div>
            ) : null}
            {activeAgent ? (
              <div
                className={view.kind === "agent" ? "h-full min-h-0" : "hidden"}
              >
                <PageLoadBoundary>
                  <Suspense
                    fallback={
                      <p
                        role="status"
                        className="p-6 text-sm text-muted-foreground"
                      >
                        正在加载 Agent…
                      </p>
                    }
                  >
                    <AgentBuilder
                      key={activeAgent.id}
                      initialConfiguration={activeAgent.configuration}
                      mcpServers={resources.mcpServers}
                      tools={resources.tools}
                      skills={resources.skills}
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
                      toolbarTarget={
                        view.kind === "agent" ? agentToolbarTarget : null
                      }
                      onBack={() => openSection("agents")}
                      onDebug={() => {
                        workbenchRef.current?.openAgentDebug(
                          activeAgent.id,
                          activeAgent.configuration.name
                        )
                        setWorkbenchOpen(true)
                      }}
                      onSave={async (configuration) => {
                        await agentSource.save(activeAgent.id, configuration)
                        setAgents((current) =>
                          current.map((agent) =>
                            agent.id === activeAgent.id
                              ? { ...agent, configuration, draft: undefined }
                              : agent
                          )
                        )
                      }}
                    />
                  </Suspense>
                </PageLoadBoundary>
              </div>
            ) : null}
            {view.kind === "section" ? (
              <section
                data-slot="navigation-overview"
                className="mx-auto w-full max-w-3xl px-6 py-8 sm:px-8"
              >
                <h1 className="text-2xl font-medium tracking-tight">
                  {overviewWorkspace?.name ?? activeSection?.label}
                </h1>
                {overviewItems.length ? (
                  <ul className="mt-6 space-y-1">
                    {overviewItems.map((item) => (
                      <li key={item.id}>
                        <Button
                          variant="ghost"
                          className="h-auto min-h-11 w-full justify-start rounded-full px-4 py-3 text-left font-normal"
                          onClick={() => {
                            if (!activeSection) return
                            if (
                              activeSection.id === "workspace" &&
                              item.id.startsWith("workspace:")
                            )
                              openSection(
                                "workspace",
                                item.id.slice("workspace:".length)
                              )
                            else selectItem(item, activeSection)
                          }}
                        >
                          <span className="truncate">{item.label}</span>
                        </Button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-6 text-sm text-muted-foreground">
                    暂无内容。
                  </p>
                )}
              </section>
            ) : view.kind === "page" ? (
              <div className="grid h-full place-content-center gap-3 px-6 text-center">
                <h1 className="text-xl font-medium">{activePage?.label}</h1>
                <p className="text-sm text-muted-foreground">
                  项目、页面和资料，触手可及。
                </p>
              </div>
            ) : view.kind === "skill" ||
              view.kind === "agent" ? null : activeSession &&
              activeWorkspace ? (
              <ChatScreen
                models={models}
                key={activeSession.id}
                threadId={activeSession.id}
                workspaceName={activeWorkspace.name}
                onChooseWorkspace={() => setPicker("choose")}
                suggestions={
                  desktopState.simulated
                    ? [
                        "打开内置浏览器，访问必应并输入 abcd，不提交搜索",
                        "帮我检查网页中的搜索框",
                        "总结一下这个仓库本周的变更",
                      ]
                    : undefined
                }
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
            {skills.map((skill) => (
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
        onPick={startSession}
        onAdd={(directory) => startSession(store.addWorkspace(directory).id)}
        fallbackFocusRef={contentRef}
      />
    </>
  )
}

export default App
