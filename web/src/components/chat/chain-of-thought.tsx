"use client";

import * as React from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  AlertCircleIcon,
  CheckIcon,
  Loading03Icon,
} from "@hugeicons-pro/core-stroke-rounded";

import type { PartView, ToolState } from "@/chat/fold.ts";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@/components/ui/trace";
import {
  CodeBlock,
  CodeBlockContent,
} from "@/components/ui/code-block";

/** 工具名 → 中文动词。未知工具回退为「执行」。 */
const TOOL_VERBS: Record<string, string> = {
  readBuildLog: "读取构建日志",
  searchCode: "搜索代码",
  searchWeb: "搜索网页",
};

function StatusIcon({ status }: { status?: "running" | "error" }) {
  if (status === "running") {
    return (
      <HugeiconsIcon
        icon={Loading03Icon}
        className="size-3.5 motion-safe:animate-spin"
      />
    );
  }
  return (
    <HugeiconsIcon
      icon={status === "error" ? AlertCircleIcon : CheckIcon}
      className="size-3.5"
    />
  );
}

function toolTitle(name: string, state: ToolState): string {
  const verb = TOOL_VERBS[name] ?? `执行 ${name || "工具"}`;
  if (state === "running") return `正在${verb}…`;
  if (state === "error") return `${verb}失败`;
  return `已${verb}`;
}

function ToolStep({ part }: { part: Extract<PartView, { kind: "tool" }> }) {
  const status =
    part.state === "running" ? "running" : part.state === "error" ? "error" : undefined;

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
      <TraceTitle>{toolTitle(part.name, part.state)}</TraceTitle>
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

function ReasoningStep({ part }: { part: Extract<PartView, { kind: "reasoning" }> }) {
  const running = part.text.length === 0;
  const line = (
    <TraceLine status={running ? "running" : undefined}>
      <TraceIcon>
        <StatusIcon status={running ? "running" : undefined} />
      </TraceIcon>
      <TraceTitle>{running ? "正在思考…" : "已思考"}</TraceTitle>
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

export function ChainOfThought({
  parts,
  streaming,
  answering,
}: {
  parts: PartView[];
  streaming: boolean;
  /** 正文已开始输出。 */
  answering: boolean;
}) {
  const [open, setOpen] = React.useState<boolean>();
  const running = streaming && !answering;
  const failed = parts.filter(
    (part) => part.kind === "tool" && part.state === "error",
  ).length;
  const status = running ? "running" : failed > 0 ? "error" : undefined;

  return (
    <Trace>
      <TraceCollapsible open={open ?? running} onOpenChange={setOpen}>
        <TraceCollapsibleTrigger>
          <TraceLine status={status}>
            <TraceIcon>
              <StatusIcon status={status} />
            </TraceIcon>
            <TraceTitle>
              {running
                ? "正在研究…"
                : `已研究 ${parts.length} 步${failed > 0 ? `，${failed} 步失败` : ""}`}
            </TraceTitle>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent forceMount>
          <Trace>
            {parts.map((part, index) =>
              part.kind === "reasoning" ? (
                <ReasoningStep key={index} part={part} />
              ) : part.kind === "tool" ? (
                <ToolStep key={index} part={part} />
              ) : null,
            )}
          </Trace>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  );
}
