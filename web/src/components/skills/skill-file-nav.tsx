import { useEffect, useRef, useState } from "react"
import {
  ChevronRight,
  FileText,
  Folder,
  MoreHorizontal,
  Plus,
} from "lucide-react"
import { Button } from "@/components/arc/button/button"
import {
  Menu,
  MenuTrigger,
  MenuContent,
  MenuItem,
  MenuSeparator,
} from "@/components/arc/menu/menu"
import { Dialog, DialogContent } from "@/components/arc/dialog/dialog"
import { Input } from "@/components/motion/input"
import { validateSkillPath } from "@/skills/library"

export type SkillFileNavProps = {
  files: readonly { path: string; modified?: boolean }[]
  entries: readonly { path: string; kind?: "file" | "folder" }[]
  path: string
  busy: boolean
  onSelect: (path: string) => void
  onAddFile?: (path: string, content: Blob) => Promise<void>
  onAddDirectory?: (path: string) => Promise<void>
  onRenameEntry?: (path: string, newPath: string) => Promise<void>
  onDeleteEntry?: (path: string) => Promise<void>
}
type Node = { path: string; name: string; folder: boolean; children: Node[] }
type Operation = {
  kind: "file" | "folder" | "rename" | "delete"
  path: string
  name: string
  folder: boolean
}

export function SkillFileNav({
  files,
  entries,
  path,
  busy,
  onSelect,
  onAddFile,
  onAddDirectory,
  onRenameEntry,
  onDeleteEntry,
}: SkillFileNavProps) {
  const [operation, setOperation] = useState<Operation | null>(null)
  const [error, setError] = useState("")
  const [pending, setPending] = useState(false)
  const locked = useRef(false)
  const mounted = useRef(false)
  const returnFocus = useRef<HTMLElement | null>(null)
  const navigation = useRef<HTMLElement>(null)
  const createdPath = useRef("")
  const skipMenuRestore = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const tree: Node[] = []
  const occupied = new Set<string>()
  for (const entry of [...entries, ...files]) {
    let level = tree
    const parts = entry.path.split("/")
    parts.forEach((name, index) => {
      const nodePath = parts.slice(0, index + 1).join("/")
      const folder =
        index < parts.length - 1 || ("kind" in entry && entry.kind === "folder")
      occupied.add(nodePath.toLowerCase())
      let node = level.find((node) => node.path === nodePath)
      if (!node) {
        node = { name, path: nodePath, folder, children: [] }
        level.push(node)
      }
      node.folder ||= folder
      level = node.children
    })
  }
  function begin(kind: Operation["kind"], entryPath: string, folder = false) {
    skipMenuRestore.current = true
    createdPath.current = ""
    returnFocus.current = document.activeElement as HTMLElement
    let name = entryPath.split("/").at(-1) ?? ""
    if (kind === "file" || kind === "folder") {
      const base = kind === "folder" ? "未命名目录" : "未命名"
      const ext = kind === "file" ? ".md" : ""
      const prefix = entryPath ? `${entryPath}/` : ""
      name = base + ext
      for (let index = 2; occupied.has((prefix + name).toLowerCase()); index++)
        name = `${base}-${index}${ext}`
    }
    setError("")
    setOperation({ kind, path: entryPath, name, folder })
  }
  async function submit() {
    if (!operation || locked.current || busy) return
    const { kind, path: target, name } = operation
    let destination = ""
    try {
      if (kind !== "delete") {
        if (!name.trim() || /[/\\]/.test(name))
          throw new Error("名称不能为空或包含路径分隔符。")
        const prefix =
          kind === "rename"
            ? target.slice(0, target.lastIndexOf("/") + 1)
            : target
              ? `${target}/`
              : ""
        destination = validateSkillPath(prefix + name)
        if (destination !== target && occupied.has(destination.toLowerCase()))
          throw new Error("该名称已存在，请换一个名称。")
      }
      locked.current = true
      setPending(true)
      setError("")
      if (kind === "file") {
        await onAddFile?.(destination, new Blob([""]))
        createdPath.current = destination
      }
      if (kind === "folder") await onAddDirectory?.(destination)
      if (kind === "rename" && destination !== target)
        await onRenameEntry?.(target, destination)
      if (kind === "delete") await onDeleteEntry?.(target)
      if (mounted.current) setOperation(null)
    } catch (cause) {
      if (mounted.current)
        setError(cause instanceof Error ? cause.message : "操作失败，请重试。")
    } finally {
      locked.current = false
      if (mounted.current) setPending(false)
    }
  }
  const editable = !!(
    onAddFile ||
    onAddDirectory ||
    onRenameEntry ||
    onDeleteEntry
  )
  function entryMenu(node?: Node) {
    if (!editable) return null
    return (
      <Menu>
        <MenuTrigger asChild>
          <Button
            size="sm"
            variant="ghost"
            className="editor-icon skill-file-menu"
            disabled={busy || pending}
            aria-label={node ? `文件操作 ${node.path}` : "新建文件或目录"}
          >
            {node ? <MoreHorizontal size={15} /> : <Plus size={16} />}
          </Button>
        </MenuTrigger>
        <MenuContent
          align="start"
          onCloseAutoFocus={(event) => {
            if (skipMenuRestore.current) {
              event.preventDefault()
              skipMenuRestore.current = false
            }
          }}
        >
          {onAddFile ? (
            <MenuItem
              onSelect={() =>
                begin(
                  "file",
                  node
                    ? node.folder
                      ? node.path
                      : node.path.slice(
                          0,
                          Math.max(0, node.path.lastIndexOf("/"))
                        )
                    : ""
                )
              }
            >
              新建文件
            </MenuItem>
          ) : null}
          {onAddDirectory ? (
            <MenuItem
              onSelect={() =>
                begin(
                  "folder",
                  node
                    ? node.folder
                      ? node.path
                      : node.path.slice(
                          0,
                          Math.max(0, node.path.lastIndexOf("/"))
                        )
                    : ""
                )
              }
            >
              新建目录
            </MenuItem>
          ) : null}
          {node && (onAddFile || onAddDirectory) && node.folder ? (
            <MenuSeparator />
          ) : null}
          {node && onRenameEntry ? (
            <MenuItem onSelect={() => begin("rename", node.path, node.folder)}>
              重命名
            </MenuItem>
          ) : null}
          {node && onDeleteEntry ? (
            <MenuItem
              destructive
              onSelect={() => begin("delete", node.path, node.folder)}
            >
              删除
            </MenuItem>
          ) : null}
        </MenuContent>
      </Menu>
    )
  }
  function nodes(items: Node[]) {
    return (
      <ul className="skill-file-list">
        {items.map((node) => (
          <li key={node.path} data-file-entry={node.path}>
            {node.folder ? (
              <div>
                <div className="skill-file-row">
                  <details open className="min-w-0 flex-1" key={node.path}>
                    <summary className="skill-file-folder">
                      <span className="skill-file-open">
                        <ChevronRight size={12} className="folder-chevron" />
                        <Folder size={15} />
                        <span>{node.name}</span>
                      </span>
                    </summary>
                    {nodes(node.children)}
                  </details>
                  {entryMenu(node)}
                </div>
              </div>
            ) : (
              <div className="skill-file-row" data-active={node.path === path}>
                <button
                  type="button"
                  className="skill-file-open"
                  aria-current={node.path === path ? "page" : undefined}
                  title={node.path}
                  onClick={() => onSelect(node.path)}
                >
                  <FileText size={15} />
                  <span>{node.name}</span>
                  {files.find((file) => file.path === node.path)?.modified ? (
                    <>
                      <span
                        className="skill-file-modified"
                        aria-hidden="true"
                      />
                      <span className="sr-only">未保存</span>
                    </>
                  ) : null}
                </button>
                {entryMenu(node)}
              </div>
            )}
          </li>
        ))}
      </ul>
    )
  }
  const title =
    operation?.kind === "file"
      ? "新建文件"
      : operation?.kind === "folder"
        ? "新建目录"
        : operation?.kind === "rename"
          ? "重命名"
          : operation?.folder
            ? "删除目录"
            : "删除文件"
  return (
    <nav
      ref={navigation}
      className="skill-file-navigation"
      aria-label="技能文件"
      data-slot="skill-file-tree"
    >
      <div className="skill-file-navigation-header">
        <span>
          文件 <span className="ml-1 tabular-nums">{files.length}</span>
        </span>
        {entryMenu()}
      </div>
      {tree.length ? nodes(tree) : <p className="editor-empty">暂无文件</p>}
      <Dialog
        open={!!operation}
        onOpenChange={(open) => {
          if (!open && !locked.current) setOperation(null)
        }}
      >
        <DialogContent
          title={title}
          closeLabel="关闭对话框"
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            ;(event.target as HTMLElement)
              .querySelector<HTMLElement>(
                operation?.kind === "delete" ? "[data-cancel]" : "input"
              )
              ?.focus()
          }}
          description={
            operation?.kind === "delete"
              ? `删除 ${operation.path}${operation.folder ? " 及其全部内容" : ""}？此操作无法撤销。`
              : undefined
          }
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            const target = createdPath.current
            if (target)
              requestAnimationFrame(() => {
                const editor = navigation.current
                  ?.closest(".editor-workspace")
                  ?.querySelector<HTMLTextAreaElement>("textarea")
                if (editor?.getAttribute("aria-label") === `编辑 ${target}`)
                  editor.focus()
              })
            else if (returnFocus.current?.isConnected)
              returnFocus.current.focus()
            else
              navigation.current
                ?.querySelector<HTMLButtonElement>(
                  'button[aria-current="page"]'
                )
                ?.focus()
          }}
        >
          <form
            className="editor-dialog-form"
            onSubmit={(event) => {
              event.preventDefault()
              void submit()
            }}
          >
            {operation?.kind !== "delete" ? (
              <Input
                autoFocus
                label={operation?.kind === "rename" ? "新名称" : "名称"}
                aria-label={
                  operation?.kind === "rename"
                    ? `重命名 ${operation.path}`
                    : "文件或目录名称"
                }
                value={operation?.name ?? ""}
                disabled={pending}
                error={error}
                onChange={(name) => {
                  setOperation((current) =>
                    current ? { ...current, name } : null
                  )
                  setError("")
                }}
              />
            ) : error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
            <div className="editor-dialog-footer">
              <Button
                variant="ghost"
                data-cancel=""
                type="button"
                disabled={pending}
                onClick={() => setOperation(null)}
              >
                取消
              </Button>
              <Button
                variant={operation?.kind === "delete" ? "danger" : "primary"}
                type="submit"
                loading={pending}
                disabled={pending || busy}
              >
                {operation?.kind === "delete"
                  ? "确认删除"
                  : operation?.kind === "rename"
                    ? "保存名称"
                    : "创建"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </nav>
  )
}
