// Adapted from @beui-pro/docs-article · beui.collectui.pro
"use client"

import type { ReactNode } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { Cancel01Icon } from "@hugeicons-pro/core-stroke-rounded"
import {
  AnimatedModal,
  AnimatedModalTitle,
} from "@/components/motion/animated-modal"
import { Button } from "@/components/motion/button"

export type DocsMobileNavProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  closeLabel: string
  /** The file navigation rendered below the header content. */
  nav: ReactNode
  children?: ReactNode
}

export function DocsMobileNav({
  open,
  onOpenChange,
  title,
  closeLabel,
  nav,
  children,
}: DocsMobileNavProps) {
  return (
    <AnimatedModal
      open={open}
      onOpenChange={onOpenChange}
      backdropClassName="bg-foreground/15 backdrop-blur-sm"
      viewportClassName="overscroll-contain inset-3 sm:inset-6"
      panelClassName="max-w-sm rounded-xl"
    >
      <div className="flex items-center justify-between border-b border-border px-5 py-4">
        <AnimatedModalTitle className="text-xl font-medium">
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
          <HugeiconsIcon icon={Cancel01Icon} size={16} aria-hidden="true" />
        </Button>
      </div>
      <div className="max-h-[75dvh] overflow-y-auto p-5">
        {children}
        <div className="mt-5">{nav}</div>
      </div>
    </AnimatedModal>
  )
}
