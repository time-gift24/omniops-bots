"use client";

import * as React from "react";

import type { ThreadStore } from "@/chat/thread-store.ts";
import { useThreadState } from "@/chat/react.ts";
import { AgentChatCredits } from "@/components/premium/agent-chat-input/agent-chat-credits";
import {
  AgentComposerAction,
  AgentComposerAttach,
  AgentComposerAttachments,
  AgentComposerInput,
  AgentComposerModel,
  AgentComposerSurface,
} from "@/components/premium/agent-chat-input/composition";
import type { AgentChatCreditsLabels } from "@/components/premium/agent-chat-input/credits-labels";
import type {
  AgentChatAttachment,
  AgentChatInputStatus,
} from "@/components/premium/agent-chat-input/types";
import { cn } from "@/lib/utils";

const LABELS: Partial<AgentChatCreditsLabels> = {
  editor: "消息输入",
  sendMessage: "发送",
  stopResponse: "停止生成",
  sendingPrompt: "正在发送",
  attachFiles: "添加附件",
  selectModel: "选择模型",
  noMatchingSkills: "没有匹配的技能",
  closePreview: "关闭预览",
  removeAttachment: (name) => `移除附件 ${name}`,
  previewAttachment: (name) => `预览 ${name}`,
};

/** 仅用于 mock 网关。 */
const MODELS = [
  { id: "pine-1", label: "Pine 1" },
  { id: "sonnet-5", label: "Sonnet 5" },
  { id: "opus-4.8", label: "Opus 4.8" },
  { id: "gpt-5.6", label: "GPT 5.6" },
] as const;

/** 失败后仍可继续输入，error 仅作语义标记。 */
function toComposerStatus(status: string): AgentChatInputStatus {
  if (status === "submitted" || status === "streaming") return status;
  if (status === "failed") return "error";
  return "ready";
}

export function ChatComposer({
  store,
  initialText,
  className,
}: {
  store: ThreadStore;
  /** 初始文本（用户消息「编辑」动作）；父级用 key 变化触发重挂载生效。 */
  initialText?: string;
  className?: string;
}) {
  const state = useThreadState(store);
  const [attachments, setAttachments] = React.useState<AgentChatAttachment[]>(
    [],
  );
  // 模型受控：选择随发送进入请求，retry 由 store 沿用。
  const [model, setModel] = React.useState<string>(MODELS[0].id);

  return (
    <AgentChatCredits
      aria-label="消息输入"
      labels={LABELS}
      defaultValue={initialText ?? ""}
      clearOnSubmit
      // 技能体系未上线：空列表让 `/` 保持纯文本，不触发面板。
      skills={[]}
      status={toComposerStatus(state.status)}
      placeholder=""
      models={MODELS}
      model={model}
      onModelChange={setModel}
      attachments={attachments}
      onAttachmentsChange={setAttachments}
      onStop={() => store.stop()}
      onSubmit={(text, sent) => {
        const accepted = store.send(
          text,
          sent.map((attachment) => ({
            name: attachment.name,
            mediaType: attachment.type ?? "application/octet-stream",
          })),
          model,
        );
        if (accepted) setAttachments([]);
        return accepted;
      }}
      className={cn("max-w-[736px]", className)}
    >
      <AgentComposerSurface className="px-1 py-2">
        <AgentComposerInput />
        <div className="flex items-center justify-between gap-3 px-1">
          <div className="flex min-w-0 items-center gap-0.5 text-muted-foreground">
            <AgentComposerAttach />
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <AgentComposerModel />
            <AgentComposerAction />
          </div>
        </div>
      </AgentComposerSurface>
      <AgentComposerAttachments />
    </AgentChatCredits>
  );
}
