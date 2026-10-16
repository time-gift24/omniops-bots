"use client";

import { useEffect, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Message01Icon } from "@hugeicons-pro/core-stroke-rounded";

import type { ThreadStore } from "@/chat/thread-store.ts";
import type { ChatMessageView } from "@/chat/fold.ts";
import { useThreadState } from "@/chat/react.ts";
import { MessageView } from "@/components/chat/message-view";
import { AIThinkingLoader } from "@/components/premium/ai-thinking-loader";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Button } from "@/components/ui/button";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";

const SUGGESTIONS = [
  "为什么这次构建这么慢？",
  "帮我排查一下昨天部署失败的原因",
  "总结一下这个仓库本周的变更",
];

/** 过场退场时长（ms），与 index.css 的 chat-swap-out 一致。 */
const LOADER_EXIT_MS = 220;

/**
 * assistant 消息位：等待首个内容时展示 diamond 过场；
 * 内容到达后过场淡出、MessageView 淡入（挂载即触发 chat-message-enter），
 * 两者同格叠放避免布局跳动。过场只出不回，parts 只增不减。
 */
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

  // 退场窗口：waiting 翻 false 时在渲染期置 exiting（React 派生状态模式），
  // effect 只负责到点卸载过场。
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

export function ChatThread({
  store,
  onEditMessage,
}: {
  store: ThreadStore;
  onEditMessage?: (text: string) => void;
}) {
  const state = useThreadState(store);
  const busy = state.status === "submitted" || state.status === "streaming";

  if (state.messages.length === 0) {
    return (
      <Empty className="h-full">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <HugeiconsIcon icon={Message01Icon} className="size-5" />
          </EmptyMedia>
          <EmptyTitle>开始一段新对话</EmptyTitle>
          <EmptyDescription>
            描述你的问题或任务，agent 会展示它的每一步推理。
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <div className="flex flex-wrap justify-center gap-2">
            {SUGGESTIONS.map((suggestion) => (
              <Button
                key={suggestion}
                variant="outline"
                size="sm"
                className="rounded-full"
                onClick={() => store.send(suggestion)}
              >
                {suggestion}
              </Button>
            ))}
          </div>
        </EmptyContent>
      </Empty>
    );
  }

  return (
    <MessageScrollerProvider autoScroll scrollPreviousItemPeek={64}>
      <MessageScroller>
        <MessageScrollerViewport>
          <MessageScrollerContent
            aria-busy={busy}
            className="mx-auto w-full max-w-[720px] gap-8 px-6 py-8"
          >
            {state.messages.map((message) => (
              <MessageScrollerItem
                key={message.id}
                messageId={message.id}
                scrollAnchor={message.role === "user"}
              >
                {message.role === "assistant" ? (
                  <AssistantSlot
                    message={message}
                    busy={busy}
                    onRetry={() => store.retry(message.id)}
                    onEdit={onEditMessage}
                  />
                ) : (
                  <MessageView
                    message={message}
                    streaming={false}
                    onRetry={() => store.retry(message.id)}
                    onEdit={onEditMessage}
                  />
                )}
              </MessageScrollerItem>
            ))}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton />
      </MessageScroller>
    </MessageScrollerProvider>
  );
}
