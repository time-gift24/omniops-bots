import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  BotIcon,
  Folder01Icon,
} from "@hugeicons-pro/core-stroke-rounded";
import { defaultThreadRegistry } from "@/chat/react";
import { ChatScreen } from "@/components/chat/chat-screen";
import { AgentBuilder } from "@/components/premium/agent-builder/agent-builder";
import {
  type AgentConfiguration,
  DEFAULT_AGENT,
} from "@/components/premium/agent-builder/agent-builder-data";
import {
  defaultSections,
  SidebarRail,
} from "@/components/premium/sidebar-blocks/sidebar-rail";
import { Button } from "@/components/ui/button";
import { WorkspacePanel } from "@/components/workspace/workspace-panel";
import { WorkspacePicker } from "@/components/workspace/workspace-picker";
import { createWorkspaceStore } from "@/workspace/store";

type AgentEntry = { id: string; configuration: AgentConfiguration };

const INITIAL_AGENTS: readonly AgentEntry[] = [
  { id: "customer-support", configuration: DEFAULT_AGENT },
  {
    id: "weekly-data-report",
    configuration: {
      name: "数据周报",
      description: "汇总业务数据，生成每周报告。",
      instructions:
        "你是数据分析助手。每周一汇总上周的核心业务指标，通过只读查询核实数据，引用指标字典中的口径。产出结构化的周报：亮点、异常、下周关注点。",
      model: "reasoning",
      mcpServerIds: ["database", "feishu"],
      toolIds: ["search"],
      skillIds: ["weekly-report"],
      requireApproval: false,
    },
  },
];

type View = { kind: "chat" } | { kind: "agent"; agentId: string };

export function App() {
  const [store] = useState(() => createWorkspaceStore(defaultThreadRegistry));
  const state = useSyncExternalStore(
    store.subscribe,
    store.getState,
    store.getState,
  );
  const [picker, setPicker] = useState<"add" | "choose" | null>(null);
  const [agents, setAgents] = useState<readonly AgentEntry[]>(INITIAL_AGENTS);
  const [view, setView] = useState<View>({ kind: "chat" });
  const contentRef = useRef<HTMLDivElement>(null);
  const lifetime = useRef({ version: 0 });
  useEffect(() => {
    const lifecycle = lifetime.current;
    const current = ++lifecycle.version;
    return () => {
      // StrictMode and Fast Refresh reconnect before this microtask runs.
      queueMicrotask(() => {
        if (current === lifecycle.version) store.dispose();
      });
    };
  }, [store]);
  const activeSession = state.sessions.find(
    (session) => session.id === state.activeSessionId,
  );
  const activeWorkspace = state.workspaces.find(
    (workspace) => workspace.id === activeSession?.workspaceId,
  );
  const activeAgent =
    view.kind === "agent"
      ? agents.find((agent) => agent.id === view.agentId)
      : undefined;
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
  };
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
                      (!session.blank || session.id === state.activeSessionId),
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
                  close();
                  contentRef.current?.focus({ preventScroll: true });
                }}
              />
            ),
          }
        : section,
    ),
    agentSection,
    ...defaultSections.slice(1),
  ];

  return (
    <>
      <SidebarRail
        workspaceName="Cognacta"
        workspaceHeader={null}
        contentClassName="p-0 sm:p-0"
        sections={sections}
        createLabel="新会话"
        onCreate={() => {
          setView({ kind: "chat" });
          if (!store.startSession()) setPicker("choose");
        }}
        onItemSelect={(item, section) => {
          if (section.id === "agents") {
            setView({ kind: "agent", agentId: item.id.slice("agent:".length) });
            return;
          }
          if (section.id !== "workspace") return;
          setView({ kind: "chat" });
          if (item.id.startsWith("workspace:"))
            store.startSession(item.id.slice("workspace:".length));
          else store.selectSession(item.id);
        }}
      >
        <div
          ref={contentRef}
          tabIndex={-1}
          className="h-full min-h-0 outline-none"
        >
          {view.kind === "agent" && activeAgent ? (
            <AgentBuilder
              key={activeAgent.id}
              initialConfiguration={activeAgent.configuration}
              threadId={`agent-test:${activeAgent.id}`}
              onSave={(configuration) =>
                setAgents((current) =>
                  current.map((agent) =>
                    agent.id === activeAgent.id
                      ? { ...agent, configuration }
                      : agent,
                  ),
                )
              }
            />
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
      </SidebarRail>
      <WorkspacePicker
        key={picker ?? "closed"}
        open={picker !== null}
        onOpenChange={(open) => {
          if (!open) setPicker(null);
        }}
        workspaces={state.workspaces}
        addOnly={picker === "add"}
        onPick={(id) => store.startSession(id)}
        onAdd={(path) => store.startSession(store.addWorkspace(path).id)}
        fallbackFocusRef={contentRef}
      />
    </>
  );
}

export default App;
