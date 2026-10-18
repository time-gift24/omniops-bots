"use client";

import * as React from "react";
import { LayoutGroup, motion, useReducedMotion } from "motion/react";
import {
  ArrowDown01Icon,
  Folder01Icon,
} from "@hugeicons-pro/core-stroke-rounded";
import { HugeiconsIcon } from "@hugeicons/react";

import { useThreadState, useThreadStore } from "@/chat/react.ts";
import {
  ChatComposer,
  DEFAULT_CHAT_MODEL,
} from "@/components/chat/chat-composer";
import { ChatThread } from "@/components/chat/chat-thread";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SPRING_PANEL } from "@/lib/ease";

const SUGGESTIONS = [
  "为什么这次构建这么慢？",
  "帮我排查一下昨天部署失败的原因",
  "总结一下这个仓库本周的变更",
];

export function ChatScreen({
  threadId = "main",
  workspaceName,
  onChooseWorkspace,
  suggestions = SUGGESTIONS,
}: {
  threadId?: string;
  workspaceName?: string;
  onChooseWorkspace?: () => void;
  suggestions?: readonly string[];
}) {
  const store = useThreadStore(threadId);
  const state = useThreadState(store);
  const editMessage = React.useCallback(
    (text: string) => {
      store.updateDraft({ text, attachments: [] });
    },
    [store],
  );
  const reduce = useReducedMotion();
  const empty = state.messages.length === 0;

  const composer = <ChatComposer store={store} className="mx-auto w-full" />;

  return (
    <TooltipProvider>
      <LayoutGroup id={threadId}>
        <div className="flex h-full min-h-0 flex-col">
          {empty ? (
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-4 sm:px-8">
              <motion.div
                initial={reduce ? false : { opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={reduce ? { duration: 0 } : SPRING_PANEL}
                className="flex w-full max-w-[736px] flex-col items-center gap-6"
              >
                <div className="flex flex-col items-center gap-2 text-center">
                  <h1 className="text-2xl font-medium tracking-tight">
                    开始一段新对话
                  </h1>
                  <p className="text-sm text-muted-foreground">
                    描述你的问题或任务，agent 会展示它的每一步推理。
                  </p>
                  {onChooseWorkspace ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="mt-1 max-w-full text-muted-foreground"
                      onClick={onChooseWorkspace}
                      aria-label={
                        workspaceName
                          ? `选择工作区，当前为 ${workspaceName}`
                          : "选择工作区"
                      }
                    >
                      <HugeiconsIcon icon={Folder01Icon} aria-hidden="true" />
                      <span className="truncate">
                        {workspaceName ?? "选择工作区"}
                      </span>
                      <HugeiconsIcon
                        icon={ArrowDown01Icon}
                        aria-hidden="true"
                      />
                    </Button>
                  ) : workspaceName ? (
                    <p className="mt-1 max-w-full truncate text-sm text-muted-foreground">
                      {workspaceName}
                    </p>
                  ) : null}
                </div>
                <motion.div
                  layoutId={reduce ? undefined : "composer"}
                  className="w-full"
                >
                  {composer}
                </motion.div>
                <div className="flex flex-wrap justify-center gap-2">
                  {suggestions.map((suggestion) => (
                    <Button
                      key={suggestion}
                      variant="outline"
                      size="sm"
                      className="rounded-full"
                      onClick={() =>
                        store.send(
                          suggestion,
                          undefined,
                          store.getDraft().model ?? DEFAULT_CHAT_MODEL,
                        )
                      }
                    >
                      {suggestion}
                    </Button>
                  ))}
                </div>
              </motion.div>
            </div>
          ) : (
            <>
              {workspaceName ? (
                <div className="flex shrink-0 items-center gap-2 px-4 py-3 text-sm text-muted-foreground sm:px-8">
                  <HugeiconsIcon
                    icon={Folder01Icon}
                    className="size-4 shrink-0"
                    aria-hidden="true"
                  />
                  <span className="truncate">{workspaceName}</span>
                </div>
              ) : null}
              <div className="min-h-0 flex-1">
                <ChatThread store={store} onEditMessage={editMessage} />
              </div>
              <div className="shrink-0 px-4 pb-4 sm:px-8 sm:pb-6">
                <motion.div
                  layoutId={reduce ? undefined : "composer"}
                  className="mx-auto max-w-[736px]"
                >
                  {composer}
                </motion.div>
              </div>
            </>
          )}
        </div>
      </LayoutGroup>
    </TooltipProvider>
  );
}
