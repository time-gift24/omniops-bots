"use client"
import { useLayoutEffect, useRef, type ReactNode, type RefObject } from "react"
import type { MotionProps } from "motion/react"
import { X } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/arc/dialog/dialog"
import { motionTokens } from "@/components/arc/motion-tokens"
import { Button } from "./button"
import { cn } from "@/lib/utils"
export const AnimatedModalTitle = DialogTitle
export const AnimatedModalDescription = DialogDescription
export const dialogPanelMotion = {
  initial: { opacity: 0, y: 8, scale: 0.96 },
  exit: { opacity: 0, y: 4, scale: 0.98 },
  transition: motionTokens.spring.smooth,
}
export type AnimatedModalProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onExitComplete?: () => void
  initialFocus?: RefObject<HTMLElement | null>
  children: ReactNode
  className?: string
  backdropClassName?: string
  viewportClassName?: string
  panelClassName?: string
  panelDataSlot?: string
  showCloseButton?: boolean
  panelMotion?: Pick<MotionProps, "initial" | "exit" | "transition">
}
export function AnimatedModal({
  open,
  onOpenChange,
  onExitComplete,
  initialFocus,
  children,
  panelClassName,
  panelDataSlot,
  showCloseButton,
}: AnimatedModalProps) {
  const returnFocus = useRef<HTMLElement | null>(null)
  const previous = useRef(false)
  const currentOpen = useRef(open)
  useLayoutEffect(() => {
    currentOpen.current = open
    if (open && !previous.current)
      returnFocus.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null
    previous.current = open
  }, [open])
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        unstyled
        data-slot={panelDataSlot}
        className={cn(
          "relative max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-lg overflow-auto p-6",
          panelClassName
        )}
        onOpenAutoFocus={(event) => {
          if (initialFocus?.current) {
            event.preventDefault()
            initialFocus.current.focus()
          }
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          const target = returnFocus.current
          if (target?.isConnected && !target.closest("[inert]"))
            target.focus({ preventScroll: true })
        }}
        onExitComplete={() =>
          requestAnimationFrame(() => {
            if (!currentOpen.current) onExitComplete?.()
          })
        }
      >
        {children}
        {showCloseButton ? (
          <Button
            variant="ghost"
            size="icon"
            aria-label="关闭"
            className="absolute top-3 right-3"
            onClick={() => onOpenChange(false)}
          >
            <X size={16} />
          </Button>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
