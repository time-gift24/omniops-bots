"use client";

import { memo, useEffect, useState } from "react";

import type { ThreadStore } from "@/chat/thread-store.ts";
import type { ChatMessageView } from "@/chat/fold.ts";
import { useThreadState } from "@/chat/react.ts";
import { MessageView } from "@/components/chat/message-view";
import { AIThinkingLoader } from "@/components/premium/ai-thinking-loader";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";

/** 卸载前为 index.css 的 chat-swap-out 动画预留的时间（ms）。 */
const LOADER_EXIT_MS = 220;

/** 过场与内容同格叠放，交叉淡入淡出时避免布局跳动。 */
function AssistantSlot({
  message,
  busy,
  onRetry,
  onEdit,
}: {
  message: ChatMessageView;
  busy: boolean;
  onRetry: () => void;
  onEdit?: (text: string) => void;
}) {
  const waiting =
    busy && message.state === "streaming" && message.parts.length === 0;

  // 在渲染期派生退场状态，避免内容到达时先卸载过场再挂回。
  const [exiting, setExiting] = useState(false);
  const [prevWaiting, setPrevWaiting] = useState(waiting);
  if (prevWaiting !== waiting) {
    setPrevWaiting(waiting);
    setExiting(!waiting);
  }
  useEffect(() => {
    if (!exiting) return;
    const timer = setTimeout(() => setExiting(false), LOADER_EXIT_MS);
    return () => clearTimeout(timer);
  }, [exiting]);

  return (
    <div className="grid">
      <div className="col-start-1 row-start-1 min-w-0">
        {!waiting && (
          <MessageView
            message={message}
            streaming={busy && message.state === "streaming"}
            onRetry={onRetry}
            onEdit={onEdit}
          />
        )}
      </div>
      {(waiting || exiting) && (
        <div
          className={`col-start-1 row-start-1${waiting ? "" : " chat-swap-out"}`}
          aria-hidden={!waiting}
        >
          <AIThinkingLoader
            variant="diamond"
            label="正在思考"
            paused={!waiting}
          />
        </div>
      )}
    </div>
  );
}

const ThreadMessage = memo(function ThreadMessage({
  message,
  streaming,
  store,
  onEdit,
}: {
  message: ChatMessageView;
  streaming: boolean;
  store: ThreadStore;
  onEdit?: (text: string) => void;
}) {
  const onRetry = () => store.retry(message.id);
  return (
    <MessageScrollerItem
      messageId={message.id}
      scrollAnchor={message.role === "user"}
    >
      {message.role === "assistant" ? (
        <AssistantSlot
          message={message}
          busy={streaming}
          onRetry={onRetry}
          onEdit={onEdit}
        />
      ) : (
        <MessageView
          message={message}
          streaming={false}
          onRetry={onRetry}
          onEdit={onEdit}
        />
      )}
    </MessageScrollerItem>
  );
});

export function ChatThread({
  store,
  onEditMessage,
}: {
  store: ThreadStore;
  onEditMessage?: (text: string) => void;
}) {
  const state = useThreadState(store);
  const busy = state.status === "submitted" || state.status === "streaming";

  return (
    <MessageScrollerProvider autoScroll scrollPreviousItemPeek={64}>
      <MessageScroller>
        <MessageScrollerViewport className="px-4 sm:px-8">
          <MessageScrollerContent
            aria-busy={busy}
            className="mx-auto w-full max-w-[736px] gap-8 px-4 py-6"
          >
            {state.messages.map((message) => (
              <ThreadMessage
                key={message.id}
                message={message}
                streaming={busy && message.state === "streaming"}
                store={store}
                onEdit={onEditMessage}
              />
            ))}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton />
      </MessageScroller>
    </MessageScrollerProvider>
  );
}
