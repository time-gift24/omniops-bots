/**
 * 线格式桥接：`cognacta-core` `GenerationEvent` 的 JSON 表示 ↔ 前端 `ChatEvent`。
 *
 * 线格式约定（与 Rust 侧将来的 serde 派生一一对应，`#[serde(tag = "type", rename_all =
 * "snake_case")]` 风格）：
 * - 事件与内容用 `type` 标签区分，字段一律 snake_case；
 * - 失败以 `{ "type": "failed", "error": { "kind", "message" } }` 一帧收尾，
 *   对应 Rust 流以 `Err` 终止；
 * - `Option<T>` 缺省时字段省略，不发 `null`。
 *
 * 编码载体（Tauri channel / NDJSON / SSE data 行）不影响本模块：每种载体只需要把
 * 载荷 JSON 解析成对象后交给 `chatEventFromWire`。
 *
 * 本模块是后端契约变更的唯一落点：界面与 store 只依赖 `dto.ts`。
 */

import type {
  ChatError,
  ChatEvent,
  ChatMetadata,
  ChatRequest,
  ChatUsage,
  FinishReason,
  OutputContent,
  PartKind,
} from "./dto.ts";

/** 线格式不合法时抛出；消息指向具体字段，便于定位后端变更。 */
export class WireFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WireFormatError";
  }
}

/* ---------- 线格式类型（Rust 类型的 JSON 形状） ---------- */

/** ↔ GenerationMetadata；字段缺省 = Rust `None`。 */
export interface WireMetadata {
  provider_name: string;
  protocol_name: string;
  requested_model: string;
  resolved_model?: string;
  request_id?: string;
  response_id?: string;
}

/** ↔ Usage。 */
export interface WireUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  reasoning_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
}

/** ↔ Finish。 */
export interface WireFinish {
  reason: string;
  provider_reason?: string;
}

/** ↔ OutputPart；`reasoning` / `tool-call` 为前瞻扩展位。 */
export type WireOutputPart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | {
      type: "tool_call";
      call_id: string;
      name: string;
      input_text: string;
      output?: unknown;
      error_text?: string;
    };

/** ↔ AssistantMessage。 */
export interface WireAssistantMessage {
  parts: WireOutputPart[];
}

/** ↔ GenerationResponse。 */
export interface WireResponse {
  assistant: WireAssistantMessage;
  finish: WireFinish;
  usage: WireUsage;
  metadata: WireMetadata;
}

/** ↔ ErrorKind（kebab-case）+ 客户端本地中止。 */
export type WireErrorKind =
  | "invalid-request"
  | "unsupported"
  | "authentication"
  | "rate-limited"
  | "unavailable"
  | "transport"
  | "timeout"
  | "invalid-response"
  | "truncated"
  | "replay-mismatch"
  | "aborted"
  | "unknown";

export interface WireError {
  kind: WireErrorKind;
  message: string;
}

/** ↔ GenerationEvent。 */
export type WireGenerationEvent =
  | { type: "started"; metadata: WireMetadata }
  | { type: "part_started"; part: number; kind: string; name?: string }
  | { type: "delta"; part: number; delta: { type: "text"; text: string } }
  | { type: "part_completed"; part: number; content: WireOutputPart }
  | { type: "usage"; usage: WireUsage }
  | { type: "completed"; response: WireResponse }
  | { type: "failed"; error: WireError };

/** ↔ GenerationRequest（invoke 方向：前端 → 后端）。 */
export interface WireGenerationRequest {
  messages: { role: "user"; text: string }[];
  instructions?: string;
}

/* ---------- 校验辅助 ---------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new WireFormatError(`${field} 必须是字符串，实际为 ${typeof value}`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, field);
}

function optionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new WireFormatError(`${field} 必须是有限数字，实际为 ${String(value)}`);
  }
  return value;
}

function requirePartId(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new WireFormatError(`${field} 必须是非负整数，实际为 ${String(value)}`);
  }
  return value;
}

/* ---------- 字段级转换 ---------- */

function metadataFromWire(raw: unknown): ChatMetadata {
  if (!isRecord(raw)) throw new WireFormatError("metadata 必须是对象");
  return {
    providerName: requireString(raw.provider_name, "metadata.provider_name"),
    protocolName: requireString(raw.protocol_name, "metadata.protocol_name"),
    requestedModel: requireString(raw.requested_model, "metadata.requested_model"),
    resolvedModel: optionalString(raw.resolved_model, "metadata.resolved_model"),
    requestId: optionalString(raw.request_id, "metadata.request_id"),
    responseId: optionalString(raw.response_id, "metadata.response_id"),
  };
}

function usageFromWire(raw: unknown): ChatUsage {
  if (!isRecord(raw)) throw new WireFormatError("usage 必须是对象");
  return {
    inputTokens: optionalNumber(raw.input_tokens, "usage.input_tokens"),
    outputTokens: optionalNumber(raw.output_tokens, "usage.output_tokens"),
    totalTokens: optionalNumber(raw.total_tokens, "usage.total_tokens"),
    reasoningTokens: optionalNumber(raw.reasoning_tokens, "usage.reasoning_tokens"),
    cacheReadTokens: optionalNumber(raw.cache_read_tokens, "usage.cache_read_tokens"),
    cacheWriteTokens: optionalNumber(raw.cache_write_tokens, "usage.cache_write_tokens"),
  };
}

function partKindFromWire(raw: unknown): PartKind {
  const kind = requireString(raw, "part_started.kind");
  if (kind === "text" || kind === "reasoning" || kind === "tool_call") {
    return kind === "tool_call" ? "tool-call" : kind;
  }
  throw new WireFormatError(`未知的 part kind：${kind}`);
}

const FINISH_REASONS = new Set<string>([
  "stop",
  "tool-calls",
  "output-limit",
  "content-filtered",
  "other",
]);

function finishReasonFromWire(raw: unknown): FinishReason {
  const reason = requireString(raw, "finish.reason");
  if (!FINISH_REASONS.has(reason)) {
    throw new WireFormatError(`未知的 finish reason：${reason}`);
  }
  return reason as FinishReason;
}

function outputContentFromWire(raw: unknown): OutputContent {
  if (!isRecord(raw)) throw new WireFormatError("content 必须是对象");
  switch (raw.type) {
    case "text":
      return { type: "text", text: requireString(raw.text, "content.text") };
    case "reasoning":
      return { type: "reasoning", text: requireString(raw.text, "content.text") };
    case "tool_call":
      return {
        type: "tool-call",
        call: {
          callId: requireString(raw.call_id, "content.call_id"),
          name: requireString(raw.name, "content.name"),
          inputText: requireString(raw.input_text, "content.input_text"),
          output: raw.output,
          errorText: optionalString(raw.error_text, "content.error_text"),
        },
      };
    default:
      throw new WireFormatError(`未知的 content type：${String(raw.type)}`);
  }
}

const ERROR_KINDS = new Set<string>([
  "invalid-request",
  "unsupported",
  "authentication",
  "rate-limited",
  "unavailable",
  "transport",
  "timeout",
  "invalid-response",
  "truncated",
  "replay-mismatch",
  "aborted",
]);

function errorFromWire(raw: unknown): ChatError {
  if (!isRecord(raw)) throw new WireFormatError("error 必须是对象");
  const kind = requireString(raw.kind, "error.kind");
  return {
    // 未识别的 kind 不阻断消息展示，降级为 unknown。
    kind: (ERROR_KINDS.has(kind) ? kind : "unknown") as ChatError["kind"],
    message: requireString(raw.message, "error.message"),
  };
}

/* ---------- 事件级转换 ---------- */

/** 把一帧线格式 JSON 转为 `ChatEvent`；载荷不合法时抛 `WireFormatError`。 */
export function chatEventFromWire(raw: unknown): ChatEvent {
  if (!isRecord(raw)) throw new WireFormatError("事件帧必须是对象");
  switch (raw.type) {
    case "started":
      return { type: "started", metadata: metadataFromWire(raw.metadata) };
    case "part_started":
      return {
        type: "part-started",
        partId: requirePartId(raw.part, "part_started.part"),
        kind: partKindFromWire(raw.kind),
        name: optionalString(raw.name, "part_started.name"),
      };
    case "delta": {
      if (!isRecord(raw.delta) || raw.delta.type !== "text") {
        throw new WireFormatError("delta 必须是 { type: \"text\", text } 形状");
      }
      return {
        type: "delta",
        partId: requirePartId(raw.part, "delta.part"),
        text: requireString(raw.delta.text, "delta.text"),
      };
    }
    case "part_completed":
      return {
        type: "part-completed",
        partId: requirePartId(raw.part, "part_completed.part"),
        content: outputContentFromWire(raw.content),
      };
    case "usage":
      return { type: "usage", usage: usageFromWire(raw.usage) };
    case "completed": {
      if (!isRecord(raw.response)) {
        throw new WireFormatError("completed.response 必须是对象");
      }
      const response = raw.response;
      if (!isRecord(response.assistant) || !Array.isArray(response.assistant.parts)) {
        throw new WireFormatError("completed.response.assistant.parts 必须是数组");
      }
      if (!isRecord(response.finish)) {
        throw new WireFormatError("completed.response.finish 必须是对象");
      }
      return {
        type: "completed",
        response: {
          assistant: {
            parts: response.assistant.parts.map(outputContentFromWire),
          },
          finish: {
            reason: finishReasonFromWire(response.finish.reason),
            providerReason: optionalString(
              response.finish.provider_reason,
              "finish.provider_reason",
            ),
          },
          usage: usageFromWire(response.usage),
          metadata: metadataFromWire(response.metadata),
        },
      };
    }
    case "failed":
      return { type: "failed", error: errorFromWire(raw.error) };
    default:
      throw new WireFormatError(`未知的事件 type：${String(raw.type)}`);
  }
}

/** invoke 方向：前端请求 → 线格式 JSON。附件在线格式中尚无承载，暂不序列化。 */
export function chatRequestToWire(request: ChatRequest): WireGenerationRequest {
  return {
    messages: request.messages.map((message) => ({
      role: "user",
      text: message.text,
    })),
    instructions: request.instructions,
  };
}

/**
 * 把「JSON 文本帧」流（NDJSON 行 / SSE data / Tauri channel 载荷）适配为 `ChatEvent` 流。
 * JSON 解析错误与线格式错误统一转为 `failed` 事件收尾，而不是让迭代器抛出——
 * 与 Rust 侧「错误以 Err 终止流」的契约一致。
 */
export async function* chatEventsFromFrames(
  frames: AsyncIterable<string>,
): AsyncIterable<ChatEvent> {
  for await (const frame of frames) {
    const trimmed = frame.trim();
    if (trimmed === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      yield {
        type: "failed",
        error: { kind: "invalid-response", message: "事件帧不是合法 JSON。" },
      };
      return;
    }
    let event: ChatEvent;
    try {
      event = chatEventFromWire(parsed);
    } catch (error) {
      yield {
        type: "failed",
        error: {
          kind: "invalid-response",
          message:
            error instanceof WireFormatError
              ? `事件帧格式不合法：${error.message}`
              : "事件帧格式不合法。",
        },
      };
      return;
    }
    yield event;
    // completed / failed 均为流的终止事件，后续帧忽略。
    if (event.type === "completed" || event.type === "failed") return;
  }
}
