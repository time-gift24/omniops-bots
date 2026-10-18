import type { DesktopTask } from "@/desktop/runtime"
import { Button } from "@/components/ui/button"

const labels: Record<DesktopTask["phase"], string> = {
  running: "正在执行",
  "awaiting-approval": "等待你的批准",
  submitting: "正在提交决定",
  stopping: "正在停止",
}

export function TaskBanner({
  task,
  simulated,
  onReturn,
  onStop,
}: {
  task: DesktopTask
  simulated: boolean
  onReturn: () => void
  onStop: () => void
}) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-4 py-1.5 text-xs sm:px-8">
      <span role="status" className="shrink-0 font-medium">
        {labels[task.phase]}
      </span>
      <span
        className="min-w-0 flex-1 truncate text-muted-foreground"
        title={task.title}
      >
        {task.title}
      </span>
      {simulated && <span className="text-muted-foreground">模拟运行</span>}
      <div className="flex shrink-0 items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          onClick={onReturn}
          className="h-7 px-2 text-xs"
        >
          返回任务
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={task.phase === "stopping"}
          onClick={onStop}
          className="h-7 px-2 text-xs"
        >
          停止任务
        </Button>
      </div>
      {task.error && (
        <p role="alert" className="w-full text-destructive">
          {task.error}
        </p>
      )}
    </div>
  )
}
