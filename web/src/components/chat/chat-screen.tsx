"use client";

import * as React from "react";

import { useThreadState, useThreadStore } from "@/chat/react.ts";
import { ChatComposer } from "@/components/chat/chat-composer";
import { ChatThread } from "@/components/chat/chat-thread";
import { TooltipProvider } from "@/components/ui/tooltip";

/** 本轮单线程界面固定使用一个 threadId；切换线程 UI 落地时状态层不变。 */
const MAIN_THREAD_ID = "main";

type EditRequest = { text: string; nonce: number };

export function ChatScreen({ agentName = "研发助手" }: { agentName?: string }) {
  const store = useThreadStore(MAIN_THREAD_ID);
  const state = useThreadState(store);
  const [editRequest, setEditRequest] = React.useState<EditRequest | null>(null);

  const model = state.metadata?.requestedModel;

  return (
    <TooltipProvider>
      <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-12 shrink-0 items-center justify-between px-2 sm:px-4">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-sm font-medium">{agentName}</span>
          <span className="truncate font-mono text-xs text-muted-foreground">
            {model ?? "pine-chat-latest"}
          </span>
        </div>
      </div>
      <div className="min-h-0 flex-1">
        <ChatThread
          store={store}
          onEditMessage={(text) =>
            setEditRequest({ text, nonce: Date.now() })
          }
        />
      </div>
      <div className="shrink-0 px-2 pb-2 sm:px-4 sm:pb-4">
        <ChatComposer
          key={editRequest?.nonce ?? "idle"}
          store={store}
          initialText={editRequest?.text}
          className="mx-auto max-w-[720px]"
        />
      </div>
      </div>
    </TooltipProvider>
  );
}
