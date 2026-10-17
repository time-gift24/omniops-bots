import type { ChatEvent, ChatRequest } from "./dto.ts";

export interface ChatGateway {
  /** 流以 completed / failed 之一收尾。 */
  stream(request: ChatRequest): AsyncIterable<ChatEvent>;
  /** 中止当前响应。仅用户显式停止时调用。 */
  abort(): void;
}
