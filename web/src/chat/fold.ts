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
  | { kind: "reasoning"; text: string; state: "running" | "done" }
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

/** reasoning / tool 步骤（折叠段的成员）。 */
export type StepPart = Extract<PartView, { kind: "reasoning" | "tool" }>;

/**
 * 助手消息的展示分段：连续的 reasoning/tool 聚为一个折叠段，
 * 非空正文把事件流切开，各自按原始顺序渲染。
 */
export type AssistantSegment =
  | { kind: "steps"; parts: StepPart[] }
  | { kind: "text"; text: string };

/**
 * 正文隔断分段（参照 deepseek-harness process-groups：正文出现即
 * flush 当前活动组并独立渲染，之后的思考/工具另起新组）。
 * 空正文段不切断分组——正文还没有内容时，视觉分组保持不变。
 */
export function segmentAssistantParts(parts: PartView[]): AssistantSegment[] {
  const segments: AssistantSegment[] = [];
  for (const part of parts) {
    if (part.kind === "text") {
      if (part.text) segments.push({ kind: "text", text: part.text });
      continue;
    }
    const last = segments.at(-1);
    if (last?.kind === "steps") {
      last.parts.push(part);
    } else {
      segments.push({ kind: "steps", parts: [part] });
    }
  }
  return segments;
}

export interface ChatMessageView {
  id: string;
  role: "user" | "assistant";
  parts: PartView[];
  state: MessageState;
  /** 用户消息携带的附件（仅展示用途）。 */
  attachments?: { name: string; mediaType: string }[];
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
  attachments?: { name: string; mediaType: string }[],
): ThreadViewState {
  const message: ChatMessageView = {
    id: nextMessageId(state),
    role: "user",
    parts: [{ kind: "text", text }],
    state: "done",
    ...(attachments?.length ? { attachments } : {}),
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
  messageId?: string,
): ThreadViewState {
  const messages = [...state.messages];
  let index =
    messageId === undefined
      ? messages.length - 1
      : messages.findIndex((message) => message.id === messageId);
  let message = messages[index];
  if (!message || message.role !== "assistant") {
    if (!createIfMissing) return state;
    message = {
      id: messageId ?? nextMessageId(state),
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
  messageId?: string,
): ThreadViewState {
  switch (event.type) {
    case "started":
      return withInFlightAssistant(
        { ...state, status: "streaming", metadata: event.metadata },
        (message) => ({ ...message, parts: [], state: "streaming" }),
        true,
        messageId,
      );

    case "part-started":
      return withInFlightAssistant(
        state,
        (message) => {
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
                ? { kind: "reasoning", text: "", state: "running" }
                : { kind: "text", text: "" };
          const parts = [...message.parts];
          parts[event.partId] = part;
          return { ...message, parts };
        },
        false,
        messageId,
      );

    case "delta":
      return withInFlightAssistant(
        state,
        (message) =>
          mutatePart(message, event.partId, (part) => {
            if (part.kind === "tool") {
              return { ...part, inputText: part.inputText + event.text };
            }
            return { ...part, text: part.text + event.text };
          }),
        false,
        messageId,
      );

    case "part-completed":
      return withInFlightAssistant(
        state,
        (message) =>
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
              return { ...part, text: content.text, state: "done" };
            }
            if (content.type === "text" && part.kind === "text") {
              return { ...part, text: content.text };
            }
            return part;
          }),
        false,
        messageId,
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
        false,
        messageId,
      );

    case "failed":
      return withInFlightAssistant(
        { ...state, status: "failed", error: event.error },
        (message) =>
          message.state === "streaming"
            ? { ...message, state: "failed" }
            : message,
        false,
        messageId,
      );
  }
}

/** 用户显式停止：保留已输出内容，标记进行中的回复为 stopped。 */
export function markStopped(
  state: ThreadViewState,
  messageId?: string,
): ThreadViewState {
  return withInFlightAssistant(
    { ...state, status: "idle" },
    (message) =>
      message.state === "streaming"
        ? { ...message, state: "stopped" }
        : message,
    false,
    messageId,
  );
}
