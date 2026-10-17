"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import { Globe02Icon } from "@hugeicons-pro/core-stroke-rounded";
import { motion } from "motion/react";
import { Button } from "@/components/motion/button";
import { EASE_OUT, SPRING_PRESS } from "@/lib/ease";
import { cn } from "@/lib/utils";
import {
  type AgentChatCreditsLabels,
  DEFAULT_CREDITS_LABELS,
} from "./credits-labels";

export function CreditsSearchToggle({
  labels = DEFAULT_CREDITS_LABELS,
  disabled,
  enabled,
  reduce,
  onChange,
}: {
  labels?: AgentChatCreditsLabels;
  disabled?: boolean;
  enabled: boolean;
  reduce?: boolean | null;
  onChange: (enabled: boolean) => void;
}) {
  return (
    <Button
      variant="plain"
      type="button"
      disabled={disabled}
      aria-label={enabled ? labels.disableSearch : labels.enableSearch}
      aria-pressed={enabled}
      onClick={() => onChange(!enabled)}
      whileTap={reduce ? undefined : { scale: 0.96 }}
      initial={false}
      animate={{ width: enabled ? "auto" : 36 }}
      transition={{
        width: { duration: reduce ? 0 : 0.3, ease: EASE_OUT },
        scale: SPRING_PRESS,
      }}
      className={cn(
        "relative h-9 shrink-0 overflow-hidden rounded-full text-sm transition-colors duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        enabled
          ? "bg-primary/10 text-primary"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      <HugeiconsIcon
        icon={Globe02Icon}
        className="absolute top-1/2 left-[9px] size-[18px] -translate-y-1/2"
      />
      <motion.span
        aria-hidden={!enabled}
        initial={false}
        animate={{ opacity: enabled ? 1 : 0, x: enabled || reduce ? 0 : -4 }}
        transition={{
          duration: reduce ? 0 : 0.2,
          delay: reduce || !enabled ? 0 : 0.075,
          ease: EASE_OUT,
        }}
        className="inline-block pl-8 pr-3 font-medium whitespace-nowrap"
      >
        {labels.search}
      </motion.span>
    </Button>
  );
}
