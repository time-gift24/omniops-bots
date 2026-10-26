"use client"
import { useState } from "react"
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react"
import { ChevronDown } from "lucide-react"
import {
  Menu,
  MenuTrigger,
  MenuContent,
  MenuRadioGroup,
  MenuRadioItem,
} from "@/components/arc/menu/menu"
import { Button } from "@/components/motion/button"
import { cn } from "@/lib/utils"
export type SelectOption = {
  id: string
  label: string
  description?: string
  icon?: IconSvgElement
  disabled?: boolean
}
export type SelectProps = {
  options: readonly SelectOption[]
  value?: string
  defaultValue?: string
  onValueChange?: (value: string) => void
  placeholder?: string
  label?: string
  align?: "start" | "end"
  side?: "top" | "bottom"
  portal?: boolean
  disabled?: boolean
  className?: string
  buttonClassName?: string
  optionsClassName?: string
  optionClassName?: string
}
export function Select({
  options,
  value,
  defaultValue,
  onValueChange,
  placeholder = "选择…",
  label,
  align = "start",
  side = "bottom",
  disabled,
  className,
  buttonClassName,
  optionsClassName,
  optionClassName,
}: SelectProps) {
  const [internal, setInternal] = useState(defaultValue ?? options[0]?.id ?? "")
  const selected = value ?? internal
  return (
    <span className={className}>
      <Menu>
        <MenuTrigger asChild>
          <Button
            variant="outline"
            disabled={disabled}
            aria-label={label}
            className={cn("min-w-32 justify-between", buttonClassName)}
          >
            {options.find((x) => x.id === selected)?.label ?? placeholder}
            <ChevronDown size={14} />
          </Button>
        </MenuTrigger>
        <MenuContent
          align={align}
          side={side}
          data-slot="select-options"
          className={cn("min-w-40", optionsClassName)}
        >
          <MenuRadioGroup
            value={selected}
            onValueChange={(next) => {
              if (value === undefined) setInternal(next)
              onValueChange?.(next)
            }}
          >
            {options.map((option) => (
              <MenuRadioItem
                key={option.id}
                value={option.id}
                disabled={option.disabled}
                className={optionClassName}
                icon={
                  option.icon ? (
                    <HugeiconsIcon icon={option.icon} size={16} />
                  ) : undefined
                }
              >
                <span>
                  {option.label}
                  {option.description ? (
                    <span className="block text-xs text-muted-foreground">
                      {option.description}
                    </span>
                  ) : null}
                </span>
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuContent>
      </Menu>
    </span>
  )
}
