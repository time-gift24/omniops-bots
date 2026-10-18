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
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
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
}: {
  entry: SkillEntry
  readOnly: boolean
  disabled: boolean
  onOpen: () => void
  onRename: () => void
  onDelete: () => void
}) {
  const folder = entry.kind === "folder"
  return (
    <article className="skill-file-table-row grid grid-cols-[minmax(0,1fr)_7rem_5rem_2rem] items-center gap-3 border-b border-border py-3.5 last:border-0">
      <button
        className="flex min-w-0 items-center gap-3 rounded-md text-left outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-ring"
        onClick={onOpen}
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
          <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
        ) : null}
      </button>
      <span className="skill-file-table-date text-[11px] text-muted-foreground tabular-nums">
        {modifiedLabel(entry.modifiedAt)}
      </span>
      <span className="text-right text-[11px] text-muted-foreground tabular-nums">
        {folder ? "—" : fileSize(entry.size)}
      </span>
      {!readOnly ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`管理 ${nameOf(entry.path)}`}
              disabled={disabled}
            >
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="bg-popover">
            <DropdownMenuItem onSelect={onRename}>
              <Pencil />
              重命名
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onSelect={onDelete}>
              <Trash2 />
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
