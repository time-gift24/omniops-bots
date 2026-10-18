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
  const iconClass = "size-7 shrink-0"
  const frameClass =
    "rounded-full border border-foreground/30 bg-background shadow-sm"

  return (
    <div
      role="group"
      aria-label="页面操作"
      data-slot="document-actions"
      className="absolute top-3 right-3 z-20 flex items-center gap-2"
    >
      {!editing && (onDebug || onRestore) ? (
        <Button
          variant="ghost"
          size="icon"
          className={cn(iconClass, frameClass, "size-9")}
          aria-label={onDebug ? "调试" : "恢复原始内容"}
          title={onDebug ? "调试" : "恢复原始内容"}
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
      <motion.div
        initial={false}
        animate={{ width: editing ? 68 : 36 }}
        transition={reduce ? { duration: 0 } : SPRING_PANEL}
        className={cn(
          frameClass,
          "relative flex h-9 items-center justify-end gap-1 p-[3px]"
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
      </motion.div>
      <span role="status" className="sr-only">
        {busy ? "处理中" : dirty ? "有未保存的修改" : ""}
      </span>
    </div>
  )
}
