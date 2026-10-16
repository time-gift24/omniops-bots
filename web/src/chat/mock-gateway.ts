/**
 * Mock 网关：脚本化事件流，驱动界面全部状态而无需后端。
 *
 * 触发词（写在消息文本里）：
 * - `[fail-send]`：提交即失败（网络错误），演示发送失败态。
 * - `[fail-step]`：第二个工具步骤失败，演示思维链失败态。
 * - `[slow]`：逐段延迟放大 8 倍，演示停止按钮与长流。
 */

import type { ChatGateway } from "./gateway.ts";
import type { ChatEvent, ChatRequest, ChatUsage } from "./dto.ts";

export interface MockGatewayOptions {
  /** 每个事件之间的基础延迟（ms），默认 45。 */
  delayMs?: number;
}

const DEMO_REPLY = `先把问题拆成两半：缓存键不该包含提交哈希。

建议改为按图片目录键控：

\`\`\`ts
const cacheKey = \`img:\${dir}:\${process.env.CONTENT_HASH}\`
\`\`\`

这样同目录的图片在多次部署间共享缓存，构建时间从约 4 分钟降到 20 秒以内。`;

const sleep = (ms: number, signal: { aborted: boolean }) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    setTimeout(resolve, ms);
  });

/** 把文本切成若干片段，模拟 token 级流式增量。小片段 + 短间隔，吐字更连贯。 */
function chunkText(text: string, size = 3): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    chunks.push(text.slice(i, i + size));
  }
  return chunks;
}

export function createMockGateway(
  options: MockGatewayOptions = {},
): ChatGateway {
  const baseDelay = options.delayMs ?? 45;
  let active: { aborted: boolean } | undefined;

  async function* script(
    request: ChatRequest,
    signal: { aborted: boolean },
  ): AsyncGenerator<ChatEvent> {
    const text = request.messages.at(-1)?.text ?? "";
    const delay = baseDelay * (text.includes("[slow]") ? 8 : 1);
    const tick = () => sleep(delay, signal);
    const alive = () => !signal.aborted;
    if (!alive()) return;

    const metadata = {
      providerName: "mock-provider",
      protocolName: "mock.streaming",
      requestedModel: "pine-chat-latest",
      resolvedModel: "pine-chat-2026-10",
      requestId: "req_mock_001",
      responseId: "resp_mock_001",
    };

    if (text.includes("[fail-send]")) {
      yield { type: "started", metadata };
      await tick();
      if (!alive()) return;
      yield {
        type: "failed",
        error: {
          kind: "transport",
          message: "连接模型服务失败，请检查网络后重试。",
        },
      };
      return;
    }

    yield { type: "started", metadata };
    await tick();
    if (!alive()) return;

    // 推理部分（扩展位演示）
    yield { type: "part-started", partId: 0, kind: "reasoning" };
    const reasoning = "先确认缓存键的构成，再核对部署日志里的耗时分布。";
    for (const chunk of chunkText(reasoning, 4)) {
      await tick();
      if (!alive()) return;
      yield { type: "delta", partId: 0, text: chunk };
    }
    yield {
      type: "part-completed",
      partId: 0,
      content: { type: "reasoning", text: reasoning },
    };

    // 工具步骤 1：读部署日志
    yield {
      type: "part-started",
      partId: 1,
      kind: "tool-call",
      name: "readBuildLog",
    };
    const input1 = JSON.stringify({ deployment: "dpl_8Kx2" });
    for (const chunk of chunkText(input1, 12)) {
      await tick();
      if (!alive()) return;
      yield { type: "delta", partId: 1, text: chunk };
    }
    await tick();
    if (!alive()) return;
    yield {
      type: "part-completed",
      partId: 1,
      content: {
        type: "tool-call",
        call: {
          callId: "call_log_1",
          name: "readBuildLog",
          inputText: input1,
          output: { log: "install    41s\ncompile    38s\nimages   3m 52s" },
        },
      },
    };

    // 工具步骤 2：检索代码（[fail-step] 时失败）
    yield {
      type: "part-started",
      partId: 2,
      kind: "tool-call",
      name: "searchCode",
    };
    const input2 = JSON.stringify({ query: "cacheKey" });
    for (const chunk of chunkText(input2, 12)) {
      await tick();
      if (!alive()) return;
      yield { type: "delta", partId: 2, text: chunk };
    }
    await tick();
    if (!alive()) return;
    if (text.includes("[fail-step]")) {
      yield {
        type: "part-completed",
        partId: 2,
        content: {
          type: "tool-call",
          call: {
            callId: "call_search_2",
            name: "searchCode",
            inputText: input2,
            errorText: "索引服务 503：search backend unavailable",
          },
        },
      };
    } else {
      yield {
        type: "part-completed",
        partId: 2,
        content: {
          type: "tool-call",
          call: {
            callId: "call_search_2",
            name: "searchCode",
            inputText: input2,
            output: { files: ["next.config.ts", "scripts/optimize-images.ts"] },
          },
        },
      };
    }

    // 正文（Markdown，含代码块）
    yield { type: "part-started", partId: 3, kind: "text" };
    for (const chunk of chunkText(DEMO_REPLY)) {
      await tick();
      if (!alive()) return;
      yield { type: "delta", partId: 3, text: chunk };
    }
    yield {
      type: "part-completed",
      partId: 3,
      content: { type: "text", text: DEMO_REPLY },
    };

    const usage: ChatUsage = {
      inputTokens: 312,
      outputTokens: 486,
      totalTokens: 798,
      reasoningTokens: 96,
    };
    yield { type: "usage", usage };
    yield {
      type: "completed",
      response: {
        assistant: { parts: [{ type: "text", text: DEMO_REPLY }] },
        finish: { reason: "stop" },
        usage,
        metadata,
      },
    };
  }

  return {
    stream(request) {
      const signal = { aborted: false };
      active = signal;
      return script(request, signal);
    },
    abort() {
      if (active) active.aborted = true;
    },
  };
}
