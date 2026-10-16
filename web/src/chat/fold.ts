/**
 * 事件流折叠：ChatEvent → 线程视图模型。纯函数，与渲染分离，可独立单测。
 */

import type {
  ChatError,
  ChatEvent,
  ChatMetadata,
  ChatUsage,
  ThreadId,
} from "./dto.ts";

export type ToolState = "running" | "done" | "error";

export type PartView =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | {
      kind: "tool";
      callId: string;
      name: string;
      inputText: string;
      output?: unknown;
      state: ToolState;
      errorText?: string;
    };

export type MessageState = "streaming" | "done" | "failed" | "stopped";

export interface ChatMessageView {
  id: string;
  role: "user" | "assistant";
  parts: PartView[];
  state: MessageState;
}

export type ThreadStatus = "idle" | "submitted" | "streaming" | "failed";

export interface ThreadViewState {
  threadId: ThreadId;
  status: ThreadStatus;
  messages: ChatMessageView[];
  metadata?: ChatMetadata;
  usage?: ChatUsage;
  error?: ChatError;
}

export function createThreadState(threadId: ThreadId): ThreadViewState {
  return { threadId, status: "idle", messages: [] };
}

/** 生成单调递增的消息 ID（同一线程内唯一即可）。 */
function nextMessageId(state: ThreadViewState): string {
  return `m-${state.messages.length + 1}`;
}

/** 追加一条用户消息（send 的乐观更新）。 */
export function appendUserMessage(
  state: ThreadViewState,
  text: string,
): ThreadViewState {
  const message: ChatMessageView = {
    id: nextMessageId(state),
    role: "user",
    parts: [{ kind: "text", text }],
    state: "done",
  };
  return {
    ...state,
    status: "submitted",
    error: undefined,
    messages: [...state.messages, message],
  };
}

function withInFlightAssistant(
  state: ThreadViewState,
  mutate: (message: ChatMessageView) => ChatMessageView,
  createIfMissing = false,
): ThreadViewState {
  const messages = [...state.messages];
  let index = messages.length - 1;
  let message = messages[index];
  if (!message || message.role !== "assistant") {
    if (!createIfMissing) return state;
    message = {
      id: nextMessageId(state),
      role: "assistant",
      parts: [],
      state: "streaming",
    };
    messages.push(message);
    index = messages.length - 1;
  }
  messages[index] = mutate(message);
  return { ...state, messages };
}

function mutatePart(
  message: ChatMessageView,
  partId: number,
  mutate: (part: PartView, index: number) => PartView,
): ChatMessageView {
  const parts = [...message.parts];
  const index = parts.length > partId ? partId : -1;
  if (index < 0) return message;
  parts[index] = mutate(parts[index], index);
  return { ...message, parts };
}

export function foldChatEvent(
  state: ThreadViewState,
  event: ChatEvent,
): ThreadViewState {
  switch (event.type) {
    case "started":
      return withInFlightAssistant(
        { ...state, status: "streaming", metadata: event.metadata },
        (message) => message,
        true,
      );

    case "part-started":
      return withInFlightAssistant(state, (message) => {
        const part: PartView =
          event.kind === "tool-call"
            ? {
                kind: "tool",
                callId: String(event.partId),
                name: event.name ?? "",
                inputText: "",
                state: "running",
              }
            : event.kind === "reasoning"
              ? { kind: "reasoning", text: "" }
              : { kind: "text", text: "" };
        const parts = [...message.parts];
        parts[event.partId] = part;
        return { ...message, parts };
      });

    case "delta":
      return withInFlightAssistant(state, (message) =>
        mutatePart(message, event.partId, (part) => {
          if (part.kind === "tool") {
            return { ...part, inputText: part.inputText + event.text };
          }
          return { ...part, text: part.text + event.text };
        }),
      );

    case "part-completed":
      return withInFlightAssistant(state, (message) =>
        mutatePart(message, event.partId, (part) => {
          const content = event.content;
          if (content.type === "tool-call" && part.kind === "tool") {
            return {
              ...part,
              callId: content.call.callId,
              name: content.call.name,
              inputText: content.call.inputText,
              output: content.call.output,
              errorText: content.call.errorText,
              state: content.call.errorText ? "error" : "done",
            };
          }
          if (content.type === "reasoning" && part.kind === "reasoning") {
            return { ...part, text: content.text };
          }
          if (content.type === "text" && part.kind === "text") {
            return { ...part, text: content.text };
          }
          return part;
        }),
      );

    case "usage":
      return { ...state, usage: event.usage };

    case "completed":
      return withInFlightAssistant(
        {
          ...state,
          status: "idle",
          usage: event.response.usage,
          metadata: event.response.metadata,
        },
        (message) => ({ ...message, state: "done" }),
      );

    case "failed":
      return withInFlightAssistant(
        { ...state, status: "failed", error: event.error },
        (message) =>
          message.state === "streaming"
            ? { ...message, state: "failed" }
            : message,
      );
  }
}

/** 用户显式停止：保留已输出内容，标记进行中的回复为 stopped。 */
export function markStopped(state: ThreadViewState): ThreadViewState {
  return withInFlightAssistant(
    { ...state, status: "idle" },
    (message) =>
      message.state === "streaming" ? { ...message, state: "stopped" } : message,
  );
}
