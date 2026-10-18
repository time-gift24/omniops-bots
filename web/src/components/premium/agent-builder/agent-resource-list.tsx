"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowRight01Icon,
  PuzzleIcon,
} from "@hugeicons-pro/core-stroke-rounded";
import { motion, useReducedMotion } from "motion/react";
import { Switch } from "@/components/motion/switch";
import { EASE_OUT } from "@/lib/ease";
import { cn } from "@/lib/utils";
import type { AgentResource } from "./agent-builder-data";

export type AgentResourceListProps = {
  resources: readonly AgentResource[];
  selected: readonly string[];
  disabled: boolean;
  emptyLabel: string;
  onToggle: (id: string, enabled: boolean) => void;
  /** 提供后，点击行的名称/描述区会触发查看详情（如 MCP 能力清单）。 */
  onInspect?: (id: string) => void;
};

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
  const reduce = useReducedMotion();

  if (!resources.length) {
    return (
      <p className="rounded-2xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
        {emptyLabel}
      </p>
    );
  }

  return (
    <ul className="divide-y divide-border rounded-2xl border border-border">
      {resources.map((resource, index) => {
        const enabled = selected.includes(resource.id);
        const icon = resource.icon ?? PuzzleIcon;

        const summary = (
          <>
            <span
              className={cn(
                "grid size-9 shrink-0 place-items-center rounded-full transition-colors duration-300",
                enabled
                  ? "bg-accent text-accent-foreground"
                  : "bg-muted text-muted-foreground",
              )}
            >
              <HugeiconsIcon icon={icon} aria-hidden="true" size={16} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">
                {resource.name}
              </span>
              <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
                {resource.description}
              </span>
            </span>
          </>
        );

        return (
          <motion.li
            animate={{ opacity: 1, y: 0 }}
            className="flex items-center gap-4 px-4 py-3.5"
            initial={reduce ? false : { opacity: 0, y: 6 }}
            key={resource.id}
            transition={{
              duration: 0.3,
              delay: reduce ? 0 : index * 0.04,
              ease: EASE_OUT,
            }}
          >
            {onInspect ? (
              <button
                type="button"
                onClick={() => onInspect(resource.id)}
                aria-label={`查看 ${resource.name} 的能力`}
                className="group flex min-w-0 flex-1 items-center gap-4 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {summary}
                <HugeiconsIcon
                  icon={ArrowRight01Icon}
                  aria-hidden="true"
                  size={16}
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
          </motion.li>
        );
      })}
    </ul>
  );
}
