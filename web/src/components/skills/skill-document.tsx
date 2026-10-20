import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react"
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react"
import { FilePlus2, Upload } from "lucide-react"
import {
  BookOpen01Icon,
  FileTextIcon,
  Files01Icon,
  SourceCodeIcon,
} from "@hugeicons-pro/core-stroke-rounded"
import { DocumentActions } from "@/components/markdown/document-actions"
import {
  MarkdownEditor,
  type MarkdownEditorMode,
} from "@/components/markdown/markdown-editor"
import {
  MarkdownOutline,
  MarkdownReading,
  useHeadingScroll,
} from "@/components/markdown/markdown-reading"
import {
  findDocsHeading,
  type DocsSection,
} from "@/components/premium/docs-pages/docs-data"
import { DocsMobileNav } from "@/components/premium/docs-pages/docs-mobile-nav"
import { useScrollspy } from "@/components/premium/docs-pages/use-scrollspy"
import { Button } from "@/components/motion/button"
import { Input } from "@/components/motion/input"
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockContent,
  CodeBlockCopyButton,
  CodeBlockHeader,
  CodeBlockLine,
  CodeBlockTitle,
} from "@/components/ui/code-block"
import { useHighlightedCode } from "@/hooks/use-highlighted-code"
import { cn } from "@/lib/utils"
import { resolveSkillLink } from "@/skills/content"
import {
  BranchedMenu,
  type BranchedMenuChild,
  type BranchedMenuItem,
} from "./branched-menu"
import "@/components/premium/docs-pages/docs-article.css"

function SourceView({ source, path }: { source: string; path: string }) {
  const lines = useHighlightedCode(source, path.split(".").at(-1) ?? "text")
  return (
    <CodeBlock>
      <CodeBlockHeader>
        <CodeBlockTitle>{path}</CodeBlockTitle>
        <CodeBlockActions>
          <CodeBlockCopyButton value={source} />
        </CodeBlockActions>
      </CodeBlockHeader>
      <CodeBlockContent lineNumbers>
        {lines.map((line, index) => (
          <CodeBlockLine key={index}>{line}</CodeBlockLine>
        ))}
      </CodeBlockContent>
    </CodeBlock>
  )
}

function fileIcon(path: string): IconSvgElement {
  const name = path.split("/").at(-1) ?? path
  if (name === "SKILL.md") return BookOpen01Icon
  if (path.toLowerCase().endsWith(".md")) return FileTextIcon
  return SourceCodeIcon
}

function UnsavedBadge() {
  return (
    <>
      <span className="sr-only">未保存</span>
      <span aria-hidden="true" className="size-1.5 rounded-full bg-primary" />
    </>
  )
}

function SkillFileNav({
  items,
  active,
  onPick,
}: {
  items: BranchedMenuItem[]
  active: string
  onPick: (value: string) => void
}) {
  return (
    <BranchedMenu
      ariaLabel="技能文件"
      items={items}
      active={active}
      defaultOpen={items.map((_, index) => index)}
      onSelect={onPick}
      color="var(--sidebar-foreground)"
      accentColor="var(--primary)"
      lineColor="var(--border-strong)"
      width={224}
      className="branched-menu--fill"
    />
  )
}

export type SkillDocumentProps = {
  files: readonly { path: string; modified?: boolean }[]
  path: string
  source: string
  active: boolean
  actions?: ReactNode
  message?: string
  loading?: boolean
  busy?: boolean
  dirty?: boolean
  readOnly?: boolean
  editing: boolean
  saveLabel?: string
  preview?: ReactNode
  onEdit: () => void
  onSave: () => void
  onUndo: () => void
  onRestore?: () => void
  onChange: (value: string) => void
  onSelectFile: (path: string) => void
  onAddFile?: (path: string, content: Blob) => Promise<void>
  onError: (message: string) => void
}

export function SkillDocument({
  files,
  path,
  source,
  active,
  actions,
  message,
  loading = false,
  busy = false,
  dirty = false,
  readOnly = false,
  editing,
  saveLabel = "保存草稿",
  preview: customPreview,
  onEdit,
  onSave,
  onUndo,
  onRestore,
  onChange,
  onSelectFile,
  onAddFile,
  onError,
}: SkillDocumentProps) {
  const [mode, setMode] = useState<MarkdownEditorMode>("source")
  const [navOpen, setNavOpen] = useState(false)
  const [newFilePath, setNewFilePath] = useState<string | null>(null)
  const [pendingUpload, setPendingUpload] = useState<{
    path: string
    file: File
  } | null>(null)
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const scrollRef = useRef<HTMLDivElement>(null)
  const editorPreviewRef = useRef<HTMLDivElement>(null)
  const [pendingScroll, setPendingScroll] = useState<{
    path: string
    hash: string
  } | null>(null)
  const [outline, setOutline] = useState<{
    key: string
    sections: DocsSection[]
  }>({ key: "", sections: [] })
  const file = files.find((entry) => entry.path === path)
  const markdown = /\.mdx?$/i.test(path)
  const updateSections = useCallback(
    (sections: DocsSection[]) => setOutline({ key: path, sections }),
    [path]
  )
  const outlineSections =
    markdown &&
    customPreview === undefined &&
    (!editing || mode === "preview") &&
    outline.key === path
      ? outline.sections
      : []
  const activeSection = useScrollspy(
    outlineSections.map((section) => section.id),
    editing ? editorPreviewRef : scrollRef
  )
  const resolveScroll = useCallback(
    () => editorPreviewRef.current ?? scrollRef.current,
    []
  )
  const { scrollToY, scrollToHeading } = useHeadingScroll(
    resolveScroll,
    `${path}:${editing ? mode : "reading"}`
  )
  useEffect(() => {
    const target = pendingScroll
    if (!target || target.path !== path || loading) return
    const request = requestAnimationFrame(() => {
      if (target.hash) {
        const node = findDocsHeading(resolveScroll(), target.hash)
        if (!node) return
        scrollToHeading(node)
      } else {
        scrollToY(0)
      }
      setPendingScroll(null)
    })
    return () => cancelAnimationFrame(request)
  }, [
    pendingScroll,
    path,
    source,
    loading,
    editing,
    outline,
    resolveScroll,
    scrollToHeading,
    scrollToY,
  ])
  function followLink(event: MouseEvent<HTMLDivElement>) {
    const anchor = (event.target as Element).closest("a")
    if (!anchor) return
    let href = anchor.getAttribute("href")
    if (!href) return
    if (href.startsWith("https://skill.invalid/")) {
      const local = new URL(href)
      href = local.pathname + local.hash
    }
    const target = resolveSkillLink(path, href)
    if (!target) return
    event.preventDefault()
    event.stopPropagation()
    if (!files.some((entry) => entry.path === target.path)) {
      onError(`找不到文件 ${target.path}。请从文件导航选择已有文件。`)
      return
    }
    onError("")
    setPendingScroll(target)
    onSelectFile(target.path)
  }

  const menuItems = useMemo<BranchedMenuItem[]>(() => {
    const fileBadge = (entryPath: string) => {
      const modified = files.find((file) => file.path === entryPath)?.modified
      return {
        value: entryPath,
        label: entryPath.split("/").at(-1) ?? entryPath,
        icon: fileIcon(entryPath),
        badge: modified ? <UnsavedBadge /> : undefined,
      }
    }
    // 按路径段建树：顶层文件（如 SKILL.md）与文件夹（如 reference/）同级。
    type TreeNode = { label: string; path: string | null; children: TreeNode[] }
    const tree: TreeNode[] = []
    for (const entry of files) {
      const parts = entry.path.split("/")
      let level = tree
      let node: TreeNode | undefined
      parts.forEach((part, index) => {
        node = level.find((item) => item.label === part)
        if (!node) {
          node = {
            label: part,
            path: index === parts.length - 1 ? entry.path : null,
            children: [],
          }
          level.push(node)
        }
        level = node.children
      })
    }
    const collectLeaves = (
      node: TreeNode,
      prefix: string
    ): BranchedMenuChild[] => {
      const leaves: BranchedMenuChild[] = []
      for (const child of node.children) {
        if (child.path !== null) {
          leaves.push({ ...fileBadge(child.path), label: prefix + child.label })
        } else {
          leaves.push(...collectLeaves(child, `${prefix}${child.label}/`))
        }
      }
      return leaves
    }
    return tree.map((node) =>
      node.path !== null
        ? { ...fileBadge(node.path), label: node.label }
        : { label: node.label, children: collectLeaves(node, "") }
    )
  }, [files])

  const selectFromSidebar = (value: string) => {
    setPendingScroll({ path: value, hash: "" })
    onSelectFile(value)
  }
  const selectFromDrawer = (value: string) => {
    selectFromSidebar(value)
    setNavOpen(false)
  }

  const preview = customPreview ?? (
    <MarkdownReading
      source={source}
      linkBase={`https://skill.invalid/${path}`}
      onSections={updateSections}
      onLink={followLink}
      empty={
        <p className="py-12 text-center text-sm text-muted-foreground">
          暂无正文
        </p>
      }
    />
  )

  const wide = editing && mode !== "preview"
  const folder = path.includes("/")
    ? path.slice(0, path.lastIndexOf("/") + 1)
    : ""
  async function addFile(filePath: string, content: Blob) {
    if (busy || !onAddFile) return
    try {
      await onAddFile(filePath, content)
      if (mounted.current) {
        setNewFilePath(null)
        setPendingUpload(null)
        setNavOpen(false)
      }
    } catch {
      // The owner reports the error; retain the filename or selected upload for retry.
    }
  }
  const fileActions = onAddFile ? (
    <div className="mb-3 space-y-3" data-slot="skill-file-actions">
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          className="flex-1 justify-start"
          onClick={() => setNewFilePath(folder)}
        >
          <FilePlus2 aria-hidden="true" />
          新建文件
        </Button>
        <input
          type="file"
          hidden
          aria-label="选择 Skill 上传文件"
          disabled={busy}
          onChange={(event) => {
            const file = event.currentTarget.files?.[0]
            event.currentTarget.value = ""
            if (!file) return
            const target = folder + file.name
            setPendingUpload({ path: target, file })
            void addFile(target, file)
          }}
        />
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="上传文件"
          title="上传文件"
          disabled={busy}
          onClick={(event) =>
            event.currentTarget.parentElement
              ?.querySelector<HTMLInputElement>('input[type="file"]')
              ?.click()
          }
        >
          <Upload aria-hidden="true" />
        </Button>
      </div>
      {newFilePath !== null ? (
        <form
          className="space-y-2"
          aria-label="新建技能文件"
          onSubmit={(event) => {
            event.preventDefault()
            void addFile(newFilePath.trim(), new Blob([""]))
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape" && !busy) {
              event.preventDefault()
              setNewFilePath(null)
            }
          }}
        >
          <Input
            label="文件路径"
            aria-label="新文件路径"
            value={newFilePath}
            onChange={setNewFilePath}
            placeholder="例如：notes.md"
            autoFocus
            required
            disabled={busy}
            classNames={{ field: "h-9", input: "text-xs" }}
          />
          <div className="flex justify-end gap-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => setNewFilePath(null)}
            >
              取消
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={busy || !newFilePath.trim()}
            >
              创建文件
            </Button>
          </div>
        </form>
      ) : null}
      {pendingUpload && !busy ? (
        <div className="space-y-2">
          <p
            className="truncate text-xs text-muted-foreground"
            title={pendingUpload.path}
          >
            {pendingUpload.path}
          </p>
          <div className="flex justify-end gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setPendingUpload(null)}
            >
              取消上传
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                void addFile(pendingUpload.path, pendingUpload.file)
              }
            >
              重试上传
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  ) : null

  return (
    <div className="skill-docs" data-slot="skill-screen">
      <div className="doc-action-surface m-2 flex min-h-0 flex-1 flex-col gap-2 sm:m-3">
        {active ? (
          <DocumentActions
            editing={editing}
            busy={busy}
            disabled={loading || !file}
            dirty={dirty}
            readOnly={readOnly}
            saveLabel={saveLabel}
            onEdit={() => {
              setMode("source")
              onEdit()
            }}
            onSave={onSave}
            onUndo={onUndo}
            onRestore={onRestore}
          >
            <Button
              variant="ghost"
              size="icon"
              className="skill-files-trigger size-7 text-muted-foreground/70 hover:text-foreground"
              aria-label="浏览技能文件"
              title="浏览技能文件"
              onClick={() => setNavOpen(true)}
            >
              <HugeiconsIcon icon={Files01Icon} size={16} aria-hidden="true" />
            </Button>
            {actions}
          </DocumentActions>
        ) : null}
        <div
          data-slot="document-body"
          className="flex min-h-0 flex-1 overflow-hidden rounded-xl border border-[color:var(--border-strong)]"
        >
          <aside className="skill-file-sidebar">
            <div className="min-h-0 flex-1 overflow-y-auto px-3 pt-4 pb-4">
              {fileActions}
              <SkillFileNav
                items={menuItems}
                active={path}
                onPick={selectFromSidebar}
              />
            </div>
          </aside>
          <div className="flex min-h-0 min-w-0 flex-1">
            <span role="status" className="sr-only">
              {message}
            </span>
            <div
              ref={scrollRef}
              className={cn(
                "doc-reading-scroll skill-docs-scroll min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain",
                editing && "overflow-hidden"
              )}
              tabIndex={0}
              aria-label="文件内容"
            >
              <div
                className={cn("doc-reading-layout", wide && "doc-reading-wide")}
                style={
                  editing ? { height: "100%", maxWidth: "none" } : undefined
                }
              >
                <article
                  className={cn(
                    "doc-article min-w-0 pt-2!",
                    editing && "flex h-full min-h-0 flex-col p-3!"
                  )}
                >
                  {!file ? (
                    <p role="alert">文件不存在，请从左侧导航选择文件。</p>
                  ) : loading ? (
                    <p role="status">正在读取文件…</p>
                  ) : editing && !readOnly ? (
                    <MarkdownEditor
                      key={path}
                      value={source}
                      ariaLabel={`编辑 ${path}`}
                      autoFocus
                      markdown={markdown}
                      preview={preview}
                      previewScrollRef={editorPreviewRef}
                      onModeChange={setMode}
                      onChange={onChange}
                    />
                  ) : customPreview !== undefined || markdown ? (
                    preview
                  ) : (
                    <>
                      <h1 className="mb-6 text-2xl font-semibold tracking-tight">
                        {path.split("/").at(-1)}
                      </h1>
                      <SourceView source={source} path={path} />
                    </>
                  )}
                </article>
                {!wide && outlineSections.length > 0 ? (
                  <MarkdownOutline
                    key={path}
                    sections={outlineSections}
                    active={activeSection ?? ""}
                    onSelect={(id) => {
                      const node = findDocsHeading(resolveScroll(), id)
                      if (node) scrollToHeading(node)
                    }}
                  />
                ) : null}
              </div>
            </div>
          </div>
        </div>
      </div>
      <DocsMobileNav
        open={navOpen}
        onOpenChange={setNavOpen}
        title="技能文件"
        closeLabel="关闭文件导航"
        nav={
          <SkillFileNav
            items={menuItems}
            active={path}
            onPick={selectFromDrawer}
          />
        }
      >
        {fileActions}
      </DocsMobileNav>
    </div>
  )
}
