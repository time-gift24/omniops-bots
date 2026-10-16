/**
 * 对话数据网关：界面与数据来源之间的唯一边界。
 * 实现可替换（mock / Tauri IPC / Web 接口），调用方只依赖此接口与 DTO。
 */

import type { ChatEvent, ChatRequest } from "./dto.ts";

export interface ChatGateway {
  /** 提交一轮对话输入，以事件流接收响应。流以 completed / failed 之一收尾。 */
  stream(request: ChatRequest): AsyncIterable<ChatEvent>;
  /** 中止当前响应。仅用户显式停止时调用。 */
  abort(): void;
}
