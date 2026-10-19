"use client";

import { X } from "lucide-react";
import {
  AnimatedModal,
  AnimatedModalTitle,
} from "@beui-template/components/motion/animated-modal";
import { Button } from "@beui-template/components/motion/button";
import {
  type AgentChatCreditsLabels,
  DEFAULT_CREDITS_LABELS,
} from "./credits-labels";
import type { AgentChatAttachment } from "./types";

export function CreditsImagePreview({
  labels = DEFAULT_CREDITS_LABELS,
  attachment,
  src,
  onClose,
}: {
  labels?: AgentChatCreditsLabels;
  attachment?: AgentChatAttachment;
  src?: string;
  reduce?: boolean | null;
  onClose: () => void;
}) {
  return (
    <AnimatedModal
      open={Boolean(attachment && src)}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      panelClassName="relative flex max-w-5xl flex-col overflow-hidden rounded-2xl border border-border"
    >
      <AnimatedModalTitle className="sr-only">
        {labels.previewAttachment(attachment?.name ?? "Attachment")}
      </AnimatedModalTitle>
      <Button
        size="icon"
        variant="secondary"
        data-autofocus
        aria-label={labels.closePreview}
        onClick={onClose}
        className="absolute right-3 top-3 z-10"
      >
        <X aria-hidden className="size-4" />
      </Button>
      {src && attachment ? (
        <>
          {/* biome-ignore lint/performance/noImgElement: Blob and consumer URLs are not compatible with next/image. */}
          <img
            src={src}
            alt={attachment.name}
            className="max-h-[80dvh] max-w-full object-contain"
          />
          <p className="border-t border-border px-4 py-3 text-sm text-muted-foreground">
            {attachment.name}
          </p>
        </>
      ) : null}
    </AnimatedModal>
  );
}
