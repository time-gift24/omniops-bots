import {
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
  type ComponentProps,
} from "react"
import type { ExtraProps } from "streamdown"
import { Check, Files, RotateCcw } from "lucide-react"
import { Button } from "@/components/arc/button/button"
import { MarkdownEditor } from "@/components/markdown/markdown-editor"
import { Markdown } from "@/components/markdown/document-markdown"
import {
  headingSlug,
  resolveSkillLink,
  splitFrontmatter,
} from "@/skills/content"
import { SkillFileNav } from "./skill-file-nav"

export type SkillDocumentProps = {
  files: readonly { path: string; modified?: boolean }[]
  entries?: readonly { path: string; kind?: "file" | "folder" }[]
  path: string
  source: string
  active: boolean
  actions?: ReactNode
  message?: string
  loading?: boolean
  busy?: boolean
  dirty?: boolean
  readOnly?: boolean
  saveLabel?: string
  preview?: ReactNode
  onSave: () => void
  onUndo: () => void
  onRestore?: () => void
  onChange: (value: string) => void
  onSelectFile: (path: string) => void
  onAddFile?: (path: string, content: Blob, replace?: boolean) => Promise<void>
  onAddDirectory?: (path: string) => Promise<void>
  onRenameEntry?: (path: string, newPath: string) => Promise<void>
  onDeleteEntry?: (path: string) => Promise<void>
  onError: (message: string) => void
}

function SkillLink({
  node: _node,
  href,
  ...props
}: ComponentProps<"a"> & ExtraProps) {
  const local =
    href?.startsWith("/") ||
    href?.startsWith("#") ||
    href?.startsWith("https://skill.invalid/")
  return (
    <a
      {...props}
      href={href}
      target={local ? undefined : "_blank"}
      rel="noopener noreferrer"
      className="rounded-sm text-primary underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-ring"
    />
  )
}
const skillMarkdownComponents = { a: SkillLink }

function SkillPreview({
  source,
  path,
  target,
  onLink,
}: {
  source: string
  path: string
  target: { path: string; hash: string } | null
  onLink: (event: MouseEvent<HTMLDivElement>) => void
}) {
  const root = useRef<HTMLDivElement>(null)
  const { metadata, body } = splitFrontmatter(source)
  useLayoutEffect(() => {
    const used = new Map<string, number>()
    root.current
      ?.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6")
      .forEach((node) => {
        const base = headingSlug(node.textContent ?? "")
        const count = used.get(base) ?? 0
        used.set(base, count + 1)
        node.dataset.heading = count ? `${base}-${count}` : base
      })
    if (target?.path === path && target.hash) {
      const node = [
        ...(root.current?.querySelectorAll<HTMLElement>("[data-heading]") ??
          []),
      ].find((node) => node.dataset.heading === target.hash)
      node?.scrollIntoView({ block: "start" })
    }
  }, [source, path, target])
  return (
    <div ref={root} onClickCapture={onLink}>
      {metadata !== null ? (
        <details className="mb-6 rounded-lg bg-muted/50 px-4 py-3 text-xs">
          <summary className="cursor-pointer text-muted-foreground">
            元数据
          </summary>
          <pre className="mt-3 overflow-x-auto font-mono leading-6">
            {metadata}
          </pre>
        </details>
      ) : null}
      {body.trim() ? (
        <Markdown
          linkBase={`https://skill.invalid/${path}`}
          componentOverrides={skillMarkdownComponents}
        >
          {body}
        </Markdown>
      ) : (
        <p className="editor-empty">暂无正文</p>
      )}
    </div>
  )
}

export function SkillDocument({
  files,
  entries = files,
  path,
  source,
  active,
  actions,
  message,
  loading = false,
  busy = false,
  dirty = false,
  readOnly = false,
  saveLabel = "保存草稿",
  preview,
  onSave,
  onUndo,
  onRestore,
  onChange,
  onSelectFile,
  onAddFile,
  onAddDirectory,
  onRenameEntry,
  onDeleteEntry,
  onError,
}: SkillDocumentProps) {
  const [navOpen, setNavOpen] = useState(false)
  const [focusPath, setFocusPath] = useState("")
  const [target, setTarget] = useState<{ path: string; hash: string } | null>(
    null
  )
  const file = files.find((file) => file.path === path)
  function selectFile(next: string) {
    setTarget(null)
    setFocusPath("")
    onSelectFile(next)
    setNavOpen(false)
  }
  function followLink(event: MouseEvent<HTMLDivElement>) {
    const anchor = (event.target as Element).closest("a")
    let href = anchor?.getAttribute("href")
    if (!href) return
    if (href.startsWith("https://skill.invalid/")) {
      const url = new URL(href)
      href = url.pathname + url.hash
    }
    const next = resolveSkillLink(path, href)
    if (!next) return
    event.preventDefault()
    event.stopPropagation()
    if (!files.some((file) => file.path === next.path)) {
      onError(`找不到文件 ${next.path}。请从文件导航选择已有文件。`)
      return
    }
    onError("")
    setTarget(next)
    onSelectFile(next.path)
  }
  const markdown = /\.mdx?$/i.test(path)
  return (
    <div className="editor-workspace @container" data-slot="skill-screen">
      {active ? (
        <div className="editor-actionbar" data-slot="editor-actions">
          <Button
            variant="ghost"
            size="sm"
            className="skill-files-toggle"
            aria-label="浏览技能文件"
            aria-expanded={navOpen}
            onClick={() => setNavOpen((open) => !open)}
          >
            <Files size={15} />
            文件
          </Button>
          <span role="status" className="editor-save-state">
            {busy
              ? "正在保存…"
              : dirty
                ? "有未保存的修改"
                : message ||
                  (readOnly
                    ? "只读文件"
                    : saveLabel === "保存 Skill"
                      ? "尚未保存"
                      : "所有修改已保存")}
          </span>
          {onRestore ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy || loading}
              onClick={onRestore}
            >
              <RotateCcw size={14} />
              恢复原文
            </Button>
          ) : null}
          {!readOnly ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                disabled={
                  (!dirty && saveLabel !== "保存 Skill") || busy || loading
                }
                onClick={onUndo}
              >
                {saveLabel === "保存 Skill" ? "取消新建" : "撤销修改"}
              </Button>
              <Button
                size="sm"
                loading={busy}
                disabled={
                  busy ||
                  loading ||
                  !file ||
                  (!dirty && saveLabel !== "保存 Skill")
                }
                onClick={onSave}
              >
                <Check size={15} />
                {saveLabel}
              </Button>
            </>
          ) : null}
          {actions}
        </div>
      ) : null}
      <div className="editor-content skill-editor-content">
        <aside className="skill-editor-files" data-mobile-open={navOpen}>
          <SkillFileNav
            files={files}
            entries={entries}
            path={path}
            busy={busy}
            onSelect={selectFile}
            onAddFile={
              onAddFile
                ? async (path, content) => {
                    await onAddFile(path, content)
                    setFocusPath(path)
                    setNavOpen(false)
                  }
                : undefined
            }
            onAddDirectory={onAddDirectory}
            onRenameEntry={onRenameEntry}
            onDeleteEntry={onDeleteEntry}
          />
        </aside>
        {!file ? (
          <p className="editor-empty" role={files.length ? "alert" : undefined}>
            {files.length ? "文件不存在，请选择已有文件。" : "暂无文件"}
          </p>
        ) : loading ? (
          <p role="status" className="editor-empty">
            正在读取文件…
          </p>
        ) : preview !== undefined ? (
          <div className="min-h-0 min-w-0 flex-1 overflow-auto">{preview}</div>
        ) : (
          <MarkdownEditor
            key={`${path}:${target?.path === path}`}
            initialPreview={target?.path === path}
            title={path}
            autoFocus={active && focusPath === path}
            ariaLabel={`编辑 ${path}`}
            value={source}
            readOnly={readOnly}
            markdown={markdown}
            onChange={onChange}
            preview={
              markdown ? (
                <SkillPreview
                  source={source}
                  path={path}
                  target={target}
                  onLink={followLink}
                />
              ) : (
                <pre className="font-mono text-[13px] leading-7 break-words whitespace-pre-wrap">
                  {source}
                </pre>
              )
            }
          />
        )}
      </div>
    </div>
  )
}
