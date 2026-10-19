"use client";

import { X } from "lucide-react";
import {
  AnimatedModal,
  AnimatedModalTitle,
} from "@beui-template/components/motion/animated-modal";
import { Button } from "@beui-template/components/motion/button";
import { DocsNav, type DocsNavProps } from "./docs-nav";

export type DocsMobileNavProps = Omit<
  DocsNavProps,
  "layoutScope" | "className"
> & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  closeLabel: string;
};

export function DocsMobileNav({
  open,
  onOpenChange,
  title,
  closeLabel,
  ...navProps
}: DocsMobileNavProps) {
  return (
    <AnimatedModal
      open={open}
      onOpenChange={onOpenChange}
      backdropClassName="bg-foreground/15 backdrop-blur-sm"
      viewportClassName="overscroll-contain inset-3 sm:inset-6"
      panelClassName="max-w-sm rounded-3xl"
    >
      <div className="flex items-center justify-between border-border border-b px-5 py-4">
        <AnimatedModalTitle className="font-medium text-xl">
          {title}
        </AnimatedModalTitle>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={closeLabel}
          onClick={() => onOpenChange(false)}
          data-autofocus
        >
          <X className="size-4" aria-hidden="true" />
        </Button>
      </div>
      <DocsNav {...navProps} layoutScope="modal" className="p-5" />
    </AnimatedModal>
  );
}
