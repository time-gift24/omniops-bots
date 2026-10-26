"use client"

import { isValidElement } from "react"
import { Tooltip } from "@/components/arc/tooltip/tooltip"
import type { ReactNode } from "react"
export type MorphicTooltipPlacement = {
  side?: "top" | "right" | "bottom" | "left"
  align?: "start" | "center" | "end"
  offset?: number
}
export type MorphicTooltipProps = MorphicTooltipPlacement & {
  children: ReactNode
  content: ReactNode
  disabled?: boolean
  className?: string
  contentClassName?: string
}
export type MorphicTooltipProviderProps = {
  children: ReactNode
  className?: string
}

export function MorphicTooltipProvider({
  children,
  className,
}: MorphicTooltipProviderProps) {
  return className ? (
    <div className={className}>{children}</div>
  ) : (
    <>{children}</>
  )
}

export function MorphicTooltip({
  children,
  content,
  side,
  align,
  offset,
  disabled,
  className,
  contentClassName,
}: MorphicTooltipProps) {
  const trigger =
    isValidElement(children) && !className ? (
      children
    ) : (
      <span className={className}>{children}</span>
    )
  return disabled ? (
    trigger
  ) : (
    <Tooltip
      content={content}
      side={side}
      align={align}
      sideOffset={offset}
      className={contentClassName}
    >
      {trigger}
    </Tooltip>
  )
}
