"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import { File01Icon, Image01Icon } from "@hugeicons-pro/core-stroke-rounded";
import type { AgentChatAttachment, AgentChatInputOption } from "./types";

export function findLabel(
  options: readonly AgentChatInputOption[],
  value: string,
) {
  return options.find((option) => option.id === value)?.label ?? value;
}

export function attachmentIcon(type?: string) {
  if (type?.startsWith("image/")) {
    return (
      <span className="shrink-0 text-muted-foreground">
        <HugeiconsIcon icon={Image01Icon} className="size-3.5" />
      </span>
    );
  }

  return (
    <span className="shrink-0 text-muted-foreground">
      <HugeiconsIcon icon={File01Icon} className="size-3.5" />
    </span>
  );
}

export function isImageAttachment(attachment: AgentChatAttachment) {
  return (
    attachment.type?.startsWith("image/") ||
    /\.(avif|gif|jpe?g|png|svg|webp)$/i.test(attachment.name) ||
    (attachment.url
      ? /\.(avif|gif|jpe?g|png|svg|webp)(\?.*)?$/i.test(attachment.url)
      : false)
  );
}
