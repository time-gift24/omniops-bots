"use client"

import { useEffect, useId, useRef, type FormEvent } from "react"
import { Button } from "@/components/ui/button"
import type { SkillEntry } from "@/skills/library"
import { nameOf } from "./file-manager-data"

export type FileManagerDialogState =
  { kind: "file" | "folder" } | { kind: "rename" | "delete"; entry: SkillEntry }

/** The registry's name/delete form is inline so the current folder stays visible. */
export function FileManagerActionForm({
  action,
  name,
  disabled,
  submitting,
  error,
  onNameChange,
  onSubmit,
  onCancel,
}: {
  action: FileManagerDialogState
  name: string
  disabled: boolean
  submitting: boolean
  error: string
  onNameChange: (value: string) => void
  onSubmit: (event: FormEvent) => void
  onCancel: () => void
}) {
  const form = useRef<HTMLFormElement>(null)
  const errorId = useId()
  useEffect(() => {
    form.current?.querySelector<HTMLElement>("input, button")?.focus()
  }, [action, error])
  return (
    <form
      ref={form}
      onSubmit={onSubmit}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !disabled) {
          event.preventDefault()
          onCancel()
        }
      }}
      aria-label={action.kind === "delete" ? "确认删除" : "文件名称"}
      aria-busy={submitting}
      className="shrink-0 border-b border-border bg-muted/30 px-5 py-4 md:px-8"
    >
      {action.kind === "delete" ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="max-w-[65ch] min-w-0 text-sm break-words">
            删除「{nameOf(action.entry.path)}」
            {action.entry.kind === "folder" ? "及其中全部文件" : ""}
            ？此操作不能撤销。
          </p>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={disabled}
              onClick={onCancel}
            >
              取消
            </Button>
            <Button
              type="submit"
              variant="destructive"
              size="sm"
              disabled={disabled}
            >
              {submitting ? "删除中…" : "确认删除"}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-end gap-3">
          <label className="grid min-w-0 flex-1 basis-48 gap-2 text-xs font-medium">
            {action.kind === "rename"
              ? `重命名 ${nameOf(action.entry.path)}`
              : action.kind === "file"
                ? "文件名称"
                : "文件夹名称"}
            <input
              name="fileName"
              autoComplete="off"
              spellCheck={false}
              aria-invalid={Boolean(error)}
              aria-describedby={error ? errorId : undefined}
              className="skill-input"
              value={name}
              onChange={(event) => onNameChange(event.target.value)}
              placeholder={
                action.kind === "file"
                  ? "例如：README.md"
                  : action.kind === "folder"
                    ? "例如：references"
                    : "输入新名称"
              }
              disabled={disabled}
              required
            />
          </label>
          <Button
            type="submit"
            className="rounded-full"
            disabled={disabled}
          >
            {submitting
              ? "保存中…"
              : action.kind === "rename"
                ? "保存名称"
                : "创建"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            className="rounded-full"
            disabled={disabled}
            onClick={onCancel}
          >
            取消
          </Button>
        </div>
      )}
      {error ? (
        <p id={errorId} role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </form>
  )
}
