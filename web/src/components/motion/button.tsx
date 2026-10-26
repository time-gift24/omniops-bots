"use client"

import { forwardRef } from "react"
import { motion } from "motion/react"
import { Button as ArcButton } from "@/components/arc/button/button"
import type { HTMLMotionProps } from "motion/react"
import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

export type ButtonSize =
  "xs" | "sm" | "md" | "lg" | "icon" | "icon-xs" | "icon-sm" | "icon-lg"
export type ButtonVariant =
  "primary" | "secondary" | "ghost" | "outline" | "destructive" | "plain"
export type ButtonProps = Omit<HTMLMotionProps<"button">, "children"> & {
  children?: ReactNode
  size?: ButtonSize
  variant?: ButtonVariant
  pressScale?: number
}

const sizes = {
  xs: "h-6 min-h-6 px-2 text-xs",
  sm: "h-8 min-h-8 px-3 text-xs",
  md: "h-9 min-h-9 px-4 text-sm",
  lg: "h-10 min-h-10 px-5 text-sm",
  icon: "size-9 min-h-9 p-0",
  "icon-xs": "size-6 min-h-6 p-0",
  "icon-sm": "size-8 min-h-8 p-0",
  "icon-lg": "size-10 min-h-10 p-0",
} as const

/** Keep the existing call signature while Arc supplies control behavior and motion. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      variant = "primary",
      size = "md",
      className,
      pressScale = 0.97,
      ...props
    },
    ref
  ) {
    if (variant === "plain") {
      return (
        <motion.button
          ref={ref}
          type="button"
          data-slot="button"
          data-variant="plain"
          className={cn(
            "rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
            className
          )}
          {...props}
        />
      )
    }
    return (
      <ArcButton
        ref={ref}
        type="button"
        data-slot="button"
        data-variant={variant}
        data-size={size}
        variant={
          variant === "outline"
            ? "secondary"
            : variant === "destructive"
              ? "danger"
              : variant
        }
        size={size === "lg" ? "lg" : size === "md" ? "md" : "sm"}
        className={cn(
          "canopy-button shrink-0 gap-2 rounded-lg font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background [&_svg]:size-4 [&_svg]:shrink-0",
          sizes[size],
          variant === "primary" &&
            "bg-primary text-primary-foreground hover:bg-primary-hover",
          variant === "outline" && "bg-transparent",
          className
        )}
        {...(pressScale === 1 ? { whileTap: undefined } : {})}
        {...props}
      />
    )
  }
)
