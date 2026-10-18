"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import { PuzzleIcon } from "@hugeicons-pro/core-stroke-rounded";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { McpCapability, McpServer } from "./agent-builder-data";

const GROUPS = [
  { key: "tools", label: "工具" },
  { key: "resources", label: "资源" },
  { key: "prompts", label: "提示词" },
] as const;

function CapabilityGroup({
  label,
  items,
}: {
  label: string;
  items: readonly McpCapability[];
}) {
  return (
    <section>
      <h3 className="mb-2 flex items-baseline gap-2 text-sm font-medium">
        {label}
        <span className="text-xs font-normal tabular-nums text-muted-foreground">
          {items.length}
        </span>
      </h3>
      {items.length ? (
        <ul className="divide-y divide-border rounded-xl border border-border">
          {items.map((item) => (
            <li key={item.name} className="px-4 py-3">
              <p className="text-sm font-medium">{item.name}</p>
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                {item.description}
              </p>
              {item.params ? (
                <p className="mt-1.5 font-mono text-xs text-muted-foreground">
                  {item.params}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="rounded-xl border border-dashed border-border px-4 py-4 text-center text-xs text-muted-foreground">
          此服务未提供{label}
        </p>
      )}
    </section>
  );
}

/** 展示一个 MCP 服务当前提供的能力清单：工具、资源和提示词。 */
export function McpCapabilityDialog({
  server,
  open,
  onOpenChange,
}: {
  server: McpServer | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] grid-rows-[auto_minmax(0,1fr)] sm:max-w-xl">
        {server ? (
          <>
            <DialogHeader className="flex-row items-center gap-3 space-y-0 text-left">
              <span className="grid size-10 shrink-0 place-items-center rounded-full bg-accent text-accent-foreground">
                <HugeiconsIcon
                  icon={server.icon ?? PuzzleIcon}
                  aria-hidden="true"
                  size={18}
                />
              </span>
              <span className="min-w-0">
                <DialogTitle className="truncate">{server.name}</DialogTitle>
                <DialogDescription className="mt-1">
                  {server.description}
                </DialogDescription>
              </span>
            </DialogHeader>
            <div className="flex min-h-0 flex-col gap-5 overflow-y-auto pr-1">
              {GROUPS.map(({ key, label }) => (
                <CapabilityGroup
                  key={key}
                  label={label}
                  items={server.capabilities[key]}
                />
              ))}
            </div>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
