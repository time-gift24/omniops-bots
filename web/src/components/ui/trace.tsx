import * as React from "react"
import { cn } from "cn"

import { BouncyAccordion } from "@/components/beui/motion/bouncy-accordion"
import { EASE_OUT } from "@/lib/ease"

function Trace({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="trace"
      className={cn(
        "flex w-full min-w-0 flex-col gap-2 *:has-[>[data-slot=trace-line]]:flex *:has-[>[data-slot=trace-line]]:w-fit *:has-[>[data-slot=trace-line]]:max-w-full *:has-[>[data-slot=trace-line]]:min-w-0 *:has-[>[data-slot=trace-line]]:rounded-md *:has-[>[data-slot=trace-line]]:text-left *:has-[>[data-slot=trace-line]]:outline-none *:has-[>[data-slot=trace-line]]:focus-visible:ring-3 *:has-[>[data-slot=trace-line]]:focus-visible:ring-ring/50",
        className
      )}
      {...props}
    />
  )
}

function TraceLine({
  className,
  status,
  ...props
}: React.ComponentProps<"span"> & {
  status?: "running" | "error" | "pending"
}) {
  return (
    <span
      data-slot="trace-line"
      data-status={status}
      className={cn(
        "flex w-fit max-w-full min-w-0 items-center gap-2 text-sm text-muted-foreground transition-colors motion-reduce:transition-none in-[a,button]:cursor-pointer in-[a:hover,button:hover]:text-foreground data-[status=error]:text-destructive data-[status=error]:in-[a:hover,button:hover]:text-destructive data-[status=pending]:opacity-60 motion-safe:data-[status=running]:*:data-[slot=trace-title]:shimmer",
        className
      )}
      {...props}
    />
  )
}

function TraceIcon({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="trace-icon"
      aria-hidden="true"
      className={cn(
        "flex size-4 shrink-0 items-center justify-center [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 [[data-slot=trace-title]~&]:-ml-1",
        className
      )}
      {...props}
    />
  )
}

function TraceTitle({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="trace-title"
      className={cn("min-w-0 truncate motion-reduce:shimmer-none", className)}
      {...props}
    />
  )
}

function TraceDescription({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="trace-description"
      className={cn(
        "shrink-0 text-[11px] text-muted-foreground/70 tabular-nums",
        className
      )}
      {...props}
    />
  )
}

function TraceDisclosure({
  title,
  children,
  open,
  defaultOpen = false,
  onOpenChange,
  onFocusCapture,
}: {
  title: React.ReactNode
  children: React.ReactNode
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  onFocusCapture?: React.FocusEventHandler<HTMLDivElement>
}) {
  return (
    <div data-slot="trace-disclosure" className="min-w-0">
      <BouncyAccordion
        items={[{
          id: "detail",
          title,
          // beUI keeps this description mounted, preserving nested step state.
          description: (
            <div
              data-slot="trace-disclosure-content"
              onFocusCapture={onFocusCapture}
              className="mt-2 mb-1 ml-[calc(--spacing(2)-1px)] min-w-0 border-l pr-1 pl-4 leading-normal wrap-break-word text-muted-foreground"
            >
              {children}
            </div>
          ),
        }]}
        value={open === undefined ? undefined : open ? "detail" : null}
        defaultValue={defaultOpen ? "detail" : null}
        onValueChange={(value) => onOpenChange?.(value === "detail")}
        transition={{ duration: 0.2, ease: EASE_OUT }}
        classNames={{
          root: "min-w-0 [&>div>div>section>div]:px-0 [&>div>div>section>div]:pb-0",
          item: "overflow-visible rounded-none! bg-transparent",
          trigger: "min-h-0 w-fit max-w-full min-w-0 gap-1 rounded-md px-0 py-0 focus-visible:bg-transparent focus-visible:ring-3 focus-visible:ring-ring/50",
          title: "min-w-0 flex-initial text-sm font-normal",
          chevron: "size-4 shrink-0 [&>svg]:size-3.5",
          content: "min-w-0 overflow-hidden transition-[height] duration-200 motion-reduce:transition-none",
          description: "min-w-0 text-sm leading-normal",
        }}
      />
    </div>
  )
}

export {
  Trace,
  TraceLine,
  TraceIcon,
  TraceTitle,
  TraceDescription,
  TraceDisclosure,
}
