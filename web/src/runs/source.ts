import type { ChatEvent, ChatResponse } from "../chat/dto"

export type RunStatus =
  | "preparing"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed-out"
  | "interrupted"
export type RunSnapshot = Readonly<Record<string, unknown>>
export type SessionContext = {
  historyRunId?: string
  agentId?: string
  agentContentId?: string
  experimentSkillId?: string
}
export type RunRecord = {
  origin?: "a2a"
  delivery?: {
    taskId: string
    state: "pending" | "confirmed"
    receivedAt?: string
  }
  runId: string
  threadId: string
  agentId?: string
  title: string
  status: RunStatus
  startedAt: string
  endedAt?: string
  error?: { kind: string; message: string }
  result?: ChatResponse
  /** Remote A2A results retain their JSON shape, including null/false/0. */
  output?: unknown
  snapshot?: RunSnapshot
  events?: ChatEvent[]
  inputMessages?: {
    role: "user"
    text: string
    attachments?: { id?: string; name: string; mediaType: string }[]
  }[]
}

/** The runtime owns persisted records and immutable session assemblies.
 * Binding a new frontend session performs no IO and must not change an existing binding.
 * Reading history never executes a model or resumes interrupted work.
 */
export interface RunSource {
  /** State changes only invalidate cached reads; unsubscribing never stops a run. */
  subscribe?(listener: () => void): () => void
  bindSession(threadId: string, context: SessionContext): void
  list(): Promise<readonly RunRecord[]>
  get(runId: string): Promise<RunRecord>
  snapshot(threadId: string): Promise<RunSnapshot | null>
}
