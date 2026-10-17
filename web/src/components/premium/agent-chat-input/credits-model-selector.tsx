"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowDown01Icon,
  CheckIcon,
} from "@hugeicons-pro/core-stroke-rounded";
import { useState } from "react";
import { Button } from "@/components/motion/button";
import {
  MorphPopover,
  MorphPopoverContent,
  MorphPopoverTrigger,
} from "@/components/motion/popover-morph";
import { SPRING_PRESS } from "@/lib/ease";
import { cn } from "@/lib/utils";
import type { AgentComposerModelProps } from "./composition";
import {
  type AgentChatCreditsLabels,
  DEFAULT_CREDITS_LABELS,
} from "./credits-labels";
import type { AgentChatInputOption } from "./types";

export function CreditsModelSelector({
  side = "top",
  align = "start",
  className,
  labels = DEFAULT_CREDITS_LABELS,
  models,
  selectedModel,
  disabled,
  reduce,
  onModelChange,
}: {
  side?: AgentComposerModelProps["side"];
  align?: AgentComposerModelProps["align"];
  className?: string;
  labels?: AgentChatCreditsLabels;
  models: readonly AgentChatInputOption[];
  selectedModel: string;
  disabled: boolean;
  reduce?: boolean | null;
  onModelChange: (model: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const selected =
    models.find((model) => model.id === selectedModel) ?? models[0];

  if (!selected) return null;

  return (
    <MorphPopover open={open} onOpenChange={setOpen}>
      <MorphPopoverTrigger>
        <Button
          variant="plain"
          type="button"
          disabled={disabled}
          aria-label={`${labels.selectModel}: ${selected.label}`}
          whileTap={reduce ? undefined : { scale: 0.96 }}
          transition={SPRING_PRESS}
          className={cn(
            "flex h-8 min-w-0 max-w-32 items-center gap-1 rounded-full px-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
            className,
          )}
        >
          <span aria-hidden>{selected.icon}</span>
          <span className="truncate">{selected.label}</span>
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            className={cn(
              "size-3 shrink-0 text-muted-foreground transition-transform duration-200",
              open && "rotate-180",
            )}
          />
        </Button>
      </MorphPopoverTrigger>

      <MorphPopoverContent
        // morph popover 只支持 top/bottom 与 start/end；left/right/center 回退为默认。
        side={side === "left" || side === "right" ? undefined : side}
        align={align === "center" ? undefined : align}
        sideOffset={4}
        radius={12}
        className="w-44 p-1"
      >
        {models.map((model) => {
          const active = model.id === selected.id;
          return (
            <Button
              variant="plain"
              key={model.id}
              type="button"
              role="menuitemradio"
              aria-checked={active}
              onClick={() => {
                onModelChange(model.id);
                setOpen(false);
              }}
              className="group/row relative isolate flex min-h-9 w-full items-center gap-2 px-2 py-1 text-left focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0"
            >
              {/* The shared Button is always pill-shaped, so the row paints its surface here. */}
              <span
                aria-hidden="true"
                className={cn(
                  "pointer-events-none absolute inset-0 -z-10 rounded-lg ring-ring ring-inset group-focus-visible/row:ring-2 transition-colors",
                  active ? "bg-muted" : "group-hover/row:bg-muted/70",
                )}
              />
              <span aria-hidden>{model.icon}</span>
              <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
                {model.label}
              </span>
              <HugeiconsIcon
                icon={CheckIcon}
                className={cn(
                  "size-3.5 shrink-0 text-primary transition-opacity",
                  active ? "opacity-100" : "opacity-0",
                )}
              />
            </Button>
          );
        })}
      </MorphPopoverContent>
    </MorphPopover>
  );
}
