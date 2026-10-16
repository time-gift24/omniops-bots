"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import { Message01Icon } from "@hugeicons-pro/core-stroke-rounded";

import type { ThreadStore } from "@/chat/thread-store.ts";
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

  const last = state.messages.at(-1);
  // 思考过场：用户消息之后、首个可见内容（步骤或正文）到达之前。
  const showThinking =
    busy &&
    (!last ||
      last.role === "user" ||
      (last.role === "assistant" && last.parts.length === 0));

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
                <MessageView
                  message={message}
                  streaming={busy && message === last}
                  onRetry={() => store.retry()}
                  onEdit={onEditMessage}
                />
              </MessageScrollerItem>
            ))}
            {showThinking && (
              <MessageScrollerItem messageId="__thinking__">
                <AIThinkingLoader variant="diamond" label="正在思考" />
              </MessageScrollerItem>
            )}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton />
      </MessageScroller>
    </MessageScrollerProvider>
  );
}
