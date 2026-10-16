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

/** 线程状态 → 输入区状态：失败后可继续输入，error 仅作语义标记。 */
function toComposerStatus(status: string): AgentChatInputStatus {
  if (status === "submitted" || status === "streaming") return status;
  if (status === "failed") return "error";
  return "ready";
}

/**
 * 对话输入区：直接使用 beui `AgentChatCredits` 的外壳与运动体系
 * （双层 shell、发送 ↔ 停止的 spring 变形、附件托盘与图片预览）。
 * 通过 children 组合只保留输入 / 附件 / 发送三个部分：
 * 积分横幅、语音、搜索与技能面板随对应能力上线后再启用。
 */
export function ChatComposer({
  store,
  placeholder = "描述你的问题或任务…",
  initialText,
  className,
}: {
  store: ThreadStore;
  placeholder?: string;
  /** 初始文本（用户消息「编辑」动作）；父级用 key 变化触发重挂载生效。 */
  initialText?: string;
  className?: string;
}) {
  const state = useThreadState(store);
  // 附件受控：发送成功后随消息入线程，托盘同时清空（chat 语义，而非生成式复用）。
  const [attachments, setAttachments] = React.useState<AgentChatAttachment[]>(
    [],
  );

  return (
    <AgentChatCredits
      aria-label="消息输入"
      labels={LABELS}
      defaultValue={initialText ?? ""}
      clearOnSubmit
      // 技能体系未上线：空列表让 `/` 保持纯文本，不触发面板。
      skills={[]}
      status={toComposerStatus(state.status)}
      placeholder={placeholder}
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
        );
        if (accepted) setAttachments([]);
        return accepted;
      }}
      className={cn("max-w-[720px]", className)}
    >
      <AgentComposerSurface>
        <AgentComposerInput />
        <div className="flex items-center justify-between gap-3 px-1">
          <div className="flex min-w-0 items-center gap-0.5 text-muted-foreground">
            <AgentComposerAttach />
          </div>
          <AgentComposerAction />
        </div>
      </AgentComposerSurface>
      <AgentComposerAttachments />
    </AgentChatCredits>
  );
}
