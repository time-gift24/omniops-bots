import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from "react"
import { createPortal } from "react-dom"
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react"
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
import { cn } from "@/lib/utils"
import { useAppDependencies } from "@/app/dependencies"
import type { Skill } from "@/skills/source"
import { fileKey } from "@/skills/drafts"
import { resolveSkillLink } from "@/skills/content"
import {
  BranchedMenu,
  type BranchedMenuChild,
  type BranchedMenuItem,
} from "./branched-menu"
import "@/components/premium/docs-pages/docs-article.css"

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

export function SkillScreen({
  skills,
  skillId,
  active,
  toolbarTarget,
}: {
  skills: readonly Skill[]
  skillId: string
  active: boolean
  toolbarTarget: HTMLElement | null
}) {
  const { skillDrafts, host } = useAppDependencies()
  const [saved, setSaved] = useState<Record<string, string>>({})
  const [contents, setContents] = useState<Record<string, string>>({})
  const [loaded, setLoaded] = useState<{
    cache: typeof skillDrafts
    skills: readonly Skill[]
  } | null>(null)
  const loading = loaded?.cache !== skillDrafts || loaded?.skills !== skills
  const [error, setError] = useState("")
  const [message, setMessage] = useState("")
  const [busy, setBusy] = useState(false)
  const operation = useRef(false)
  const mounted = useRef(false)
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
  const skill = skills.find((entry) => entry.id === skillId) ?? skills[0]
  const path = (skill && paths[skill.id]) ?? "SKILL.md"
  const file = skill?.files.find((entry) => entry.path === path)
  const key = fileKey(skill?.id ?? "", path)
  const selectedKey = useRef(key)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    let live = true
    void Promise.resolve()
      .then(() => skillDrafts.load(skills))
      .then(
        (drafts) => {
          if (!live) return
          // A refreshed catalog must not replace edits already held by this screen.
          setSaved((current) => ({ ...drafts, ...current }))
          setContents((current) => ({ ...drafts, ...current }))
          setLoaded({ cache: skillDrafts, skills })
        },
        () => {
          if (!live) return
          setError(
            "无法读取本地草稿。请检查存储权限；新编辑的内容会暂留在页面中。"
          )
          setLoaded({ cache: skillDrafts, skills })
        }
      )
    return () => {
      live = false
    }
  }, [skillDrafts, skills])
  const source = contents[key] ?? file?.content ?? ""
  const currentSource = useRef(source)
  useLayoutEffect(() => {
    selectedKey.current = key
    currentSource.current = source
  }, [key, source])
  const original = file?.content ?? ""
  const dirty = source !== (saved[key] ?? original)
  const markdown = path.toLowerCase().endsWith(".md")
  const unsaved = skills.some((item) =>
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
  const resolveScroll = useCallback(
    () => editorPreviewRef.current ?? scrollRef.current,
    []
  )
  const { scrollToY, scrollToHeading } = useHeadingScroll(
    resolveScroll,
    `${key}:${editing ? mode : "reading"}`
  )

  async function save() {
    if (!skill || !file || !editing || loading || operation.current) return
    if (!dirty) {
      setEditing(false)
      return
    }
    operation.current = true
    setBusy(true)
    try {
      await skillDrafts.save(skill.id, path, source)
      if (!mounted.current) return
      setSaved((current) => ({ ...current, [key]: source }))
      if (selectedKey.current === key) {
        setError("")
        if (currentSource.current === source) {
          setMessage("草稿已保存")
          setEditing(false)
        }
      }
    } catch {
      if (mounted.current && selectedKey.current === key)
        setError(
          "草稿保存失败，编辑内容仍在页面中。请检查存储权限或可用空间，再重试保存。"
        )
    } finally {
      operation.current = false
      if (mounted.current) setBusy(false)
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
        void save()
      }
    }
    window.addEventListener("keydown", shortcut)
    return () => window.removeEventListener("keydown", shortcut)
  })

  function selectFile(nextPath: string) {
    if (!skill) return
    setPaths((current) => ({ ...current, [skill.id]: nextPath }))
    setEditing(false)
    setMessage("")
  }

  async function restore() {
    if (!skill || loading || operation.current) return
    operation.current = true
    setBusy(true)
    try {
      if (
        !(await host.confirm(
          `将 ${path} 恢复为原始内容？此文件的编辑和本地草稿会被移除。`
        ))
      )
        return
      if (!mounted.current) return
      await skillDrafts.remove(skill.id, path)
      if (!mounted.current) return
      setContents((current) =>
        (current[key] ?? original) === source
          ? { ...current, [key]: original }
          : current
      )
      setSaved((current) => {
        const next = { ...current }
        delete next[key]
        return next
      })
      if (selectedKey.current === key) {
        setError("")
        setMessage("已恢复原始内容")
      }
    } catch {
      if (mounted.current && selectedKey.current === key)
        setError("未能移除本地草稿，内容保持原样。请检查存储权限后重试。")
    } finally {
      operation.current = false
      if (mounted.current) setBusy(false)
    }
  }

  function followLink(event: MouseEvent<HTMLDivElement>) {
    if (!skill) return
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
        const node = findDocsHeading(resolveScroll(), target.hash)
        if (node) scrollToHeading(node)
      } else {
        scrollToY(0)
      }
    })
  }

  const menuItems = useMemo<BranchedMenuItem[]>(() => {
    if (!skill) return []
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
    <MarkdownReading
      source={source}
      linkBase={`https://skill.invalid/${path}`}
      onSections={updateSections}
      onLink={followLink}
      empty={
        <p className="py-12 text-center text-sm text-muted-foreground">
          这个文件还是空的，点击「编辑」开始编写。
        </p>
      }
    />
  )

  const wide = editing && mode !== "preview"

  return (
    <div className="skill-docs" data-slot="skill-screen">
      {active && toolbarTarget
        ? createPortal(
            <div
              className="flex min-h-11 items-center gap-1 py-1"
              data-slot="skill-toolbar"
            >
              <Button
                variant="ghost"
                size="icon"
                className="skill-files-trigger rounded-full"
                aria-label="浏览技能文件"
                title={path}
                onClick={() => setNavOpen(true)}
              >
                <HugeiconsIcon
                  icon={Files01Icon}
                  size={18}
                  aria-hidden="true"
                />
              </Button>
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
                className="sr-only @min-[560px]/skill-header:not-sr-only @min-[560px]/skill-header:text-xs @min-[560px]/skill-header:text-muted-foreground"
              >
                {message}
              </div>
            </div>,
            toolbarTarget
          )
        : null}
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
        <div className="doc-action-surface relative flex min-h-0 min-w-0 flex-1">
          <DocumentActions
            editing={editing}
            busy={busy}
            disabled={loading || !skill || !file}
            dirty={dirty}
            saveLabel="保存草稿"
            onEdit={() => {
              setEditing(true)
              setMode("source")
              setMessage("")
            }}
            onSave={() => void save()}
            onUndo={() => {
              setContents((current) => ({
                ...current,
                [key]: saved[key] ?? original,
              }))
              setEditing(false)
              setError("")
              setMessage("")
            }}
            onRestore={
              saved[key] !== undefined || source !== original
                ? () => void restore()
                : undefined
            }
          />
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
              style={editing ? { height: "100%", maxWidth: "none" } : undefined}
            >
              <article
                className={cn(
                  "doc-article min-w-0 pt-2!",
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
                <MarkdownOutline
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
