"use client"

import {
  ChevronRight,
  FilePlus2,
  Folder,
  FolderOpen,
  FolderPlus,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Upload,
  X,
} from "lucide-react"
import {
  useId,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
  type ReactNode,
} from "react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { SkillEntry } from "@/skills/library"
import { cn } from "@/lib/utils"
import { FileEntryCard } from "./file-entry-card"
import {
  FileManagerActionForm,
  type FileManagerDialogState as Action,
} from "./file-manager-dialog"
import { parentPath, nameOf } from "./file-manager-data"

/** Adapted from @beui-pro/file-manager-workspace. The host owns all files.
 * Mutations resolve after persistence; this component never stores file bytes or blob URLs.
 */
export type FileManagerProps = {
  entries: readonly SkillEntry[]
  actions?: ReactNode
  disabled?: boolean
  readOnly?: boolean
  onOpenFile: (path: string) => void
  onUpload: (files: File[], folder: string) => Promise<void>
  onCreateFile: (path: string) => Promise<void>
  onCreateDirectory: (path: string) => Promise<void>
  onRename: (path: string, newPath: string) => Promise<void>
  onRemove: (path: string) => Promise<void>
  className?: string
}

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "操作失败，文件未被修改。请重试。"

export function FileManager({
  entries,
  actions,
  disabled = false,
  readOnly = false,
  onOpenFile,
  onUpload,
  onCreateFile,
  onCreateDirectory,
  onRename,
  onRemove,
  className,
}: FileManagerProps) {
  const [folder, setFolder] = useState("")
  const [query, setQuery] = useState("")
  const [treeOpen, setTreeOpen] = useState(false)
  const [action, setAction] = useState<Action | null>(null)
  const [name, setName] = useState("")
  const [error, setError] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [dragging, setDragging] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const manager = useRef<HTMLDivElement>(null)
  const createTrigger = useRef<HTMLButtonElement>(null)
  const actionOrigin = useRef<HTMLButtonElement | null>(null)
  const selectedAction = useRef(false)
  const treeId = useId()
  const dragDepth = useRef(0)
  const actionLock = useRef(false)
  const folderExists =
    !folder ||
    entries.some((entry) => entry.kind === "folder" && entry.path === folder)
  const folderPath = folder
  const editable = !readOnly && !disabled && folderExists
  const locked = disabled || submitting || !folderExists
  const folders = entries
    .filter((entry) => entry.kind === "folder")
    .sort((a, b) => a.path.localeCompare(b.path))
  const visible = entries
    .filter(
      (entry) =>
        parentPath(entry.path) === folderPath &&
        nameOf(entry.path).toLowerCase().includes(query.trim().toLowerCase())
    )
    .sort((a, b) =>
      a.kind !== b.kind
        ? a.kind === "folder"
          ? -1
          : 1
        : a.path.localeCompare(b.path)
    )
  const breadcrumbs = folderPath
    ? folderPath.split("/").map((name, index, parts) => ({
        name,
        path: parts.slice(0, index + 1).join("/"),
      }))
    : []
  function navigate(path: string) {
    setFolder(path)
    setQuery("")
    setAction(null)
    setError("")
  }
  function begin(next: Action, origin = createTrigger.current) {
    actionOrigin.current = origin
    setAction(next)
    setName(next.kind === "rename" ? nameOf(next.entry.path) : "")
    setError("")
  }
  function closeAction() {
    setAction(null)
    setError("")
    requestAnimationFrame(() => {
      const origin = actionOrigin.current
      if (origin?.isConnected && !origin.disabled) origin.focus()
      else createTrigger.current?.focus()
    })
  }
  function focusAction() {
    manager.current
      ?.querySelector<HTMLElement>("form input, form button")
      ?.focus()
  }
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!action || locked || actionLock.current) return
    const cleaned = name.trim()
    if (action.kind !== "delete" && (!cleaned || /[/\\]/.test(cleaned))) {
      setError("请输入文件或目录名称，不包含 / 或 \\。")
      return
    }
    actionLock.current = true
    setSubmitting(true)
    setError("")
    try {
      const path = folderPath ? `${folderPath}/${cleaned}` : cleaned
      if (action.kind === "file") await onCreateFile(path)
      else if (action.kind === "folder") await onCreateDirectory(path)
      else if (action.kind === "rename") {
        const parent = parentPath(action.entry.path)
        await onRename(
          action.entry.path,
          parent ? `${parent}/${cleaned}` : cleaned
        )
      } else if (action.kind === "delete") await onRemove(action.entry.path)
      closeAction()
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setSubmitting(false)
      actionLock.current = false
    }
  }
  async function upload(files: File[]) {
    if (!editable || !files.length) return
    setError("")
    try {
      await onUpload(files, folderPath)
    } catch (cause) {
      setError(errorText(cause))
    }
  }
  function drag(event: DragEvent<HTMLDivElement>) {
    if (!event.dataTransfer.types.includes("Files")) return
    event.preventDefault()
    if (editable) {
      dragDepth.current += 1
      setDragging(true)
    }
  }
  function drop(event: DragEvent<HTMLDivElement>) {
    if (!event.dataTransfer.types.includes("Files")) return
    event.preventDefault()
    dragDepth.current = 0
    setDragging(false)
    if (!editable) return
    if (
      Array.from(event.dataTransfer.items).some(
        (item) => item.webkitGetAsEntry?.()?.isDirectory
      )
    ) {
      setError("请上传文件。文件夹可先在 Skill 内新建，再进入目录添加文件。")
      return
    }
    void upload(Array.from(event.dataTransfer.files))
  }
  return (
    <div
      ref={manager}
      data-slot="file-manager"
      className={cn("relative flex min-h-0 min-w-0 flex-1 flex-col", className)}
      onDragEnter={drag}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files")) {
          event.preventDefault()
          event.dataTransfer.dropEffect = editable ? "copy" : "none"
        }
      }}
      onDragLeave={(event) => {
        if (event.dataTransfer.types.includes("Files")) {
          dragDepth.current = Math.max(0, dragDepth.current - 1)
          if (!dragDepth.current) setDragging(false)
        }
      }}
      onDrop={drop}
    >
      <input
        ref={input}
        type="file"
        multiple
        className="sr-only"
        tabIndex={-1}
        aria-label="选择上传文件"
        disabled={!editable}
        onChange={(event) => {
          const files = Array.from(event.target.files ?? [])
          event.target.value = ""
          void upload(files)
        }}
      />
      <div className="skill-file-toolbar flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border py-3 pr-14 pl-5 md:pl-8">
        <nav
          aria-label="文件路径"
          className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto text-xs"
        >
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={treeOpen ? "收起文件夹" : "展开文件夹"}
            aria-expanded={treeOpen}
            aria-controls={treeId}
            className="mr-1 shrink-0"
            onClick={() => setTreeOpen((value) => !value)}
          >
            {treeOpen ? (
              <PanelLeftClose aria-hidden="true" />
            ) : (
              <PanelLeftOpen aria-hidden="true" />
            )}
          </Button>
          <button
            className="shrink-0 rounded px-1 py-1 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => navigate("")}
            disabled={disabled || submitting}
            aria-current={!folderPath ? "page" : undefined}
          >
            全部文件
          </button>
          {breadcrumbs.map((item) => (
            <span key={item.path} className="flex shrink-0 items-center gap-1">
              <ChevronRight
                className="size-3 text-muted-foreground"
                aria-hidden="true"
              />
              <button
                className="max-w-40 truncate rounded px-1 py-1 outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => navigate(item.path)}
                disabled={disabled || submitting}
                aria-current={item.path === folderPath ? "page" : undefined}
                title={item.name}
              >
                {item.name}
              </button>
            </span>
          ))}
        </nav>
      </div>
      <div
        role="group"
        aria-label="页面操作"
        data-slot="page-actions"
        className="absolute top-3 right-3 z-20 flex flex-col items-center gap-1"
      >
        {!readOnly ? (
          <>
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <Button
                  ref={createTrigger}
                  variant="ghost"
                  size="icon"
                  aria-label="新建"
                  title="新建文件或文件夹"
                  className="size-7 text-muted-foreground/70 hover:text-foreground"
                  disabled={locked}
                >
                  <FolderPlus aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                className="bg-popover"
                onCloseAutoFocus={(event) => {
                  if (selectedAction.current) {
                    event.preventDefault()
                    focusAction()
                  }
                  selectedAction.current = false
                }}
              >
                <DropdownMenuItem
                  onSelect={() => {
                    selectedAction.current = true
                    begin({ kind: "file" })
                  }}
                >
                  <FilePlus2 aria-hidden="true" />
                  新建文件
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => {
                    selectedAction.current = true
                    begin({ kind: "folder" })
                  }}
                >
                  <FolderPlus aria-hidden="true" />
                  新建文件夹
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 text-muted-foreground/70 hover:text-foreground"
              aria-label="上传文件"
              title="上传文件"
              aria-busy={disabled}
              disabled={locked}
              onClick={() => input.current?.click()}
            >
              <Upload aria-hidden="true" />
            </Button>
          </>
        ) : null}
        {actions}
      </div>
      {action ? (
        <FileManagerActionForm
          action={action}
          name={name}
          disabled={locked}
          submitting={submitting}
          error={error}
          onNameChange={setName}
          onSubmit={(event) => void submit(event)}
          onCancel={closeAction}
        />
      ) : null}
      {!folderExists ? (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-muted px-5 py-3 text-sm"
        >
          <span>当前目录已不存在，请重新选择文件位置。</span>
          <Button
            variant="outline"
            size="sm"
            className="rounded-full"
            onClick={() => navigate("")}
          >
            返回全部文件
          </Button>
        </div>
      ) : null}
      {error && !action ? (
        <p
          role="alert"
          className="shrink-0 border-b border-border px-5 py-3 text-sm text-destructive md:px-8"
        >
          {error}
        </p>
      ) : null}
      <div className="skill-file-body flex min-h-0 flex-1">
        {treeOpen ? (
          <aside
            id={treeId}
            aria-label="Skill 文件夹"
            className="skill-folder-tree w-48 shrink-0 overflow-auto border-r border-border bg-muted/20 px-3 py-5"
          >
            <p className="mb-3 px-2 text-[11px] font-medium text-muted-foreground">
              文件夹
            </p>
            <button
              onClick={() => navigate("")}
              disabled={disabled || submitting}
              aria-current={!folderPath ? "page" : undefined}
              className={cn(
                "flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-xs outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
                !folderPath && "bg-muted text-primary"
              )}
            >
              <FolderOpen className="size-4 shrink-0" aria-hidden="true" />
              全部文件
            </button>
            {folders.map((item) => (
              <button
                key={item.path}
                onClick={() => navigate(item.path)}
                disabled={disabled || submitting}
                aria-current={folderPath === item.path ? "page" : undefined}
                title={item.path}
                className={cn(
                  "flex w-full items-center gap-2 rounded-lg py-2 pr-2 text-left text-xs outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
                  folderPath === item.path && "bg-muted text-primary"
                )}
                style={{
                  paddingLeft: `${Math.min(item.path.split("/").length, 5) * 10 + 8}px`,
                }}
              >
                <Folder className="size-3.5 shrink-0" aria-hidden="true" />
                <span className="truncate">{nameOf(item.path)}</span>
              </button>
            ))}
          </aside>
        ) : null}
        <div className="skill-file-list min-h-0 min-w-0 flex-1 overflow-auto overscroll-contain px-5 py-5 md:px-8">
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
            <span className="text-xs text-muted-foreground">
              {visible.length} 项{query ? "匹配结果" : "内容"}
            </span>
            <label className="flex w-full items-center gap-2 rounded-full border border-border px-3 sm:w-64">
              <Search
                className="size-3.5 text-muted-foreground"
                aria-hidden="true"
              />
              <input
                className="h-8 min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
                aria-label="搜索当前目录"
                name="fileSearch"
                autoComplete="off"
                spellCheck={false}
                placeholder="搜索当前目录…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              {query ? (
                <button
                  type="button"
                  aria-label="清除文件搜索"
                  className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => setQuery("")}
                >
                  <X className="size-3.5" aria-hidden="true" />
                </button>
              ) : null}
            </label>
          </div>
          <div className="skill-file-table-heading grid grid-cols-[minmax(0,1fr)_7rem_5rem_2rem] items-center gap-3 border-b border-border pb-3 text-[11px] text-muted-foreground">
            <span>名称</span>
            <span>最近修改</span>
            <span className="text-right">大小</span>
            <span />
          </div>
          {visible.map((item) => (
            <FileEntryCard
              key={item.path}
              entry={item}
              readOnly={readOnly}
              disabled={locked}
              onOpen={() =>
                item.kind === "folder"
                  ? navigate(item.path)
                  : onOpenFile(item.path)
              }
              onRename={(origin) =>
                begin({ kind: "rename", entry: item }, origin)
              }
              onDelete={(origin) =>
                begin({ kind: "delete", entry: item }, origin)
              }
              onActionMenuClose={focusAction}
            />
          ))}
          {!visible.length ? (
            <div className="flex flex-col items-center py-14 text-center">
              <FolderOpen
                className="mb-4 size-9 text-muted-foreground"
                strokeWidth={1.5}
                aria-hidden="true"
              />
              <h2 className="text-sm font-medium">
                {query ? "没有匹配的文件" : "这个目录还是空的"}
              </h2>
              <p className="mt-2 max-w-[40ch] text-xs leading-6 text-muted-foreground">
                {query
                  ? "试试其他关键词，或切换目录。"
                  : readOnly
                    ? "此版本没有包含文件。"
                    : "上传文件，或新建文档与文件夹。也可以把文件拖到这里。"}
              </p>
            </div>
          ) : null}
        </div>
      </div>
      {dragging ? (
        <div className="pointer-events-none absolute inset-2 z-20 flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed border-primary bg-background/95 text-primary">
          <Upload className="size-8" aria-hidden="true" />
          <p className="text-sm font-medium">
            松开以添加到{folderPath ? ` ${folderPath}` : "当前 Skill"}
          </p>
          <p className="text-xs">同名文件需要确认替换。</p>
        </div>
      ) : null}
    </div>
  )
}
