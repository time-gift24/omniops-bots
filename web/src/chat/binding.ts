import type { ChatGateway } from "./gateway.ts";
import type { ThreadId } from "./dto.ts";
import { createMockGateway } from "./mock-gateway.ts";

let gatewayFor: (threadId: ThreadId) => ChatGateway = () => createMockGateway();

/** 工厂为每个线程创建独立网关，abort 只影响所属线程。 */
export function bindChatGateway(factory: (threadId: ThreadId) => ChatGateway): void {
  gatewayFor = factory;
}

export function getChatGateway(threadId: ThreadId): ChatGateway {
  return gatewayFor(threadId);
}
