"use client"

import { HugeiconsIcon } from "@hugeicons/react"
import {
  ArrowRight01Icon,
  PuzzleIcon,
} from "@hugeicons-pro/core-stroke-rounded"
import { Switch } from "@/components/motion/switch"
import { cn } from "@/lib/utils"
import type { AgentResource } from "./agent-builder-data"

export type AgentResourceListProps = {
  resources: readonly AgentResource[]
  selected: readonly string[]
  disabled: boolean
  emptyLabel: string
  onToggle: (id: string, enabled: boolean) => void
  /** 提供后，点击行的名称/描述区会触发查看详情（如 MCP 能力清单）。 */
  onInspect?: (id: string) => void
}

/**
 * Agent 可用的 MCP 服务、工具或技能。启用的行用浅绿底徽标标示，
 * 当前生效的集合一眼可读。
 */
export function AgentResourceList({
  resources,
  selected,
  disabled,
  emptyLabel,
  onToggle,
  onInspect,
}: AgentResourceListProps) {
  if (!resources.length) {
    return <p className="py-6 text-xs text-muted-foreground">{emptyLabel}</p>
  }

  return (
    <ul className="divide-y divide-border">
      {resources.map((resource) => {
        const enabled = selected.includes(resource.id)
        const icon = resource.icon ?? PuzzleIcon

        const summary = (
          <>
            <span
              className={cn(
                "grid size-7 shrink-0 place-items-center rounded-lg transition-colors duration-150 motion-reduce:transition-none",
                enabled
                  ? "bg-accent text-accent-foreground"
                  : "bg-muted text-muted-foreground"
              )}
            >
              <HugeiconsIcon icon={icon} aria-hidden="true" size={14} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium">
                {resource.name}
              </span>
              <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
                {resource.description}
              </span>
            </span>
          </>
        )

        return (
          <li className="flex items-center gap-2 py-3" key={resource.id}>
            {onInspect ? (
              <button
                type="button"
                onClick={() => onInspect(resource.id)}
                aria-label={`查看 ${resource.name} 的能力`}
                className="group flex min-w-0 flex-1 items-center gap-2 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {summary}
                <HugeiconsIcon
                  icon={ArrowRight01Icon}
                  aria-hidden="true"
                  size={12}
                  className="shrink-0 text-muted-foreground opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-focus-visible:opacity-100"
                />
              </button>
            ) : (
              summary
            )}
            <Switch
              ariaLabel={`启用 ${resource.name}`}
              checked={enabled}
              disabled={disabled}
              onCheckedChange={(checked) => onToggle(resource.id, checked)}
            />
          </li>
        )
      })}
    </ul>
  )
}
