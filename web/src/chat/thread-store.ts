/** 界面卸载不终止流，只有用户显式 stop() 才中止。 */

import type { ChatGateway } from "./gateway.ts";
import type { ChatInputAttachment, ThreadId } from "./dto.ts";
import {
  appendUserMessage,
  createThreadState,
  foldChatEvent,
  markStopped,
  type ChatMessageView,
  type ThreadViewState,
} from "./fold.ts";

export type ThreadSnapshot = { version: 1; state: ThreadViewState };

export interface ThreadDraftAttachment {
  id: string;
  name: string;
  type?: string;
  size?: number;
  file?: File;
  url?: string;
}

export interface ThreadDraft {
  text: string;
  model?: string;
  attachments: readonly ThreadDraftAttachment[];
}

export interface ThreadStore {
  getState(): ThreadViewState;
  subscribe(listener: () => void): () => void;
  getDraft(): ThreadDraft;
  updateDraft(patch: Partial<ThreadDraft>): void;
  /** 输入变化只通知编辑器，不使消息列表跟随每次按键重渲染。 */
  subscribeDraft(listener: () => void): () => void;
  /** 提交给定内容，不修改草稿；输入框在接受提交后负责清理。 */
  send(
    text: string,
    attachments?: ChatInputAttachment[],
    model?: string,
  ): boolean;
  /** 唯一会调用 gateway.abort() 的入口。 */
  stop(): void;
  /** 原位重新生成指定回复；省略 ID 时重试最新回复。 */
  retry(messageId?: string): void;
  readonly listenerCount: number;
  /** 进行中的线程不可驱逐。 */
  readonly streaming: boolean;
  snapshot(): ThreadSnapshot;
}

export class ThreadStoreImpl implements ThreadStore {
  private state: ThreadViewState;
  private listeners = new Set<() => void>();
  // ponytail: 草稿跟随内存会话；需要刷新恢复时再接持久化。
  private draft: ThreadDraft = { text: "", attachments: [] };
  private draftListeners = new Set<() => void>();
  private activeRequest: { messageId: string } | undefined;
  private gateway: ChatGateway;
  /** 重试保留运行态附件引用与模型；这些输入不进入消息视图或 snapshot。 */
  private requestInputs = new Map<
    string,
    {
      attachments: ChatInputAttachment[] | undefined;
      model: string | undefined;
    }
  >();

  constructor(threadId: ThreadId, gateway: ChatGateway) {
    this.gateway = gateway;
    this.state = createThreadState(threadId);
  }

  getState = (): ThreadViewState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getDraft = (): ThreadDraft => this.draft;

  updateDraft = (patch: Partial<ThreadDraft>): void => {
    this.draft = {
      ...this.draft,
      ...patch,
      attachments: patch.attachments
        ? [...patch.attachments]
        : this.draft.attachments,
    };
    for (const listener of [...this.draftListeners]) listener();
  };

  subscribeDraft = (listener: () => void): (() => void) => {
    this.draftListeners.add(listener);
    return () => this.draftListeners.delete(listener);
  };

  get listenerCount(): number {
    return this.listeners.size + this.draftListeners.size;
  }

  get streaming(): boolean {
    return this.activeRequest !== undefined;
  }

  snapshot(): ThreadSnapshot {
    return { version: 1, state: structuredClone(this.state) };
  }

  send = (
    text: string,
    attachments?: ChatInputAttachment[],
    model?: string,
  ): boolean => {
    const trimmed = text.trim();
    if (!trimmed || this.streaming) return false;

    const files = attachments?.map((attachment) => ({ ...attachment }));
    this.state = appendUserMessage(
      this.state,
      trimmed,
      files?.map(({ name, mediaType }) => ({ name, mediaType })),
    );
    void this.consume(trimmed, files, model);
    return true;
  };

  stop = (): void => {
    const request = this.activeRequest;
    if (!request) return;
    this.activeRequest = undefined;
    this.state = markStopped(this.state, request.messageId);
    try {
      this.gateway.abort();
    } catch {
      // 本地停止已生效，传输关闭失败不能阻止状态通知。
    }
    this.emit();
  };

  retry = (messageId?: string): void => {
    if (this.streaming) return;
    const index = this.state.messages.findLastIndex(
      (message) =>
        message.role === "assistant" &&
        (messageId === undefined || message.id === messageId),
    );
    if (index < 0) return;
    const user = this.state.messages
      .slice(0, index)
      .findLast((message) => message.role === "user");
    if (!user) return;
    const text = user.parts
      .filter((part) => part.kind === "text")
      .map((part) => part.text)
      .join("");
    const replyId = this.state.messages[index].id;
    const input = this.requestInputs.get(replyId);
    void this.consume(
      text,
      input?.attachments ?? user.attachments,
      input?.model,
      replyId,
    );
  };

  private async consume(
    text: string,
    attachments: ChatInputAttachment[] | undefined,
    model: string | undefined,
    messageId = `m-${this.state.messages.length + 1}`,
  ): Promise<void> {
    const active = { messageId };
    this.activeRequest = active;
    this.requestInputs.set(messageId, { attachments, model });
    const reply: ChatMessageView = {
      id: messageId,
      role: "assistant",
      parts: [],
      state: "streaming",
    };
    const existing = this.state.messages.some(
      (message) => message.id === messageId,
    );
    this.state = {
      ...this.state,
      status: "submitted",
      error: undefined,
      metadata: undefined,
      usage: undefined,
      messages: existing
        ? this.state.messages.map((message) =>
            message.id === messageId ? reply : message,
          )
        : [...this.state.messages, reply],
    };
    this.emit();
    try {
      if (this.activeRequest !== active) return;
      const request = {
        messages: [
          {
            role: "user" as const,
            text,
            ...(attachments?.length
              ? {
                  attachments: attachments.map((attachment) => ({
                    ...attachment,
                  })),
                }
              : {}),
          },
        ],
        ...(model ? { model } : {}),
      };
      for await (const event of this.gateway.stream(request)) {
        if (this.activeRequest !== active) return;
        this.state = foldChatEvent(this.state, event, messageId);
        const terminal =
          event.type === "completed" || this.state.status === "failed";
        if (terminal) this.activeRequest = undefined;
        this.emit();
        if (terminal) break;
      }
      if (this.activeRequest !== active) return;
      this.state = foldChatEvent(
        this.state,
        {
          type: "failed",
          error: {
            kind: "truncated",
            message: "回复流提前结束，已保留已输出的内容。",
          },
        },
        messageId,
      );
    } catch (cause) {
      if (this.activeRequest !== active) return;
      this.state = foldChatEvent(
        this.state,
        {
          type: "failed",
          error: {
            kind: "unknown",
            message: cause instanceof Error ? cause.message : String(cause),
          },
        },
        messageId,
      );
    } finally {
      if (this.activeRequest === active) {
        this.activeRequest = undefined;
        this.emit();
      }
    }
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener();
  }
}
