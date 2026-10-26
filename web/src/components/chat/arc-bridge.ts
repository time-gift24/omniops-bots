import type { ChatMessageView, PartView } from "@/chat/fold"
import type { Turn, Reply } from "@/components/arc/blocks/ai-chat/chat-state"
import type { ChatTool } from "@/components/arc/blocks/ai-chat/chat-data"

export function messageText(
  message: Pick<ChatMessageView, "role" | "parts">
): string {
  return message.parts
    .filter((p) => p.kind === "text")
    .map((p) => p.text)
    .join(message.role === "assistant" ? "\n\n" : "")
}
function tool(
  part: Extract<PartView, { kind: "tool" }>,
  settled: boolean
): ChatTool {
  const state = settled && part.state === "running" ? "error" : part.state
  return {
    id: part.callId,
    name: part.name,
    activeName: part.name,
    status: state,
    input: part.inputText ? [part.inputText] : undefined,
    output:
      part.errorText ??
      (typeof part.output === "string"
        ? part.output
        : part.output === undefined
          ? undefined
          : JSON.stringify(part.output)),
    icon: /search|browse|chrome/i.test(part.name) ? "search" : "code",
  }
}
/** Adapt already-folded backend messages for Cognacta's presentation; owns no execution, replay or persistence. */
export function toArcTurns(
  messages: readonly ChatMessageView[],
  model: string,
  error?: string
): Turn[] {
  const turns: Turn[] = []
  for (const message of messages) {
    const text = messageText(message)
    if (message.role === "user") {
      const reply: Reply = {
        id: `pending:${message.id}`,
        model,
        status: "thinking",
        text: "",
        shown: 0,
        streamDone: false,
        reasoning: "",
        tools: [],
        sources: [],
        feedback: null,
      }
      turns.push({
        id: message.id,
        active: 0,
        versions: [
          {
            id: message.id,
            prompt: text,
            attachments: message.attachments?.map((file, i) => ({
              id: `${message.id}:${i}`,
              name: file.name,
              size: 0,
              type: file.mediaType,
            })),
            reply,
            next: null,
          },
        ],
      })
    } else {
      const turn = turns.at(-1)
      if (!turn) continue
      const settled = message.state !== "streaming"
      turn.versions[0].reply = {
        id: message.id,
        model,
        status:
          message.state === "failed"
            ? "error"
            : message.state === "streaming"
              ? text
                ? "streaming"
                : "thinking"
              : message.state,
        text,
        shown: text.length,
        streamDone: settled,
        reasoningDone:
          settled ||
          (message.parts.some((p) => p.kind === "reasoning") &&
            message.parts
              .filter((p) => p.kind === "reasoning")
              .every((p) => p.state === "done")),
        reasoning: message.parts
          .filter((p) => p.kind === "reasoning")
          .map((p) => p.text)
          .join("\n\n"),
        tools: message.parts
          .filter((p) => p.kind === "tool")
          .map((part) => tool(part, settled)),
        sources: [],
        feedback: null,
        error: message.state === "failed" ? error : undefined,
      }
    }
  }
  return turns
}
