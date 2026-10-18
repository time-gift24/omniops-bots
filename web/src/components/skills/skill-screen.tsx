import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ComponentProps,
} from "react"
import {
  animate,
  useReducedMotion,
  type AnimationPlaybackControls,
} from "motion/react"
import type { ExtraProps } from "streamdown"
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react"
import {
  BookOpen01Icon,
  CheckmarkCircle02Icon,
  Edit02Icon,
  FileTextIcon,
  Files01Icon,
  FloppyDiskIcon,
  RefreshIcon,
  SourceCodeIcon,
} from "@hugeicons-pro/core-stroke-rounded"
import { Markdown } from "@/components/chat/markdown"
import {
  MarkdownEditor,
  type MarkdownEditorMode,
} from "@/components/markdown/markdown-editor"
import {
  docsSectionId,
  type DocsSection,
} from "@/components/premium/docs-pages/docs-data"
import { DocsMobileNav } from "@/components/premium/docs-pages/docs-mobile-nav"
import { useScrollspy } from "@/components/premium/docs-pages/use-scrollspy"
import { Button } from "@/components/ui/button"
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
import { SPRING_GLIDE } from "@/lib/ease"
import { cn } from "@/lib/utils"
import { DEMO_SKILLS } from "@/skills/data"
import { fileKey, loadDrafts, removeDraft, saveDraft } from "@/skills/drafts"
import {
  headingSlug,
  resolveSkillLink,
  splitFrontmatter,
} from "@/skills/content"
import {
  BranchedMenu,
  type BranchedMenuChild,
  type BranchedMenuItem,
} from "./branched-menu"
import "@/components/premium/docs-pages/docs-article.css"

function SkillLink({
  href,
  children,
  node: _node,
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
      className="rounded-sm text-primary underline decoration-primary/40 underline-offset-4 outline-none hover:decoration-primary focus-visible:ring-2 focus-visible:ring-ring"
    >
      {children}
    </a>
  )
}
const skillMarkdownComponents = { a: SkillLink }

function SourceView({ source, path }: { source: string; path: string }) {
  const lines = useHighlightedCode(source, "javascript")
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

function SkillPreview({
  source,
  path,
  onSections,
  onLink,
}: {
  source: string
  path: string
  onSections: (sections: DocsSection[]) => void
  onLink: (event: MouseEvent<HTMLDivElement>) => void
}) {
  const root = useRef<HTMLDivElement>(null)
  const { metadata, body } = splitFrontmatter(source)
  useLayoutEffect(() => {
    const used = new Map<string, number>()
    const sections = Array.from(
      root.current?.querySelectorAll("h1,h2,h3,h4,h5,h6") ?? []
    ).map((heading) => {
      const label = heading.textContent ?? ""
      const base = headingSlug(label)
      const count = used.get(base) ?? 0
      used.set(base, count + 1)
      const id = count ? `${base}-${count}` : base
      heading.id = docsSectionId(id)
      return { id, label, level: Number(heading.tagName.slice(1)) }
    })
    onSections(sections.filter((section) => section.level <= 2))
  }, [body, onSections])
  return (
    <div ref={root} className="skill-preview" onClickCapture={onLink}>
      {body.trim() ? (
        <Markdown
          linkBase={`https://skill.invalid/${path}`}
          componentOverrides={skillMarkdownComponents}
        >
          {body}
        </Markdown>
      ) : (
        <p className="py-12 text-center text-sm text-muted-foreground">
          这个文件还是空的，点击「编辑」开始编写。
        </p>
      )}
      {metadata !== null ? (
        <details className="mt-12 border-t border-border pt-5 text-sm text-muted-foreground">
          <summary className="w-fit cursor-pointer rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring">
            文件元数据（frontmatter）
          </summary>
          <pre className="mt-4 overflow-x-auto rounded-lg bg-muted p-4 font-mono text-xs leading-6 text-foreground">
            {metadata}
          </pre>
        </details>
      ) : null}
    </div>
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

function initialDrafts() {
  try {
    return { saved: loadDrafts(window.localStorage, DEMO_SKILLS), error: "" }
  } catch {
    return {
      saved: {} as Record<string, string>,
      error:
        "无法读取本地草稿。请检查浏览器的存储权限；新编辑的内容会暂留在页面中。",
    }
  }
}

export function SkillScreen({
  skillId,
  active,
}: {
  skillId: string
  active: boolean
}) {
  const [initial] = useState(initialDrafts)
  const [saved, setSaved] = useState(initial.saved)
  const [contents, setContents] = useState(initial.saved)
  const [error, setError] = useState(initial.error)
  const [message, setMessage] = useState("")
  const [paths, setPaths] = useState<Record<string, string>>({})
  const [editing, setEditing] = useState(false)
  const [mode, setMode] = useState<MarkdownEditorMode>("source")
  const [navOpen, setNavOpen] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const editorPreviewRef = useRef<HTMLDivElement>(null)
  const [outline, setOutline] = useState<{
    key: string
    sections: DocsSection[]
  }>({ key: "", sections: [] })
  const skill =
    DEMO_SKILLS.find((entry) => entry.id === skillId) ?? DEMO_SKILLS[0]
  const path = paths[skill.id] ?? "SKILL.md"
  const file = skill.files.find((entry) => entry.path === path)
  const key = fileKey(skill.id, path)
  const source = contents[key] ?? file?.content ?? ""
  const original = file?.content ?? ""
  const dirty = source !== (saved[key] ?? original)
  const markdown = path.toLowerCase().endsWith(".md")
  const unsaved = DEMO_SKILLS.some((item) =>
    item.files.some((entry) => {
      const id = fileKey(item.id, entry.path)
      return (contents[id] ?? entry.content) !== (saved[id] ?? entry.content)
    })
  )
  const updateSections = useCallback(
    (sections: DocsSection[]) => setOutline({ key, sections }),
    [key]
  )
  const outlineSections =
    markdown && (!editing || mode === "preview") && outline.key === key
      ? outline.sections
      : []
  const activeSection = useScrollspy(
    outlineSections.map((section) => section.id),
    editing ? editorPreviewRef : scrollRef
  )
  const reduceMotion = useReducedMotion()
  const scrollAnimation = useRef<AnimationPlaybackControls | null>(null)
  const scrollToY = useCallback(
    (top: number) => {
      const el = editorPreviewRef.current ?? scrollRef.current
      if (!el) return
      scrollAnimation.current?.stop()
      if (reduceMotion) {
        el.scrollTop = top
        return
      }
      scrollAnimation.current = animate(el.scrollTop, top, {
        ...SPRING_GLIDE,
        type: "spring",
        onUpdate: (value) => {
          el.scrollTop = value
        },
      })
    },
    [reduceMotion]
  )
  const scrollToHeading = useCallback(
    (node: HTMLElement) => {
      const el = editorPreviewRef.current ?? scrollRef.current
      if (!el) return
      // 2rem scroll-margin-top，与 .skill-preview 标题的 scroll-margin 对齐。
      const top =
        node.getBoundingClientRect().top -
        el.getBoundingClientRect().top +
        el.scrollTop -
        32
      scrollToY(Math.max(0, top))
    },
    [scrollToY]
  )

  function save() {
    if (!file || !dirty) return
    try {
      saveDraft(window.localStorage, skill.id, path, source)
      setSaved((current) => ({ ...current, [key]: source }))
      setError("")
      setMessage("已保存到此浏览器")
    } catch {
      setError(
        "草稿保存失败，编辑内容仍在页面中。请检查存储权限或可用空间，再重试保存。"
      )
    }
  }

  useEffect(() => {
    if (!unsaved) return
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ""
    }
    window.addEventListener("beforeunload", warn)
    return () => window.removeEventListener("beforeunload", warn)
  }, [unsaved])

  useEffect(() => {
    if (!active) return
    const shortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault()
        save()
      }
    }
    window.addEventListener("keydown", shortcut)
    return () => window.removeEventListener("keydown", shortcut)
  })

  function selectFile(nextPath: string) {
    setPaths((current) => ({ ...current, [skill.id]: nextPath }))
    setEditing(false)
    setMessage("")
  }

  function restore() {
    if (
      !window.confirm(
        `将 ${path} 恢复为演示原始内容？此文件的编辑和本地草稿会被移除。`
      )
    )
      return
    try {
      removeDraft(window.localStorage, skill.id, path)
      setContents((current) => ({ ...current, [key]: original }))
      setSaved((current) => {
        const next = { ...current }
        delete next[key]
        return next
      })
      setError("")
      setMessage("已恢复原始内容")
    } catch {
      setError("未能移除本地草稿，内容保持原样。请检查存储权限后重试。")
    }
  }

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
    if (!skill.files.some((entry) => entry.path === target.path)) {
      setError(`找不到文件 ${target.path}。请从文件导航选择已有文件。`)
      return
    }
    setError("")
    selectFile(target.path)
    requestAnimationFrame(() => {
      if (target.hash) {
        const node = document.getElementById(docsSectionId(target.hash))
        if (node) scrollToHeading(node)
      } else {
        scrollToY(0)
      }
    })
  }

  const menuItems = useMemo<BranchedMenuItem[]>(() => {
    const fileBadge = (entryPath: string) => {
      const entry = skill.files.find((file) => file.path === entryPath)
      const id = fileKey(skill.id, entryPath)
      const modified =
        (contents[id] ?? entry?.content ?? "") !==
        (saved[id] ?? entry?.content ?? "")
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
    for (const entry of skill.files) {
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
  }, [skill, contents, saved])

  const selectFromSidebar = (value: string) => {
    selectFile(value)
    requestAnimationFrame(() => scrollToY(0))
  }
  const selectFromDrawer = (value: string) => {
    selectFromSidebar(value)
    setNavOpen(false)
  }

  const preview = (
    <SkillPreview
      source={source}
      path={path}
      onSections={updateSections}
      onLink={followLink}
    />
  )

  const wide = editing && mode !== "preview"

  return (
    <div className="skill-docs" data-slot="skill-screen">
      <div className="skill-doc-bar flex min-h-12 shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border bg-background px-4 py-2 sm:px-6">
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <Button
            variant="ghost"
            size="icon-lg"
            className="skill-files-trigger rounded-full"
            aria-label="浏览技能文件"
            onClick={() => setNavOpen(true)}
          >
            <HugeiconsIcon icon={Files01Icon} size={18} aria-hidden="true" />
          </Button>
          <p
            className="truncate font-mono text-xs text-muted-foreground"
            title={path}
          >
            {path}
          </p>
          {dirty ? (
            <span
              className="size-1.5 shrink-0 rounded-full bg-primary"
              title="有未保存的修改"
            >
              <span className="sr-only">有未保存的修改</span>
            </span>
          ) : null}
          <div
            role="status"
            aria-live="polite"
            className={
              message
                ? "flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground"
                : "sr-only"
            }
          >
            {message ? (
              <HugeiconsIcon
                icon={CheckmarkCircle02Icon}
                size={14}
                aria-hidden="true"
              />
            ) : null}
            {message}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {editing ? (
            <>
              <Button
                variant="ghost"
                className="rounded-full"
                onClick={() => setEditing(false)}
              >
                完成编辑
              </Button>
              <Button
                className="rounded-full"
                disabled={!dirty}
                onClick={save}
                title="保存草稿（⌘/Ctrl+S）"
              >
                <HugeiconsIcon
                  icon={FloppyDiskIcon}
                  size={15}
                  aria-hidden="true"
                />
                保存草稿
              </Button>
            </>
          ) : (
            <>
              {saved[key] !== undefined || source !== original ? (
                <Button
                  variant="ghost"
                  size="icon-lg"
                  className="rounded-full"
                  aria-label="恢复原始内容"
                  title="恢复原始内容"
                  onClick={restore}
                >
                  <HugeiconsIcon
                    icon={RefreshIcon}
                    size={17}
                    aria-hidden="true"
                  />
                </Button>
              ) : null}
              <Button
                className="rounded-full"
                onClick={() => {
                  setEditing(true)
                  setMode("source")
                  setMessage("")
                }}
              >
                <HugeiconsIcon icon={Edit02Icon} size={15} aria-hidden="true" />
                编辑
              </Button>
            </>
          )}
        </div>
      </div>
      {error ? (
        <div
          role="alert"
          className="flex shrink-0 items-start justify-between gap-3 border-b border-destructive/20 bg-destructive/5 px-6 py-3 text-sm text-destructive"
        >
          <p>{error}</p>
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0 rounded-full"
            onClick={() => setError("")}
          >
            关闭
          </Button>
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1">
        <aside className="skill-file-sidebar">
          <div className="min-h-0 flex-1 overflow-y-auto px-3 pt-4 pb-4">
            <SkillFileNav
              items={menuItems}
              active={path}
              onPick={selectFromSidebar}
            />
          </div>
        </aside>
        <div
          ref={scrollRef}
          className={cn(
            "skill-docs-scroll min-w-0 flex-1 overflow-y-auto overscroll-contain",
            editing && "overflow-hidden"
          )}
          tabIndex={0}
          aria-label="文件内容"
        >
          <div
            className={cn("skill-reading-layout", wide && "skill-reading-wide")}
            style={editing ? { height: "100%", maxWidth: "none" } : undefined}
          >
            <article
              className={cn(
                "skill-article min-w-0",
                editing && "flex h-full min-h-0 flex-col p-3!"
              )}
            >
              {!file ? (
                <p role="alert">文件不存在，请从左侧导航选择文件。</p>
              ) : editing ? (
                <MarkdownEditor
                  value={source}
                  ariaLabel={`编辑 ${path}`}
                  autoFocus
                  markdown={markdown}
                  preview={preview}
                  previewScrollRef={editorPreviewRef}
                  onModeChange={setMode}
                  onChange={(value) => {
                    setContents((current) => ({ ...current, [key]: value }))
                    setMessage("")
                  }}
                />
              ) : markdown ? (
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
              <aside className="skill-outline">
                <div className="skill-outline-sticky">
                  <p className="mb-3 text-xs font-medium text-muted-foreground">
                    本页目录
                  </p>
                  <BranchedMenu
                    ariaLabel="本页目录"
                    items={outlineSections.map((section) => ({
                      label: section.label,
                      value: section.id,
                    }))}
                    active={activeSection ?? ""}
                    onSelect={(id) => {
                      const node = document.getElementById(docsSectionId(id))
                      if (node) scrollToHeading(node)
                    }}
                    color="var(--sidebar-foreground)"
                    accentColor="var(--primary)"
                    lineColor="var(--border-strong)"
                    width={168}
                    rowHeight={32}
                    fontSize={13}
                    className="branched-menu--fill"
                  />
                </div>
              </aside>
            ) : null}
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
      />
    </div>
  )
}
