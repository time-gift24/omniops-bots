import type { ComponentType } from "react"
import type { MarkProps } from "./ai-chat-marks"

/* Types ------------------------------------------------------------------------------------------------------------ */

export type ChatMark = ComponentType<MarkProps>

export interface ChatModel {
  id: string
  name: string
  /** Short muted text in the model menu, such as the provider. */
  note?: string
  mark: ChatMark
  /** Brand color for a mono mark. Color marks keep their own fills. */
  color?: string
}

export interface ChatSource {
  title: string
  url: string
  snippet?: string
  mark?: ChatMark
  color?: string
}

export interface ChatTool {
  id: string
  /** Done label, such as "Searched the web". */
  name: string
  /** Running label, such as "Searching the web". */
  activeName?: string
  status: "running" | "done" | "error"
  /** Short result after the name, such as "4 sources" or "40,213,880 rows". */
  summary?: string
  /** What the tool ran: search queries, or a query or command shown in mono. */
  input?: string[]
  output?: string
  sources?: ChatSource[]
  icon?: "search" | "database" | "code" | "file"
  mark?: ChatMark
  color?: string
}

export interface AiChatAttachment {
  id: string
  name: string
  size: number
  type?: string
}

export interface AiChatMessage {
  id?: string
  role: "user" | "assistant"
  /** Markdown. Paragraphs, ordered and bulleted lists, `inline code`, **bold**, fenced code blocks and [1] citations. */
  content: string
  /** Assistant only: the model id that wrote it. */
  model?: string
  reasoning?: string
  /** Seconds of reasoning, shown as "Thought for 4s". */
  thoughtFor?: number
  tools?: ChatTool[]
  /** Numbered in order: [1] cites the first source. */
  sources?: ChatSource[]
  attachments?: AiChatAttachment[]
  status?: "done" | "stopped" | "error"
  error?: string
}

export type ChatStreamEvent =
  | { type: "reasoning"; delta: string }
  | { type: "reasoning-end"; seconds?: number }
  | { type: "tool"; tool: ChatTool }
  | { type: "sources"; sources: ChatSource[] }
  | { type: "text"; delta: string }
  | { type: "error"; message: string }

export interface ChatRespondOptions {
  signal: AbortSignal
  model: ChatModel
}
/** Streams one assistant reply. The reply ends when the iterable finishes; throw or yield an error event to fail it. */
export type ChatRespond = (
  messages: AiChatMessage[],
  options: ChatRespondOptions
) => AsyncIterable<ChatStreamEvent>

export interface ChatSuggestion {
  label: string
  prompt?: string
  icon?: "database" | "timer" | "activity" | "search"
}
