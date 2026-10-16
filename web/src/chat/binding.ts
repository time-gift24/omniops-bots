/**
 * 网关绑定入口：全局唯一的实现绑定。
 * 切换到 Tauri IPC / Web 接口时，只在这里替换实现，调用方代码不变。
 */

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
