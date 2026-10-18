import type {
  ChangeSet,
  RecommendedSite,
  WorkspaceFileEntry,
} from "@/workbench/backend"

/** 示例数据：推荐位在接入真实浏览历史后替换。 */
export const RECOMMENDED_SITES: readonly RecommendedSite[] = [
  { name: "Cognacta 运维端", url: "ops.cognacta.cn", initial: "C" },
  { name: "Vite 开发服务", url: "127.0.0.1:5173", initial: "V" },
  { name: "Microsoft 必应", url: "bing.com", initial: "必" },
  { name: "Pydantic 文档", url: "docs.pydantic.dev", initial: "P" },
]

/** 示例数据：文件列表在接入工作区目录后替换。 */
export const WORKSPACE_FILES: readonly WorkspaceFileEntry[] = [
  { name: "App.tsx", path: "web/src/App.tsx", size: "8.1 KB" },
  {
    name: "chat-screen.tsx",
    path: "web/src/components/chat/chat-screen.tsx",
    size: "5.4 KB",
  },
  { name: "index.css", path: "web/src/index.css", size: "12.6 KB" },
  { name: "Cargo.toml", path: "Cargo.toml", size: "2.3 KB" },
  { name: "lib.rs", path: "crates/cognacta-core/src/lib.rs", size: "4.9 KB" },
  { name: "AGENTS.md", path: "AGENTS.md", size: "9.7 KB" },
]

/** 示例内容：文件预览排版占位。 */
export const MOCK_FILE_LINES: readonly string[] = [
  'import { useThreadState, useThreadStore } from "@/chat/react";',
  'import { ChatComposer } from "@/components/chat/chat-composer";',
  'import { ChatThread } from "@/components/chat/chat-thread";',
  "",
  "export function ChatScreen({ threadId }: { threadId: string }) {",
  "  const store = useThreadStore(threadId);",
  "  const state = useThreadState(store);",
  "  const empty = state.messages.length === 0;",
  "",
  "  return (",
  '    <div className="flex h-full min-h-0 flex-col">',
  "      {empty ? (",
  "        <EmptyState onSend={store.send} />",
  "      ) : (",
  "        <ChatThread store={store} />",
  "      )}",
  "      <ChatComposer store={store} />",
  "    </div>",
  "  );",
  "}",
]

/** 示例数据：变更摘要在接入会话 diff 后替换。 */
export const CHANGE_SET: ChangeSet = {
  fileCount: 4,
  added: 51,
  removed: 6,
  files: [
    { path: "src-tauri/Cargo.toml", added: 12, removed: 2 },
    { path: "src-tauri/build.rs", added: 28, removed: 1 },
    { path: ".gitignore", added: 1, removed: 0 },
    { path: "src-tauri/tauri.conf.json", added: 10, removed: 3 },
  ],
}
