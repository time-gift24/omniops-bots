/**
 * 前端对话 DTO。
 *
 * 与后端 `cognacta-core` 的 `GenerationEvent` 体系当前语义一一等价（各字段注释标明映射），
 * 但类型独立命名、独立演进：后端契约变更只影响网关适配层，界面代码不依赖后端类型。
 * `reasoning` / `tool-call` / `tool-result` 为前瞻扩展位——后端目前只产出 Text 部分。
 */

export type ThreadId = string;
export type PartId = number;

/** ↔ 后端 PartKind。后端当前仅 `Text`；`reasoning` / `tool-call` 为扩展位。 */
export type PartKind = "text" | "reasoning" | "tool-call";

/** ↔ GenerationMetadata。 */
export interface ChatMetadata {
  providerName: string;
  protocolName: string;
  requestedModel: string;
  resolvedModel?: string;
  requestId?: string;
  responseId?: string;
}

/** ↔ Usage。provider 未上报的计数保持 undefined。 */
export interface ChatUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** ↔ FinishReason（snake_case 为前端命名习惯）。 */
export type FinishReason =
  | "stop"
  | "tool-calls"
  | "output-limit"
  | "content-filtered"
  | "other";

/** 工具调用的完整信息（扩展位，后端尚无对应事件）。 */
export interface ToolCallContent {
  callId: string;
  name: string;
  /** 序列化后的参数 JSON 文本。 */
  inputText: string;
  /** 执行结果；失败时由 errorText 承载。 */
  output?: unknown;
  errorText?: string;
}

/** ↔ OutputPart。后端当前仅 Text。 */
export type OutputContent =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool-call"; call: ToolCallContent };

/** ↔ AssistantMessage。 */
export interface AssistantTurn {
  parts: OutputContent[];
}

/** ↔ GenerationResponse。 */
export interface ChatResponse {
  assistant: AssistantTurn;
  finish: { reason: FinishReason; providerReason?: string };
  usage: ChatUsage;
  metadata: ChatMetadata;
}

/** ↔ 后端 ErrorKind（kebab-case 一一对应）；`aborted` 为客户端本地中止，`unknown` 为未识别 kind 的降级。 */
export interface ChatError {
  kind:
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
  message: string;
}

/**
 * ↔ GenerationEvent。成功流以 `completed` 收尾后 EOF；失败流以 `failed` 收尾后 EOF。
 */
export type ChatEvent =
  | { type: "started"; metadata: ChatMetadata } // ↔ Started
  | { type: "part-started"; partId: PartId; kind: PartKind; name?: string } // ↔ PartStarted；name 为工具名扩展位
  | { type: "delta"; partId: PartId; text: string } // ↔ Delta（PartDelta::Text；工具部分承载参数 JSON 片段）
  | { type: "part-completed"; partId: PartId; content: OutputContent } // ↔ PartCompleted
  | { type: "usage"; usage: ChatUsage } // ↔ Usage
  | { type: "completed"; response: ChatResponse } // ↔ Completed
  | { type: "failed"; error: ChatError }; // ↔ 流以 Err 终止

/** ↔ Message::User（InputPart::Text）+ 附件扩展位。 */
export interface ChatRequestMessage {
  role: "user";
  text: string;
  attachments?: { name: string; mediaType: string }[];
}

/** ↔ GenerationRequest。 */
export interface ChatRequest {
  messages: ChatRequestMessage[];
  instructions?: string;
  /** 请求模型 ID（扩展位，↔ 后端 GenerationRequest 的模型字段）。 */
  model?: string;
}
