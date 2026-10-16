/**
 * ThreadStore：每个对话线程一个的外部 store。
 * 持有线程视图状态，拥有该线程的网关订阅生命周期；
 * 界面卸载不终止流，只有用户显式 stop() 才中止。
 */

import type { ChatGateway } from "./gateway.ts";
import type { ThreadId } from "./dto.ts";
import {
  appendUserMessage,
  createThreadState,
  foldChatEvent,
  markStopped,
  type ChatMessageView,
  type ThreadViewState,
} from "./fold.ts";

/** 可 JSON 序列化的状态副本（+ schema 版本），供日后持久化与水合。 */
export type ThreadSnapshot = { version: 1; state: ThreadViewState };

export interface ThreadStore {
  getState(): ThreadViewState;
  subscribe(listener: () => void): () => void;
  send(
    text: string,
    attachments?: { name: string; mediaType: string }[],
  ): boolean;
  /** 唯一会调用 gateway.abort() 的入口。 */
  stop(): void;
  /** 原位重新生成指定回复；省略 ID 时重试最新回复。 */
  retry(messageId?: string): void;
  /** 是否有活跃的界面订阅者（供缓存驱逐判断）。 */
  readonly listenerCount: number;
  /** 是否有进行中的流（进行中的线程不可驱逐）。 */
  readonly streaming: boolean;
  snapshot(): ThreadSnapshot;
}

export class ThreadStoreImpl implements ThreadStore {
  private state: ThreadViewState;
  private listeners = new Set<() => void>();
  private activeRequest: { messageId: string } | undefined;
  private gateway: ChatGateway;

  constructor(threadId: ThreadId, gateway: ChatGateway) {
    this.gateway = gateway;
    this.state = createThreadState(threadId);
  }

  getState = (): ThreadViewState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  get listenerCount(): number {
    return this.listeners.size;
  }

  get streaming(): boolean {
    return this.activeRequest !== undefined;
  }

  snapshot(): ThreadSnapshot {
    return { version: 1, state: this.state };
  }

  send = (
    text: string,
    attachments?: { name: string; mediaType: string }[],
  ): boolean => {
    const trimmed = text.trim();
    if (!trimmed || this.streaming) return false;

    this.state = appendUserMessage(this.state, trimmed, attachments);
    void this.consume(trimmed, attachments);
    return true;
  };

  stop = (): void => {
    const request = this.activeRequest;
    if (!request) return;
    this.activeRequest = undefined;
    this.state = markStopped(this.state, request.messageId);
    this.gateway.abort();
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
    void this.consume(text, user.attachments, this.state.messages[index].id);
  };

  private async consume(
    text: string,
    attachments?: { name: string; mediaType: string }[],
    messageId = `m-${this.state.messages.length + 1}`,
  ): Promise<void> {
    const active = { messageId };
    this.activeRequest = active;
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
            ...(attachments?.length ? { attachments } : {}),
          },
        ],
      };
      for await (const event of this.gateway.stream(request)) {
        if (this.activeRequest !== active) return;
        this.state = foldChatEvent(this.state, event, messageId);
        this.emit();
      }
      if (this.activeRequest !== active) return;
      // 流正常结束但既不是 completed 也不是 failed（例如被 abort 截断）：
      if (
        this.state.status === "streaming" ||
        this.state.status === "submitted"
      ) {
        this.state = markStopped(this.state, messageId);
      }
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
    for (const listener of this.listeners) listener();
  }
}
