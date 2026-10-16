"use client";

import * as React from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  AlertCircleIcon,
  CheckIcon,
  Square01Icon,
} from "@hugeicons-pro/core-stroke-rounded";

import type { MessageState, PartView, ToolState } from "@/chat/fold.ts";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@/components/ui/trace";
import { CodeBlock, CodeBlockContent } from "@/components/ui/code-block";

/** 工具名 → 中文动词。未知工具回退为「执行」。 */
const TOOL_VERBS: Record<string, string> = {
  readBuildLog: "读取构建日志",
  searchCode: "搜索代码",
  searchWeb: "搜索网页",
};

function StatusIcon({ status }: { status?: "running" | "error" | "pending" }) {
  if (status === "running") {
    // CDS 三点波浪代替通用旋转圈，贴合 Claude 的思考中指示。
    return (
      <span className="flex items-center gap-0.5">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="chat-quiet-dot size-1 rounded-full bg-primary"
          />
        ))}
      </span>
    );
  }
  return (
    <HugeiconsIcon
      icon={
        status === "error"
          ? AlertCircleIcon
          : status === "pending"
            ? Square01Icon
            : CheckIcon
      }
      className="size-3.5"
    />
  );
}

function stepStatus(state: ToolState, messageState: MessageState) {
  if (state !== "running") return state === "error" ? "error" : undefined;
  if (messageState === "streaming") return "running";
  return messageState === "failed" ? "error" : "pending";
}

function toolTitle(
  name: string,
  state: ToolState,
  messageState: MessageState,
): string {
  const verb = TOOL_VERBS[name] ?? `执行 ${name || "工具"}`;
  if (state === "running") {
    if (messageState === "streaming") return `正在${verb}…`;
    if (messageState === "failed") return `${verb}中断`;
    return messageState === "stopped" ? `已停止${verb}` : `${verb}已结束`;
  }
  if (state === "error") return `${verb}失败`;
  return `已${verb}`;
}

function ToolStep({
  part,
  messageState,
}: {
  part: Extract<PartView, { kind: "tool" }>;
  messageState: MessageState;
}) {
  const status = stepStatus(part.state, messageState);

  const detail =
    part.state === "error" && part.errorText ? (
      <CodeBlock size="sm" variant="destructive">
        <CodeBlockContent wrap className="max-h-64">
          {part.errorText}
        </CodeBlockContent>
      </CodeBlock>
    ) : part.output !== undefined ? (
      <CodeBlock size="sm">
        <CodeBlockContent wrap className="max-h-64">
          {typeof part.output === "string"
            ? part.output
            : JSON.stringify(part.output, null, 2)}
        </CodeBlockContent>
      </CodeBlock>
    ) : null;

  const line = (
    <TraceLine status={status}>
      <TraceIcon>
        <StatusIcon status={status} />
      </TraceIcon>
      <TraceTitle>{toolTitle(part.name, part.state, messageState)}</TraceTitle>
    </TraceLine>
  );

  if (!detail) return line;

  return (
    <TraceCollapsible defaultOpen={part.state === "error"}>
      <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
      <TraceCollapsibleContent>{detail}</TraceCollapsibleContent>
    </TraceCollapsible>
  );
}

function ReasoningStep({
  part,
  messageState,
}: {
  part: Extract<PartView, { kind: "reasoning" }>;
  messageState: MessageState;
}) {
  const status = stepStatus(part.state, messageState);
  let title = "已思考";
  if (status === "running") title = "正在思考…";
  if (status === "error") title = "思考中断";
  if (status === "pending") {
    title = messageState === "stopped" ? "思考已停止" : "思考已结束";
  }
  const line = (
    <TraceLine status={status}>
      <TraceIcon>
        <StatusIcon status={status} />
      </TraceIcon>
      <TraceTitle>{title}</TraceTitle>
    </TraceLine>
  );
  if (!part.text) return line;
  return (
    <TraceCollapsible>
      <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
      <TraceCollapsibleContent>
        <p className="whitespace-pre-wrap">{part.text}</p>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 1) return "不足 1 秒";
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

export function ChainOfThought({
  parts,
  streaming,
  answering,
  messageState = streaming ? "streaming" : "done",
}: {
  parts: PartView[];
  streaming: boolean;
  messageState?: MessageState;
  /** 正文已开始输出。 */
  answering: boolean;
}) {
  const [open, setOpen] = React.useState<boolean>();
  const unfinished = parts.some(
    (part) => part.kind !== "text" && part.state === "running",
  );
  const running = streaming && unfinished;
  const interrupted = !streaming && unfinished;
  const expanded = open ?? (streaming && !answering);
  const failed = parts.filter(
    (part) =>
      part.kind !== "text" && stepStatus(part.state, messageState) === "error",
  ).length;
  const status = running
    ? "running"
    : failed > 0
      ? "error"
      : interrupted
        ? "pending"
        : undefined;

  // 计时：流式开始到结束的实际耗时，完成后并入摘要行（重挂载后丢失，可接受）。
  const startedAt = React.useRef<number | null>(null);
  const [elapsedMs, setElapsedMs] = React.useState<number | null>(null);
  React.useEffect(() => {
    if (streaming) {
      if (startedAt.current === null) {
        startedAt.current = Date.now();
        setElapsedMs(null);
      }
    } else if (startedAt.current !== null) {
      setElapsedMs(Date.now() - startedAt.current);
      startedAt.current = null;
    }
  }, [streaming]);

  let summary = `已研究 ${parts.length} 步${failed > 0 ? `，${failed} 步失败` : ""}`;
  if (running) {
    summary = "正在研究…";
  } else if (interrupted) {
    summary = "研究已结束";
    if (messageState === "failed") summary = "研究中断";
    if (messageState === "stopped") summary = "研究已停止";
  }
  if (!running && elapsedMs !== null) {
    summary += ` · 用时 ${formatDuration(elapsedMs)}`;
  }

  return (
    <Trace>
      <TraceCollapsible open={expanded} onOpenChange={setOpen}>
        <TraceCollapsibleTrigger>
          <TraceLine status={status}>
            <TraceIcon>
              <StatusIcon status={status} />
            </TraceIcon>
            <TraceTitle>{summary}</TraceTitle>
          </TraceLine>
        </TraceCollapsibleTrigger>
        {/* 保留子步骤展开状态；forceMount 时显式隐藏，避免关闭动画结束后回弹。 */}
        <TraceCollapsibleContent forceMount hidden={!expanded}>
          <Trace>
            {parts.map((part, index) =>
              part.kind === "reasoning" ? (
                <ReasoningStep
                  key={index}
                  part={part}
                  messageState={messageState}
                />
              ) : part.kind === "tool" ? (
                <ToolStep key={index} part={part} messageState={messageState} />
              ) : null,
            )}
          </Trace>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  );
}
