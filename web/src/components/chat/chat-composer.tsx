"use client"

import * as React from "react"

import { useAppDependencies } from "@/app/dependencies"
import { threadTask } from "@/desktop/runtime"
import type { ThreadStore } from "@/chat/thread-store.ts"
import { ApprovalPanel } from "@/components/chat/approval-panel"
import { preloadChatThread } from "@/components/chat/chat-thread-loading"
import { AgentChatCredits } from "@/components/premium/agent-chat-input/agent-chat-credits"
import { cn } from "@/lib/utils"
import type { ModelChoice } from "@/models/source"
import type { AgentChatInputStatus } from "@/components/premium/agent-chat-input/types"

/** 失败后仍可继续输入，error 仅作语义标记。 */
function toComposerStatus(status: string): AgentChatInputStatus {
  if (status === "stopping") return "streaming"
  if (status === "submitted" || status === "streaming") return status
  if (status === "failed") return "error"
  return "ready"
}

export function ChatComposer({
  store,
  models,
  locked = false,
  className,
}: {
  store: ThreadStore
  models: readonly ModelChoice[]
  locked?: boolean
  className?: string
}) {
  const { desktop } = useAppDependencies()
  const desktopState = React.useSyncExternalStore(
    desktop.subscribe,
    desktop.getState,
    desktop.getState
  )
  const status = React.useSyncExternalStore(
    store.subscribe,
    () => store.getState().status
  )
  const threadError = React.useSyncExternalStore(
    store.subscribe,
    () => store.getState().error?.message
  )
  const draft = React.useSyncExternalStore(
    store.subscribeDraft,
    store.getDraft,
    store.getDraft
  )
  const model = locked
    ? (draft.model ?? "")
    : draft.model
      ? (models.find((choice) => choice.id === draft.model)?.id ?? "")
      : (models.find((choice) => choice.isDefault)?.id ?? "")
  const task = threadTask(desktopState, store.getState().threadId)
  const ownsTask = task?.threadId === store.getState().threadId
  const approval = ownsTask ? task?.approval : undefined
  const stopping = task?.phase === "stopping" || status === "stopping"

  return (
    <div
      data-slot="chat-composer-anchor"
      className={cn("relative max-w-[736px]", className)}
    >
      {task && ownsTask && approval ? (
        <ApprovalPanel
          key={`${task.runId}:${approval.id}`}
          runtime={desktop}
          task={task}
          approval={approval}
          error={threadError}
          draft={draft.approval}
          onDraftChange={(approval) => store.updateDraft({ approval })}
          onStop={() => store.stop()}
        />
      ) : ownsTask && (task?.error || threadError) ? (
        <p role="alert" className="mb-3 text-xs text-destructive">
          {task?.error ?? threadError}
        </p>
      ) : !task && !model ? (
        <p role="alert" className="mb-3 text-xs text-muted-foreground">
          {models.length
            ? "请选择模型，或在设置中配置全局默认模型。"
            : "尚未配置模型。请在设置的 Provider 中添加接入与模型。"}
        </p>
      ) : null}
      <AgentChatCredits
        compact
        value={draft.text}
        onValueChange={(text) => {
          store.updateDraft({ text })
          if (text.trim()) preloadChatThread()
        }}
        skills={[]}
        models={models}
        model={model}
        modelLocked={locked}
        defaultModel=""
        onModelChange={(model) => {
          if (!locked) store.updateDraft({ model })
        }}
        attachments={draft.attachments}
        onAttachmentsChange={(attachments) =>
          store.updateDraft({ attachments })
        }
        status={task && ownsTask ? "streaming" : toComposerStatus(status)}
        sendDisabled={!model || Boolean(task && !ownsTask)}
        stopping={stopping || Boolean(task && !ownsTask)}
        placeholder="问点什么，或者直接开始构建…"
        onStop={() => store.stop()}
        onSubmit={(text, sent) => {
          if (threadTask(desktop.getState(), store.getState().threadId))
            return false
          if (!model) return false
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
          if (accepted) store.updateDraft({ text: "", attachments: [], model })
          return accepted
        }}
        className="max-w-none"
      />
    </div>
  )
}
