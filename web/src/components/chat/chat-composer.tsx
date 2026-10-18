"use client"

import * as React from "react"

import type { ThreadStore } from "@/chat/thread-store.ts"
import { AgentChatCredits } from "@/components/premium/agent-chat-input/agent-chat-credits"
import {
  AgentComposerAction,
  AgentComposerAttach,
  AgentComposerAttachments,
  AgentComposerInput,
  AgentComposerModel,
  AgentComposerSurface,
} from "@/components/premium/agent-chat-input/composition"
import type { AgentChatCreditsLabels } from "@/components/premium/agent-chat-input/credits-labels"
import type { AgentChatInputStatus } from "@/components/premium/agent-chat-input/types"
import { cn } from "@/lib/utils"
import type { ModelChoice } from "@/models/source"

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
}

/** 失败后仍可继续输入，error 仅作语义标记。 */
function toComposerStatus(status: string): AgentChatInputStatus {
  if (status === "submitted" || status === "streaming") return status
  if (status === "failed") return "error"
  return "ready"
}

export function ChatComposer({
  store,
  models,
  className,
}: {
  store: ThreadStore
  models: readonly ModelChoice[]
  className?: string
}) {
  const status = React.useSyncExternalStore(
    store.subscribe,
    () => store.getState().status
  )
  const draft = React.useSyncExternalStore(
    store.subscribeDraft,
    store.getDraft,
    store.getDraft
  )
  const model =
    models.find((choice) => choice.id === draft.model)?.id ?? models[0]?.id

  return (
    <AgentChatCredits
      aria-label="消息输入"
      labels={LABELS}
      autoFocus
      value={draft.text}
      onValueChange={(text) => store.updateDraft({ text })}
      // 技能体系未上线：空列表让 `/` 保持纯文本，不触发面板。
      skills={[]}
      status={toComposerStatus(status)}
      placeholder=""
      models={models}
      model={model}
      onModelChange={(model) => store.updateDraft({ model })}
      attachments={draft.attachments}
      onAttachmentsChange={(attachments) => store.updateDraft({ attachments })}
      onStop={() => store.stop()}
      onSubmit={(text, sent) => {
        const accepted = store.send(
          text,
          sent.map((attachment) => ({
            id: attachment.id,
            name: attachment.name,
            mediaType: attachment.type ?? "application/octet-stream",
            size: attachment.size,
            file: attachment.file,
            url: attachment.url,
          })),
          model
        )
        if (accepted) store.updateDraft({ text: "", attachments: [] })
        return accepted
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
  )
}
