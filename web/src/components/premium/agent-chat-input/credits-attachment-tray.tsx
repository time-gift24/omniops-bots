"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import { Cancel01Icon, File01Icon } from "@hugeicons-pro/core-stroke-rounded";
import { AnimatePresence, motion } from "motion/react";
import { Button } from "@/components/motion/button";
import { SPRING_PANEL, SPRING_PRESS } from "@/lib/ease";
import { isImageAttachment } from "./attachment-utils";
import {
  type AgentChatCreditsLabels,
  DEFAULT_CREDITS_LABELS,
} from "./credits-labels";
import type { AgentChatAttachment } from "./types";

export function CreditsAttachmentTray({
  labels = DEFAULT_CREDITS_LABELS,
  attachments,
  previewUrls,
  reduce,
  onPreview,
  onRemove,
}: {
  labels?: AgentChatCreditsLabels;
  attachments: readonly AgentChatAttachment[];
  previewUrls: Record<string, string>;
  reduce?: boolean | null;
  onPreview: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  return (
    <AnimatePresence initial={false}>
      {attachments.length > 0 ? (
        <motion.div
          key="attachment-tray"
          initial={reduce ? false : { height: 0, opacity: 0, y: -6 }}
          animate={{ height: "auto", opacity: 1, y: 0 }}
          exit={reduce ? undefined : { height: 0, opacity: 0, y: -6 }}
          transition={reduce ? { duration: 0 } : SPRING_PANEL}
          className="overflow-hidden"
        >
          <div className="scrollbar-hide flex gap-1.5 overflow-x-auto px-1.5 pt-2 pb-0.5">
            {attachments.map((attachment) => {
              const image = isImageAttachment(attachment);
              const imageUrl = previewUrls[attachment.id];

              return (
                <motion.div
                  layout={!reduce}
                  key={attachment.id}
                  // CDS file-thumbnail-grow-in：0.85 → 1 生长，250ms 缓出。
                  initial={reduce ? false : { opacity: 0, scale: 0.85 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={
                    reduce
                      ? undefined
                      : { opacity: 0, scale: 0.85, transition: { duration: 0.15 } }
                  }
                  transition={
                    reduce
                      ? { duration: 0 }
                      : { duration: 0.25, ease: [0.165, 0.84, 0.44, 1] }
                  }
                  className="group flex h-9 min-w-0 shrink-0 items-center gap-1.5 rounded-[10px] border border-border/70 bg-background/90 p-1 pr-0.5"
                >
                  {image && imageUrl ? (
                    <Button
                      variant="plain"
                      type="button"
                      aria-label={labels.previewAttachment(attachment.name)}
                      onClick={() => onPreview(attachment.id)}
                      className="size-7 shrink-0 overflow-hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {/* biome-ignore lint/performance/noImgElement: blob and consumer URLs are not compatible with next/image. */}
                      <img
                        src={imageUrl}
                        alt={attachment.name}
                        className="size-full object-cover"
                      />
                    </Button>
                  ) : (
                    <span className="grid size-7 shrink-0 place-items-center bg-muted text-muted-foreground rounded-full">
                      <HugeiconsIcon icon={File01Icon} className="size-3.5" />
                    </span>
                  )}
                  <span className="max-w-24 truncate text-foreground text-xs">
                    {attachment.name}
                  </span>
                  <Button
                    variant="plain"
                    type="button"
                    aria-label={labels.removeAttachment(attachment.name)}
                    onClick={() => onRemove(attachment.id)}
                    whileTap={reduce ? undefined : { scale: 0.92 }}
                    transition={SPRING_PRESS}
                    className="pointer-events-none grid h-6 w-0 shrink-0 scale-75 place-items-center overflow-hidden text-muted-foreground opacity-0 transition-[width,opacity,transform,color,background-color] duration-200 ease-out group-hover:pointer-events-auto group-hover:w-6 group-hover:scale-100 group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:w-6 group-focus-within:scale-100 group-focus-within:opacity-100 hover:bg-muted hover:text-foreground focus-visible:w-6 focus-visible:scale-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <HugeiconsIcon icon={Cancel01Icon} className="size-3" />
                  </Button>
                </motion.div>
              );
            })}
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
