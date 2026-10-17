import type { ChatGateway } from "./gateway.ts";
import { createMockGateway } from "./mock-gateway.ts";

let bound: ChatGateway | undefined;

export function bindChatGateway(gateway: ChatGateway): void {
  bound = gateway;
}

export function getChatGateway(): ChatGateway {
  bound ??= createMockGateway();
  return bound;
}
