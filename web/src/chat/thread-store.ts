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
  type ThreadViewState,
} from "./fold.ts";

/** 可 JSON 序列化的状态副本（+ schema 版本），供日后持久化与水合。 */
export type ThreadSnapshot = { version: 1; state: ThreadViewState };

export interface ThreadStore {
  getState(): ThreadViewState;
  subscribe(listener: () => void): () => void;
  send(text: string, attachments?: { name: string; mediaType: string }[]): void;
  /** 唯一会调用 gateway.abort() 的入口。 */
  stop(): void;
  /** 重试最近一次失败的用户回合。 */
  retry(): void;
  /** 是否有活跃的界面订阅者（供缓存驱逐判断）。 */
  readonly listenerCount: number;
  /** 是否有进行中的流（进行中的线程不可驱逐）。 */
  readonly streaming: boolean;
  snapshot(): ThreadSnapshot;
}

export class ThreadStoreImpl implements ThreadStore {
  private state: ThreadViewState;
  private listeners = new Set<() => void>();
  private running = false;
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
    return this.running;
  }

  snapshot(): ThreadSnapshot {
    return { version: 1, state: this.state };
  }

  send = (text: string, attachments?: { name: string; mediaType: string }[]): void => {
    const trimmed = text.trim();
    if (!trimmed || this.running) return;

    this.state = appendUserMessage(this.state, trimmed);
    this.emit();
    void this.consume(trimmed, attachments);
  };

  stop = (): void => {
    if (!this.running) return;
    this.gateway.abort();
    this.running = false;
    this.state = markStopped(this.state);
    this.emit();
  };

  retry = (): void => {
    const lastUser = [...this.state.messages]
      .reverse()
      .find((message) => message.role === "user");
    if (!lastUser || this.running) return;
    const text = lastUser.parts
      .filter((part) => part.kind === "text")
      .map((part) => part.text)
      .join("");
    // 移除上一轮失败的 assistant 占位，重发同一用户输入。
    const messages = this.state.messages.filter(
      (message) => !(message.role === "assistant" && message.state === "failed"),
    );
    this.state = { ...this.state, messages, status: "submitted", error: undefined };
    this.emit();
    void this.consume(text);
  };

  private async consume(
    text: string,
    attachments?: { name: string; mediaType: string }[],
  ): Promise<void> {
    this.running = true;
    try {
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
        this.state = foldChatEvent(this.state, event);
        this.emit();
      }
      // 流正常结束但既不是 completed 也不是 failed（例如被 abort 截断）：
      if (this.state.status === "streaming" || this.state.status === "submitted") {
        this.state = markStopped(this.state);
      }
    } catch (cause) {
      this.state = foldChatEvent(this.state, {
        type: "failed",
        error: {
          kind: "unknown",
          message: cause instanceof Error ? cause.message : String(cause),
        },
      });
    } finally {
      this.running = false;
      this.emit();
    }
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
