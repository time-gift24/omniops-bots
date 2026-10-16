"use client";

import * as React from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  AlertCircleIcon,
  CheckIcon,
  Copy01Icon,
  PencilEdit01Icon,
  RefreshCcwIcon,
  ThumbsDownIcon,
  ThumbsUpIcon,
} from "@hugeicons-pro/core-stroke-rounded";

import type { ChatMessageView } from "@/chat/fold.ts";
import { Markdown } from "@/components/chat/markdown";
import { ChainOfThought } from "@/components/chat/chain-of-thought";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import { Message, MessageContent, MessageFooter } from "@/components/ui/message";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

function MessageAction({
  label,
  pressed,
  onClick,
  children,
}: {
  label: string;
  pressed?: boolean;
  onClick?: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          aria-pressed={pressed}
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        <p>{label}</p>
      </TooltipContent>
    </Tooltip>
  );
}

function messageText(message: ChatMessageView): string {
  return message.parts
    .filter((part) => part.kind === "text")
    .map((part) => part.text)
    .join("");
}

export function MessageView({
  message,
  streaming,
  onRetry,
  onEdit,
}: {
  message: ChatMessageView;
  /** 是否为正在流式输出的最后一条 assistant 消息。 */
  streaming: boolean;
  onRetry: () => void;
  /** 把用户消息文本放回输入框。 */
  onEdit?: (text: string) => void;
}) {
  const [copied, setCopied] = React.useState(false);
  const [feedback, setFeedback] = React.useState<"up" | "down" | null>(null);

  React.useEffect(() => {
    if (!copied) return;
    const timeout = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timeout);
  }, [copied]);

  if (message.role === "user") {
    const text = messageText(message);
    return (
      <Message align="end" className="chat-bubble-enter">
        <MessageContent className="gap-2">
          <Bubble align="end" variant="muted">
            <BubbleContent>{text}</BubbleContent>
            {message.attachments && message.attachments.length > 0 && (
              <ul
                aria-label="消息附件"
                className="mt-1.5 flex flex-wrap justify-end gap-1 border-t border-border/60 pt-1.5"
              >
                {message.attachments.map((attachment, index) => (
                  <li
                    key={`${attachment.name}-${index}`}
                    className="max-w-full truncate rounded-full bg-background/70 px-2 py-0.5 text-xs text-muted-foreground"
                  >
                    {attachment.name}
                  </li>
                ))}
              </ul>
            )}
          </Bubble>
          <MessageFooter>
            <MessageAction
              label="复制"
              onClick={() => void navigator.clipboard.writeText(text)}
            >
              <HugeiconsIcon icon={Copy01Icon} className="size-4" />
            </MessageAction>
            {onEdit && (
              <MessageAction label="编辑" onClick={() => onEdit(text)}>
                <HugeiconsIcon icon={PencilEdit01Icon} className="size-4" />
              </MessageAction>
            )}
          </MessageFooter>
        </MessageContent>
      </Message>
    );
  }

  const steps = message.parts.filter(
    (part) => part.kind === "reasoning" || part.kind === "tool",
  );
  const textParts = message.parts.filter((part) => part.kind === "text");
  const text = messageText(message);
  const answering = text.length > 0;

  return (
    <Message className="chat-message-enter">
      <MessageContent className="gap-4">
        {steps.length > 0 && (
          <ChainOfThought
            parts={steps}
            streaming={streaming && message.state === "streaming"}
            answering={answering}
          />
        )}
        {textParts.map((part, index) =>
          part.kind === "text" && part.text ? (
            <Markdown key={index}>{part.text}</Markdown>
          ) : null,
        )}
        {message.state === "failed" && (
          <div className="flex items-center gap-2 text-sm text-destructive">
            <HugeiconsIcon icon={AlertCircleIcon} className="size-4" />
            <span>回复中断，已保留已输出的内容。</span>
            <Button variant="ghost" size="sm" onClick={onRetry}>
              <HugeiconsIcon icon={RefreshCcwIcon} className="size-4" />
              重试
            </Button>
          </div>
        )}
        {message.state === "stopped" && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span>已停止。</span>
            <Button variant="ghost" size="sm" onClick={onRetry}>
              <HugeiconsIcon icon={RefreshCcwIcon} className="size-4" />
              重新生成
            </Button>
          </div>
        )}
        {message.state === "done" && (
          <MessageFooter className="px-0">
            <MessageAction
              label={copied ? "已复制" : "复制"}
              onClick={() => {
                void navigator.clipboard.writeText(text);
                setCopied(true);
              }}
            >
              <HugeiconsIcon
                icon={copied ? CheckIcon : Copy01Icon}
                className="size-4"
              />
            </MessageAction>
            <MessageAction
              label="回答有帮助"
              pressed={feedback === "up"}
              onClick={() => setFeedback(feedback === "up" ? null : "up")}
            >
              <HugeiconsIcon
                icon={ThumbsUpIcon}
                className={
                  feedback === "up" ? "size-4 fill-current" : "size-4"
                }
              />
            </MessageAction>
            <MessageAction
              label="回答无帮助"
              pressed={feedback === "down"}
              onClick={() => setFeedback(feedback === "down" ? null : "down")}
            >
              <HugeiconsIcon
                icon={ThumbsDownIcon}
                className={
                  feedback === "down" ? "size-4 fill-current" : "size-4"
                }
              />
            </MessageAction>
            <MessageAction label="重试" onClick={onRetry}>
              <HugeiconsIcon icon={RefreshCcwIcon} className="size-4" />
            </MessageAction>
          </MessageFooter>
        )}
      </MessageContent>
    </Message>
  );
}
