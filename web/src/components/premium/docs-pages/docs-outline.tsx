// Adapted from @beui-pro/docs-article · beui.collectui.pro
import { motion, useReducedMotion } from "motion/react"
import { useId } from "react"
import { SPRING_LAYOUT } from "@/lib/ease"
import { cn } from "@/lib/utils"
import { type DocsSection, docsSectionId } from "./docs-data"

export function DocsOutline({
  sections,
  activeSection,
  label,
}: {
  sections: readonly DocsSection[]
  activeSection: string | undefined
  label: string
}) {
  const reduce = useReducedMotion()
  const id = useId()
  return (
    <nav aria-label={label} className="sticky top-10">
      <p className="mb-4 pl-7 text-xs font-medium text-muted-foreground">
        {label}
      </p>
      <ul className="space-y-1">
        {sections.map((item) => {
          const active = item.id === activeSection
          return (
            <li key={item.id} className="relative flex items-center">
              <span className="grid w-5 shrink-0 place-items-center">
                {active ? (
                  <motion.span
                    layoutId={id}
                    transition={reduce ? { duration: 0 } : SPRING_LAYOUT}
                    className="size-1.5 rounded-full bg-primary"
                  />
                ) : null}
              </span>
              <a
                href={`#${docsSectionId(item.id)}`}
                aria-current={active ? "location" : undefined}
                onClick={(event) => {
                  event.preventDefault()
                  document
                    .getElementById(docsSectionId(item.id))
                    ?.scrollIntoView({ block: "start" })
                }}
                className={cn(
                  "flex min-h-8 min-w-0 items-center rounded-lg px-2 py-1 text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  active
                    ? "text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {item.label}
              </a>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
