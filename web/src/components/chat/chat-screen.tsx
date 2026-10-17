"use client";

import * as React from "react";

import { useThreadStore } from "@/chat/react.ts";
import { ChatComposer } from "@/components/chat/chat-composer";
import { ChatThread } from "@/components/chat/chat-thread";
import { TooltipProvider } from "@/components/ui/tooltip";

/** 本轮单线程界面固定使用一个 threadId；切换线程 UI 落地时状态层不变。 */
const MAIN_THREAD_ID = "main";

type EditRequest = { text: string; nonce: number };

export function ChatScreen() {
  const store = useThreadStore(MAIN_THREAD_ID);
  const [editRequest, setEditRequest] = React.useState<EditRequest | null>(null);

  return (
    <TooltipProvider>
      <div className="flex h-full min-h-0 flex-col">
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
