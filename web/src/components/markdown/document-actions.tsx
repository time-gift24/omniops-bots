import { HugeiconsIcon } from "@hugeicons/react"
import {
  Bug01Icon,
  Edit02Icon,
  FloppyDiskIcon,
  Loading03Icon,
  RefreshIcon,
  Undo02Icon,
} from "@hugeicons-pro/core-stroke-rounded"
import { useEffect, useRef, type ReactNode } from "react"
import { Button } from "@/components/motion/button"
import { cn } from "@/lib/utils"

export function DocumentActions({
  editing,
  busy = false,
  disabled = false,
  dirty = false,
  vertical = false,
  readOnly = false,
  debugLabel = "调试",
  saveLabel = "保存",
  onEdit,
  onSave,
  onUndo,
  onDebug,
  onRestore,
  children,
}: {
  editing: boolean
  busy?: boolean
  disabled?: boolean
  dirty?: boolean
  vertical?: boolean
  readOnly?: boolean
  debugLabel?: string
  saveLabel?: string
  onEdit: () => void
  onSave: () => void
  onUndo: () => void
  onDebug?: () => void
  onRestore?: () => void
  children?: ReactNode
}) {
  const actionRef = useRef<HTMLButtonElement>(null)
  const wasEditing = useRef(editing)
  useEffect(() => {
    if (
      wasEditing.current &&
      !editing &&
      (document.activeElement === document.body ||
        actionRef.current?.contains(document.activeElement))
    ) {
      actionRef.current?.focus()
    }
    wasEditing.current = editing
  }, [editing])
  const iconClass =
    "size-7 shrink-0 text-muted-foreground/70 hover:text-foreground focus-visible:text-foreground"

  return (
    <div
      role="group"
      aria-label="页面操作"
      data-slot="document-actions"
      className={cn(
        "absolute top-3 right-3 z-20 flex items-center gap-1",
        vertical && "flex-col"
      )}
    >
      {!editing && (onDebug || onRestore) ? (
        <Button
          variant="ghost"
          size="icon"
          className={iconClass}
          aria-label={onDebug ? debugLabel : "恢复原始内容"}
          title={onDebug ? debugLabel : "恢复原始内容"}
          disabled={disabled || busy}
          onClick={onDebug ?? onRestore}
        >
          <HugeiconsIcon
            icon={onDebug ? Bug01Icon : RefreshIcon}
            size={16}
            aria-hidden="true"
          />
        </Button>
      ) : null}
      {!readOnly ? (
        <div
          className={cn(
            "relative flex items-center justify-end gap-1",
            vertical && "flex-col"
          )}
        >
          {editing ? (
            <Button
              variant="ghost"
              size="icon"
              className={iconClass}
              aria-label="撤销"
              title="撤销编辑"
              disabled={disabled || busy}
              onClick={onUndo}
            >
              <HugeiconsIcon icon={Undo02Icon} size={16} aria-hidden="true" />
            </Button>
          ) : null}
          <Button
            ref={actionRef}
            variant="ghost"
            size="icon"
            className={cn(
              iconClass,
              "relative hover:bg-primary/10 hover:text-primary focus-visible:bg-primary/10 focus-visible:text-primary"
            )}
            aria-label={editing ? saveLabel : "编辑"}
            title={editing ? `${saveLabel}（⌘/Ctrl+S）` : "编辑"}
            aria-busy={busy}
            disabled={disabled || busy}
            onClick={editing ? onSave : onEdit}
          >
            <HugeiconsIcon
              icon={
                busy ? Loading03Icon : editing ? FloppyDiskIcon : Edit02Icon
              }
              size={16}
              aria-hidden="true"
              className={
                busy ? "animate-spin motion-reduce:animate-none" : undefined
              }
            />
            {dirty ? (
              <span className="absolute top-1 right-1 size-1 rounded-full bg-current" />
            ) : null}
          </Button>
        </div>
      ) : null}
      {children}
      <span role="status" className="sr-only">
        {busy ? "处理中" : dirty ? "有未保存的修改" : ""}
      </span>
    </div>
  )
}
