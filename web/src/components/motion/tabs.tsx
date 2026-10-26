"use client"
import { Tabs as Primitive } from "radix-ui"
import {
  createContext,
  useContext,
  useId,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react"
import { motion, useReducedMotion } from "motion/react"
import { motionTokens } from "@/components/arc/motion-tokens"
import { cn } from "@/lib/utils"
const Context = createContext({ value: "", id: "", variant: "pill" })
export function Tabs({
  value,
  defaultValue = "",
  onValueChange,
  variant = "pill",
  children,
  className,
}: {
  value?: string
  defaultValue?: string
  onValueChange?: (value: string) => void
  variant?: "pill" | "underline" | "segment"
  icons?: "always" | "selected"
  children: ReactNode
  className?: string
}) {
  const [internal, setInternal] = useState(defaultValue),
    id = useId(),
    current = value ?? internal
  return (
    <Context.Provider value={{ value: current, id, variant }}>
      <Primitive.Root
        value={current}
        onValueChange={(next) => {
          if (value === undefined) setInternal(next)
          onValueChange?.(next)
        }}
        className={className}
      >
        {children}
      </Primitive.Root>
    </Context.Provider>
  )
}
export function TabsList({
  className,
  ...props
}: ComponentProps<typeof Primitive.List>) {
  return (
    <Primitive.List
      className={cn("relative flex min-w-0 items-center gap-1", className)}
      {...props}
    />
  )
}
export function TabsTrigger({
  value,
  icon,
  children,
  className,
  indicatorClassName,
  activeLabelClassName,
  ...props
}: ComponentProps<typeof Primitive.Trigger> & {
  icon?: ReactNode
  indicatorClassName?: string
  activeLabelClassName?: string
}) {
  const ctx = useContext(Context),
    reduce = useReducedMotion(),
    active = ctx.value === value
  return (
    <Primitive.Trigger
      value={value}
      className={cn(
        "relative flex min-w-0 items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=active]:text-foreground",
        className
      )}
      {...props}
    >
      {active ? (
        <motion.span
          layoutId={ctx.id}
          className={cn(
            "absolute inset-0 rounded-lg bg-accent",
            ctx.variant === "underline" &&
              "top-auto h-px rounded-none bg-primary",
            indicatorClassName
          )}
          transition={reduce ? { duration: 0 } : motionTokens.spring.morph}
        />
      ) : null}
      <span
        data-slot="tab-label"
        className={cn(
          "relative flex min-w-0 items-center gap-2",
          active && activeLabelClassName
        )}
      >
        {icon}
        {children}
      </span>
    </Primitive.Trigger>
  )
}
export const TabsContent = Primitive.Content
