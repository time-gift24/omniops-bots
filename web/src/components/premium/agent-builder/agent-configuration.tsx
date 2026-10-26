"use client"

import { HugeiconsIcon } from "@hugeicons/react"
import { ShieldCheckIcon } from "@hugeicons-pro/core-stroke-rounded"
import { useId, useState } from "react"
import { Switch } from "@/components/motion/switch"
import { Tabs, TabsList, TabsTrigger } from "@/components/motion/tabs"
import type {
  AgentConfiguration,
  AgentResource,
  McpServer,
} from "@/agents/source"
import { AgentResourceList } from "./agent-resource-list"
import { McpCapabilityDialog } from "./mcp-capability-dialog"

const SECTIONS = [
  { id: "mcp", label: "MCP", key: "mcpServerIds", empty: "暂无可用服务。" },
  { id: "tools", label: "工具", key: "toolIds", empty: "暂无可用工具。" },
  { id: "skills", label: "技能", key: "skillIds", empty: "暂无可用技能。" },
] as const

type Section = (typeof SECTIONS)[number]

export function AgentConfigurationPanel({
  value,
  onChange,
  mcpServers,
  tools,
  skills,
  disabled,
  readOnly,
  showApproval = true,
}: {
  value: AgentConfiguration
  onChange: (value: AgentConfiguration) => void
  mcpServers: readonly McpServer[]
  tools: readonly AgentResource[]
  skills: readonly AgentResource[]
  disabled: boolean
  readOnly: boolean
  showApproval?: boolean
}) {
  const [tab, setTab] = useState("mcp")
  const [inspectedMcpId, setInspectedMcpId] = useState<string | null>(null)
  const id = useId()
  const inspectedServer =
    mcpServers.find((server) => server.id === inspectedMcpId) ?? null

  function toggle(section: Section, itemId: string, checked: boolean) {
    const key = section.key
    onChange({
      ...value,
      [key]: checked
        ? [...value[key], itemId]
        : value[key].filter((item) => item !== itemId),
    })
  }

  return (
    <>
      <fieldset disabled={disabled} className="min-w-0">
        <div>
          <Tabs value={tab} onValueChange={setTab} variant="underline">
            <TabsList aria-label="Agent 能力" className="w-full gap-4">
              {SECTIONS.map((section) => (
                <TabsTrigger
                  key={section.id}
                  value={section.id}
                  id={`${id}-${section.id}`}
                  aria-controls={`${id}-panel-${section.id}`}
                  tabIndex={tab === section.id ? 0 : -1}
                  indicatorClassName="h-0.5 rounded-full"
                  className="min-h-9 gap-1.5 px-0 pb-2.5 text-[13px] focus-visible:outline-2 focus-visible:outline-ring"
                >
                  {section.label}
                  <span className="text-[11px] text-muted-foreground tabular-nums">
                    {value[section.key].length}
                  </span>
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          {SECTIONS.map((section) => (
            <div
              key={section.id}
              role="tabpanel"
              id={`${id}-panel-${section.id}`}
              aria-labelledby={`${id}-${section.id}`}
              hidden={tab !== section.id}
              className="pt-1"
            >
              <AgentResourceList
                resources={
                  section.id === "mcp"
                    ? mcpServers
                    : section.id === "tools"
                      ? tools
                      : skills
                }
                selected={value[section.key]}
                disabled={disabled || readOnly}
                emptyLabel={section.empty}
                onToggle={(itemId, enabled) => toggle(section, itemId, enabled)}
                onInspect={section.id === "mcp" ? setInspectedMcpId : undefined}
              />
              {section.id === "tools" && showApproval ? (
                <div className="mt-2 flex items-center gap-2 border-t border-border py-3">
                  <HugeiconsIcon
                    icon={ShieldCheckIcon}
                    aria-hidden="true"
                    size={14}
                    className="shrink-0 text-muted-foreground"
                  />
                  <p className="min-w-0 flex-1 text-[13px]">操作前先确认</p>
                  <Switch
                    ariaLabel="变更数据的操作需要批准"
                    checked={value.requireApproval ?? false}
                    disabled={disabled || readOnly}
                    onCheckedChange={(requireApproval) =>
                      onChange({ ...value, requireApproval })
                    }
                  />
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </fieldset>
      <McpCapabilityDialog
        server={inspectedServer}
        open={inspectedServer !== null}
        onOpenChange={(open) => {
          if (!open) setInspectedMcpId(null)
        }}
      />
    </>
  )
}
