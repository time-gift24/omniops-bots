"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import {
  AiSparklesIcon,
  FileTextIcon,
  McpServerIcon,
  ShieldCheckIcon,
  ToolsIcon,
} from "@hugeicons-pro/core-stroke-rounded";
import { useId, useState } from "react";
import { Input } from "@/components/motion/input";
import { Switch } from "@/components/motion/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/motion/tabs";
import { Select } from "@/components/premium/select/select";
import type {
  AgentConfiguration,
  AgentModel,
  AgentResource,
  McpServer,
} from "./agent-builder-data";
import { AgentResourceList } from "./agent-resource-list";
import { McpCapabilityDialog } from "./mcp-capability-dialog";

const SECTIONS = [
  { id: "instructions", label: "指令", icon: FileTextIcon },
  { id: "mcp", label: "MCP", icon: McpServerIcon },
  { id: "tools", label: "工具", icon: ToolsIcon },
  { id: "skills", label: "技能", icon: AiSparklesIcon },
];

const LIST_SECTIONS = ["mcp", "tools", "skills"] as const;
type ListSection = (typeof LIST_SECTIONS)[number];

const EMPTY_LABELS: Record<ListSection, string> = {
  mcp: "暂无可用服务。",
  tools: "暂无可用工具。",
  skills: "暂无可用技能。",
};

const SELECTED_KEYS = {
  mcp: "mcpServerIds",
  tools: "toolIds",
  skills: "skillIds",
} as const;

export function AgentConfigurationPanel({
  value,
  onChange,
  models,
  mcpServers,
  tools,
  skills,
  disabled,
}: {
  value: AgentConfiguration;
  onChange: (value: AgentConfiguration) => void;
  models: readonly AgentModel[];
  mcpServers: readonly McpServer[];
  tools: readonly AgentResource[];
  skills: readonly AgentResource[];
  disabled: boolean;
}) {
  const [tab, setTab] = useState("instructions");
  const [inspectedMcpId, setInspectedMcpId] = useState<string | null>(null);
  const id = useId();
  const inspectedServer =
    mcpServers.find((server) => server.id === inspectedMcpId) ?? null;

  function toggle(section: ListSection, itemId: string, checked: boolean) {
    const key = SELECTED_KEYS[section];
    onChange({
      ...value,
      [key]: checked
        ? [...value[key], itemId]
        : value[key].filter((item) => item !== itemId),
    });
  }

  const resourcesFor = (section: ListSection): readonly AgentResource[] =>
    section === "mcp" ? mcpServers : section === "tools" ? tools : skills;

  return (
    <div className="min-w-0">
      <fieldset disabled={disabled} className="min-w-0 space-y-5">
        <Input
          label="名称"
          value={value.name}
          maxLength={80}
          onChange={(name) => onChange({ ...value, name })}
          className="w-full"
        />
        <Input
          label="简介"
          value={value.description}
          maxLength={160}
          onChange={(description) => onChange({ ...value, description })}
          className="w-full"
        />
        <div>
          <p className="text-sm font-medium">模型</p>
          <Select
            label="Agent 模型"
            value={value.model}
            options={models}
            disabled={disabled}
            onValueChange={(model) => onChange({ ...value, model })}
            portal
            className="mt-2 block w-full"
            buttonClassName="h-10 w-full justify-between bg-background font-normal focus-visible:border-muted-foreground/40 focus-visible:ring-0"
            optionsClassName="w-[var(--button-width)] max-w-[calc(100vw-1.5rem)] shadow-none"
          />
        </div>
        <Tabs value={tab} onValueChange={setTab} variant="underline">
          <TabsList aria-label="Agent 配置" className="w-full gap-4">
            {SECTIONS.map(({ id: section, label, icon }, index) => (
              <TabsTrigger
                key={section}
                value={section}
                id={`${id}-${section}`}
                aria-controls={`${id}-panel-${section}`}
                tabIndex={tab === section ? 0 : -1}
                icon={
                  <HugeiconsIcon icon={icon} aria-hidden="true" size={14} />
                }
                className="gap-2 px-1 text-xs focus-visible:outline-2 focus-visible:outline-ring"
                onKeyDown={(event) => {
                  if (
                    !["ArrowLeft", "ArrowRight", "Home", "End"].includes(
                      event.key,
                    )
                  )
                    return;
                  event.preventDefault();
                  const next =
                    SECTIONS[
                      event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? SECTIONS.length - 1
                          : (index +
                              (event.key === "ArrowRight" ? 1 : -1) +
                              SECTIONS.length) %
                            SECTIONS.length
                    ];
                  setTab(next.id);
                  document.getElementById(`${id}-${next.id}`)?.focus();
                }}
              >
                {label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="min-h-72">
          <div
            role="tabpanel"
            id={`${id}-panel-instructions`}
            aria-labelledby={`${id}-instructions`}
            hidden={tab !== "instructions"}
          >
            <textarea
              value={value.instructions}
              onChange={(event) =>
                onChange({ ...value, instructions: event.target.value })
              }
              rows={8}
              maxLength={12000}
              aria-label="指令"
              className="w-full resize-y rounded-2xl border border-border bg-background px-4 py-3 text-sm leading-6 outline-none transition-colors focus:border-muted-foreground/40"
            />
            <p className="mt-2 text-right text-xs tabular-nums text-muted-foreground">
              {value.instructions.length.toLocaleString("zh-CN")}/12,000
            </p>
          </div>
          {LIST_SECTIONS.map((section) => {
            const selected = value[SELECTED_KEYS[section]];
            return (
              <div
                key={section}
                role="tabpanel"
                id={`${id}-panel-${section}`}
                aria-labelledby={`${id}-${section}`}
                hidden={tab !== section}
              >
                <AgentResourceList
                  resources={resourcesFor(section)}
                  selected={selected}
                  disabled={disabled}
                  emptyLabel={EMPTY_LABELS[section]}
                  onToggle={(itemId, enabled) =>
                    toggle(section, itemId, enabled)
                  }
                  onInspect={
                    section === "mcp"
                      ? (itemId) => setInspectedMcpId(itemId)
                      : undefined
                  }
                />
                {section === "tools" ? (
                  <div className="mt-3 flex items-center gap-4 rounded-2xl border border-border px-4 py-3.5">
                    <span className="grid size-9 shrink-0 place-items-center rounded-full bg-muted">
                      <HugeiconsIcon
                        icon={ShieldCheckIcon}
                        aria-hidden="true"
                        size={16}
                      />
                    </span>
                    <p className="min-w-0 flex-1 text-sm font-medium">
                      操作前先确认
                    </p>
                    <Switch
                      ariaLabel="变更数据的操作需要批准"
                      checked={value.requireApproval}
                      disabled={disabled}
                      onCheckedChange={(requireApproval) =>
                        onChange({ ...value, requireApproval })
                      }
                    />
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </fieldset>
      <McpCapabilityDialog
        server={inspectedServer}
        open={inspectedServer !== null}
        onOpenChange={(open) => {
          if (!open) setInspectedMcpId(null);
        }}
      />
    </div>
  );
}
