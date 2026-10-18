import { HugeiconsIcon } from "@hugeicons/react"
import {
  Bug01Icon,
  Edit02Icon,
  FloppyDiskIcon,
  Loading03Icon,
  RefreshIcon,
  Undo02Icon,
} from "@hugeicons-pro/core-stroke-rounded"
import { motion, useReducedMotion } from "motion/react"
import { useEffect, useRef } from "react"
import { Button } from "@/components/motion/button"
import { SPRING_PANEL } from "@/lib/ease"
import { cn } from "@/lib/utils"

export function DocumentActions({
  editing,
  busy = false,
  disabled = false,
  dirty = false,
  saveLabel = "保存",
  onEdit,
  onSave,
  onUndo,
  onDebug,
  onRestore,
}: {
  editing: boolean
  busy?: boolean
  disabled?: boolean
  dirty?: boolean
  saveLabel?: string
  onEdit: () => void
  onSave: () => void
  onUndo: () => void
  onDebug?: () => void
  onRestore?: () => void
}) {
  const reduce = useReducedMotion()
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
  const iconClass = "size-11 shrink-0"
  const frameClass =
    "rounded-full border-2 border-foreground/60 bg-background shadow-[3px_3px_0_var(--border-strong)]"

  return (
    <div
      role="group"
      aria-label="页面操作"
      data-slot="document-actions"
      className="absolute top-4 right-4 z-20 flex items-center gap-3"
    >
      {!editing && (onDebug || onRestore) ? (
        <Button
          variant="ghost"
          size="icon"
          className={cn(iconClass, frameClass, "size-14")}
          aria-label={onDebug ? "调试" : "恢复原始内容"}
          title={onDebug ? "调试" : "恢复原始内容"}
          disabled={disabled || busy}
          onClick={onDebug ?? onRestore}
        >
          <HugeiconsIcon
            icon={onDebug ? Bug01Icon : RefreshIcon}
            size={20}
            aria-hidden="true"
          />
        </Button>
      ) : null}
      <motion.div
        initial={false}
        animate={{ width: editing ? 104 : 56 }}
        transition={reduce ? { duration: 0 } : SPRING_PANEL}
        className={cn(
          frameClass,
          "relative flex h-14 items-center justify-end gap-1 p-1"
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
            <HugeiconsIcon icon={Undo02Icon} size={20} aria-hidden="true" />
          </Button>
        ) : null}
        <Button
          ref={actionRef}
          size="icon"
          className={cn(iconClass, "relative")}
          aria-label={editing ? saveLabel : "编辑"}
          title={editing ? `${saveLabel}（⌘/Ctrl+S）` : "编辑"}
          aria-busy={busy}
          disabled={disabled || busy}
          onClick={editing ? onSave : onEdit}
        >
          <HugeiconsIcon
            icon={busy ? Loading03Icon : editing ? FloppyDiskIcon : Edit02Icon}
            size={21}
            aria-hidden="true"
            className={
              busy ? "animate-spin motion-reduce:animate-none" : undefined
            }
          />
          {dirty ? (
            <span className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-current" />
          ) : null}
        </Button>
      </motion.div>
      <span role="status" className="sr-only">
        {busy ? "处理中" : dirty ? "有未保存的修改" : ""}
      </span>
    </div>
  )
}
