"use client";

import * as React from "react";
import { LayoutGroup, motion, useReducedMotion } from "motion/react";

import { useThreadState, useThreadStore } from "@/chat/react.ts";
import { ChatComposer } from "@/components/chat/chat-composer";
import { ChatThread } from "@/components/chat/chat-thread";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SPRING_PANEL } from "@/lib/ease";

/** 本轮单线程界面固定使用一个 threadId；切换线程 UI 落地时状态层不变。 */
const MAIN_THREAD_ID = "main";

const SUGGESTIONS = [
  "为什么这次构建这么慢？",
  "帮我排查一下昨天部署失败的原因",
  "总结一下这个仓库本周的变更",
];

type EditRequest = { text: string; nonce: number };

export function ChatScreen() {
  const store = useThreadStore(MAIN_THREAD_ID);
  const state = useThreadState(store);
  const [editRequest, setEditRequest] = React.useState<EditRequest | null>(null);
  const reduce = useReducedMotion();
  const empty = state.messages.length === 0;

  const composer = (
    <ChatComposer
      key={editRequest?.nonce ?? "idle"}
      store={store}
      initialText={editRequest?.text}
      className="mx-auto w-full max-w-[880px]"
    />
  );

  return (
    <TooltipProvider>
      <LayoutGroup>
        <div className="flex h-full min-h-0 flex-col">
          {empty ? (
            // CDS desktop 空态：问候 + 居中 composer + 建议；开聊后
            // composer 以共享 layoutId 平滑落底。
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-4">
              <motion.div
                initial={reduce ? false : { opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={reduce ? { duration: 0 } : SPRING_PANEL}
                className="flex w-full max-w-[880px] flex-col items-center gap-6"
              >
                <div className="flex flex-col items-center gap-2 text-center">
                  <h1 className="text-2xl font-medium tracking-tight">
                    开始一段新对话
                  </h1>
                  <p className="text-sm text-muted-foreground">
                    描述你的问题或任务，agent 会展示它的每一步推理。
                  </p>
                </div>
                <motion.div
                  layoutId={reduce ? undefined : "composer"}
                  className="w-full"
                >
                  {composer}
                </motion.div>
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
              </motion.div>
            </div>
          ) : (
            <>
              <div className="min-h-0 flex-1">
                <ChatThread
                  store={store}
                  onEditMessage={(text) =>
                    setEditRequest({ text, nonce: Date.now() })
                  }
                />
              </div>
              <div className="shrink-0 px-2 pb-2 sm:px-4 sm:pb-4">
                <motion.div
                  layoutId={reduce ? undefined : "composer"}
                  className="mx-auto max-w-[880px]"
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
