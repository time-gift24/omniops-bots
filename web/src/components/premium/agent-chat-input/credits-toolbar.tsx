"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowUp01Icon,
  Attachment01Icon,
  Loading03Icon,
  Mic01Icon,
  Square01Icon,
} from "@hugeicons-pro/core-stroke-rounded";
import { AnimatePresence, motion } from "motion/react";
import type { ReactNode } from "react";
import { Button } from "@/components/motion/button";
import { SPRING_PRESS, SPRING_SWAP } from "@/lib/ease";
import type { AgentComposerModelProps } from "./composition";
import {
  type AgentChatCreditsLabels,
  DEFAULT_CREDITS_LABELS,
} from "./credits-labels";
import { CreditsModelSelector } from "./credits-model-selector";
import { CreditsSearchToggle } from "./credits-search-toggle";
import type { AgentChatInputOption } from "./types";

export function CreditsToolbar({
  part,
  side,
  align,
  className,
  labels = DEFAULT_CREDITS_LABELS,
  showSendingSpinner = true,
  busy,
  canSubmit,
  disabled,
  reduce,
  models,
  selectedModel,
  searchEnabled,
  onAttach,
  onSearchChange,
  onModelChange,
  onStop,
  onSubmit,
  onVoice,
}: {
  part?: "attach" | "voice" | "search" | "model" | "action";
  side?: AgentComposerModelProps["side"];
  align?: AgentComposerModelProps["align"];
  className?: string;
  labels?: AgentChatCreditsLabels;
  showSendingSpinner?: boolean;
  busy: boolean;
  canSubmit: boolean;
  disabled: boolean;
  reduce?: boolean | null;
  models: readonly AgentChatInputOption[];
  selectedModel: string;
  searchEnabled: boolean;
  onAttach: () => void;
  onSearchChange: (enabled: boolean) => void;
  onModelChange: (model: string) => void;
  onStop?: () => void;
  onSubmit: () => void;
  onVoice?: () => void;
}) {
  const attach = (
    <ActionButton
      label={labels.attachFiles}
      onClick={onAttach}
      disabled={disabled || busy}
      reduce={reduce}
    >
      <HugeiconsIcon icon={Attachment01Icon} className="size-[18px]" />
    </ActionButton>
  );
  const voice = (
    <ActionButton
      label={labels.voiceInput}
      onClick={onVoice}
      disabled={disabled || busy || !onVoice}
      reduce={reduce}
    >
      <HugeiconsIcon icon={Mic01Icon} className="size-[18px]" />
    </ActionButton>
  );
  const search = (
    <CreditsSearchToggle
      labels={labels}
      enabled={searchEnabled}
      disabled={disabled || busy}
      reduce={reduce}
      onChange={onSearchChange}
    />
  );
  const model = (
    <CreditsModelSelector
      labels={labels}
      side={side}
      align={align}
      className={className}
      models={models}
      selectedModel={selectedModel}
      disabled={disabled || busy}
      reduce={reduce}
      onModelChange={onModelChange}
    />
  );
  const action = (
    <Button
      variant="plain"
      type="button"
      disabled={disabled || (busy ? !onStop : !canSubmit)}
      aria-label={
        busy
          ? onStop
            ? labels.stopResponse
            : labels.sendingPrompt
          : labels.sendMessage
      }
      onClick={busy ? onStop : onSubmit}
      whileTap={reduce ? undefined : { scale: 0.94 }}
      transition={SPRING_PRESS}
      className="grid size-10 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
    >
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={busy ? "stop" : "send"}
          initial={reduce ? false : { opacity: 0, scale: 0.7 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={reduce ? undefined : { opacity: 0, scale: 0.7 }}
          transition={reduce ? { duration: 0 } : SPRING_SWAP}
        >
          {busy && onStop ? (
            <HugeiconsIcon icon={Square01Icon} aria-hidden className="size-3.5 fill-current" />
          ) : busy && showSendingSpinner ? (
            <HugeiconsIcon
              icon={Loading03Icon}
              aria-hidden
              className="size-4 motion-safe:animate-spin"
            />
          ) : (
            <HugeiconsIcon icon={ArrowUp01Icon} className="size-5" strokeWidth={2.4} />
          )}
        </motion.span>
      </AnimatePresence>
    </Button>
  );
  const parts = { attach, voice, search, model, action };
  if (part) return parts[part];
  return (
    <div className="flex items-center justify-between gap-3 px-1">
      <div className="flex min-w-0 items-center gap-0.5 text-muted-foreground">
        {attach}
        {voice}
        {search}
        {model}
      </div>
      {action}
    </div>
  );
}

function ActionButton({
  label,
  disabled,
  reduce,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  reduce?: boolean | null;
  onClick?: () => void;
  children: ReactNode;
}) {
  return (
    <Button
      variant="plain"
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      whileTap={reduce ? undefined : { scale: 0.92 }}
      transition={SPRING_PRESS}
      className="grid size-9 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {children}
    </Button>
  );
}
