"use client"

import {
  ChevronRight,
  File,
  FileImage,
  FileSpreadsheet,
  FileText,
  Folder,
  MoreHorizontal,
  Pencil,
  Trash2,
} from "lucide-react"
import { useRef } from "react"
import { Button } from "@/components/motion/button"
import {
  AnimatedDropdown as DropdownMenu,
  AnimatedDropdownContent as DropdownMenuContent,
  AnimatedDropdownItem as DropdownMenuItem,
  AnimatedDropdownTrigger as DropdownMenuTrigger,
} from "@/components/premium/animated-dropdown"
import { cn } from "@/lib/utils"
import type { SkillEntry } from "@/skills/library"
import { fileSize, modifiedLabel, nameOf } from "./file-manager-data"

/** List entry adapted from @beui-pro/file-manager-workspace. */
export function FileEntryIcon({
  entry,
  className,
}: {
  entry: SkillEntry
  className?: string
}) {
  const Icon =
    entry.kind === "folder"
      ? Folder
      : entry.mimeType.startsWith("image/")
        ? FileImage
        : entry.path.endsWith(".csv")
          ? FileSpreadsheet
          : entry.mimeType.startsWith("text/")
            ? FileText
            : File
  return <Icon className={cn("size-4", className)} aria-hidden="true" />
}

export function FileEntryCard({
  entry,
  readOnly,
  disabled,
  onOpen,
  onRename,
  onDelete,
  onActionMenuClose,
}: {
  entry: SkillEntry
  readOnly: boolean
  disabled: boolean
  onOpen: () => void
  onRename: (trigger: HTMLButtonElement | null) => void
  onDelete: (trigger: HTMLButtonElement | null) => void
  onActionMenuClose: () => void
}) {
  const folder = entry.kind === "folder"
  const trigger = useRef<HTMLButtonElement>(null)
  const selectedAction = useRef(false)
  return (
    <article className="skill-file-table-row grid grid-cols-[minmax(0,1fr)_7rem_5rem_2rem] items-center gap-3 border-b border-border py-3.5 last:border-0">
      <button
        className="flex min-w-0 items-center gap-3 rounded-md text-left outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
        onClick={onOpen}
        disabled={disabled}
      >
        <span
          className={cn(
            "flex size-8 shrink-0 items-center justify-center rounded-lg",
            folder
              ? "bg-primary/8 text-primary"
              : "bg-muted text-muted-foreground"
          )}
        >
          <FileEntryIcon entry={entry} />
        </span>
        <span className="truncate text-[13px]" title={nameOf(entry.path)}>
          {nameOf(entry.path)}
        </span>
        {folder ? (
          <ChevronRight
            className="size-3 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
        ) : null}
      </button>
      <span className="skill-file-table-date text-[11px] text-muted-foreground tabular-nums">
        {modifiedLabel(entry.modifiedAt)}
      </span>
      <span className="text-right text-[11px] text-muted-foreground tabular-nums">
        {folder ? "—" : fileSize(entry.size)}
      </span>
      {!readOnly ? (
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button
              ref={trigger}
              variant="ghost"
              size="icon"
              aria-label={`管理 ${nameOf(entry.path)}`}
              disabled={disabled}
            >
              <MoreHorizontal aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="bg-popover"
            onCloseAutoFocus={(event) => {
              if (selectedAction.current) {
                event.preventDefault()
                onActionMenuClose()
              }
              selectedAction.current = false
            }}
          >
            <DropdownMenuItem
              onSelect={() => {
                selectedAction.current = true
                onRename(trigger.current)
              }}
            >
              <Pencil className="size-4" aria-hidden="true" />
              重命名
            </DropdownMenuItem>
            <DropdownMenuItem
              destructive
              onSelect={() => {
                selectedAction.current = true
                onDelete(trigger.current)
              }}
            >
              <Trash2 className="size-4" aria-hidden="true" />
              删除
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <span />
      )}
    </article>
  )
}
