"use client"
import { Switch as Primitive } from "radix-ui"
import { motion, useReducedMotion } from "motion/react"
import { useId } from "react"
import { motionTokens } from "@/components/arc/motion-tokens"
import { cn } from "@/lib/utils"
export type SwitchProps = {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  disabled?: boolean
  label?: string
  ariaLabel?: string
  className?: string
}
export function Switch({
  checked,
  onCheckedChange,
  disabled,
  label,
  ariaLabel,
  className,
}: SwitchProps) {
  const id = useId(),
    reduce = useReducedMotion()
  return (
    <span className={cn("inline-flex items-center gap-3", className)}>
      <Primitive.Root
        id={id}
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        aria-label={ariaLabel}
        className="relative h-6 w-10 rounded-full bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 data-[state=checked]:bg-primary"
      >
        <Primitive.Thumb asChild>
          <motion.span
            className="block size-4 rounded-full bg-foreground data-[state=checked]:bg-primary-foreground"
            animate={{ x: checked ? 20 : 4 }}
            transition={reduce ? { duration: 0 } : motionTokens.spring.snappy}
          />
        </Primitive.Thumb>
      </Primitive.Root>
      {label ? (
        <label htmlFor={id} className="text-sm">
          {label}
        </label>
      ) : null}
    </span>
  )
}
