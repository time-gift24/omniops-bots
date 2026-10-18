import { type ReactNode } from "react"
import { cn } from "@/lib/utils"

export function Breadcrumbs({
  items,
  className,
}: {
  items: readonly ReactNode[]
  className?: string
}) {
  return (
    <nav
      aria-label="面包屑"
      className={cn("min-w-0 flex-1 text-sm", className)}
    >
      <ol className="flex min-w-0 items-center gap-2 text-muted-foreground">
        {items.map((item, index) => (
          <li
            key={index}
            aria-current={index === items.length - 1 ? "page" : undefined}
            className={cn(
              "flex min-w-0 items-center gap-2",
              index === 0 && "shrink-0",
              index === items.length - 1 && "font-medium text-foreground"
            )}
          >
            {index > 0 ? <span aria-hidden="true">/</span> : null}
            {typeof item === "string" ? (
              <span className="truncate" title={item}>
                {item}
              </span>
            ) : (
              item
            )}
          </li>
        ))}
      </ol>
    </nav>
  )
}
