"use client"

import { composerText } from "./labels"
import { ChevronDown } from "lucide-react"
import { motion } from "motion/react"
import { useEffect, useRef, useState } from "react"
import {
  Menu,
  MenuTrigger,
  MenuContent,
  MenuRadioGroup,
  MenuRadioItem,
} from "@/components/arc/menu/menu"
import { SPRING_PRESS } from "@/lib/ease"
import { cn } from "@/lib/utils"
import { ModelLogo } from "./model-logo"
import type { AgentChatInputOption } from "./types"

export function CreditsModelSelector({
  models,
  selectedModel,
  disabled,
  reduce,
  onModelChange,
}: {
  models: readonly AgentChatInputOption[]
  selectedModel: string
  disabled: boolean
  reduce?: boolean | null
  onModelChange: (model: string) => void
}) {
  const t = composerText
  const [open, setOpen] = useState(false)
  const options = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const frame = requestAnimationFrame(() => {
      options.current
        ?.querySelector<HTMLElement>(
          '[role="menuitemradio"][data-state="checked"]'
        )
        ?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [open])
  const selected = models.find((model) => model.id === selectedModel)

  if (!models.length) return null

  const groups = Array.from(new Set(models.map((model) => model.group)))

  return (
    <Menu open={open} onOpenChange={setOpen}>
      <MenuTrigger asChild>
        <motion.button
          type="button"
          disabled={disabled}
          aria-label={t("selectModel", {
            model: selected?.label ?? "选择模型",
          })}
          whileTap={reduce ? undefined : { scale: 0.96 }}
          transition={SPRING_PRESS}
          className="flex h-8 max-w-32 min-w-0 items-center gap-1 rounded-full px-1.5 text-[12px] font-medium text-foreground transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
        >
          {selected ? <ModelLogo modelId={selected.id} /> : null}
          <span className="truncate">{selected?.label ?? "选择模型"}</span>
          <ChevronDown
            className={cn(
              "size-3 shrink-0 text-muted-foreground transition-transform duration-200",
              open && "rotate-180"
            )}
          />
        </motion.button>
      </MenuTrigger>

      <MenuContent side="top" align="start" sideOffset={4} className="w-56 p-1">
        <MenuRadioGroup
          ref={options}
          value={selectedModel}
          onValueChange={(value) => {
            onModelChange(value)
            setOpen(false)
          }}
        >
          {groups.map((group) => (
            <div
              key={group ?? "models"}
              role="group"
              aria-label={group ?? t("models")}
            >
              {group ? (
                <p className="px-2 py-1 text-xs text-muted-foreground">
                  {group}
                </p>
              ) : null}
              {models
                .filter((model) => model.group === group)
                .map((model) => (
                  <MenuRadioItem
                    key={model.id}
                    value={model.id}
                    icon={<ModelLogo modelId={model.id} />}
                  >
                    {model.label}
                  </MenuRadioItem>
                ))}
            </div>
          ))}
        </MenuRadioGroup>
      </MenuContent>
    </Menu>
  )
}
