import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Folder01Icon } from "@hugeicons-pro/core-stroke-rounded";
import { defaultThreadRegistry } from "@/chat/react";
import { ChatScreen } from "@/components/chat/chat-screen";
import {
  defaultSections,
  SidebarRail,
} from "@/components/premium/sidebar-blocks/sidebar-rail";
import { Button } from "@/components/ui/button";
import { WorkspacePanel } from "@/components/workspace/workspace-panel";
import { WorkspacePicker } from "@/components/workspace/workspace-picker";
import { createWorkspaceStore } from "@/workspace/store";

export function App() {
  const [store] = useState(() => createWorkspaceStore(defaultThreadRegistry));
  const state = useSyncExternalStore(
    store.subscribe,
    store.getState,
    store.getState,
  );
  const [picker, setPicker] = useState<"add" | "choose" | null>(null);
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
  const sections = defaultSections.map((section) =>
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
  );

  return (
    <>
      <SidebarRail
        workspaceName="Cognacta"
        workspaceHeader={null}
        contentClassName="p-0 sm:p-0"
        sections={sections}
        createLabel="新会话"
        onCreate={() => {
          if (!store.startSession()) setPicker("choose");
        }}
        onItemSelect={(item, section) => {
          if (section.id !== "workspace") return;
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
          {activeSession && activeWorkspace ? (
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
