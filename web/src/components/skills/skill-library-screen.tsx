import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
} from "react"
import {
  BookOpen,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  FileText,
  FolderOpen,
  LockKeyhole,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react"
import { useAppDependencies } from "@/app/dependencies"
import { Button } from "@/components/ui/button"
import { MarkdownEditor } from "@/components/markdown/markdown-editor"
import { MarkdownReading } from "@/components/markdown/markdown-reading"
import { FileManager } from "@/components/premium/file-manager/file-manager"
import {
  SkillLibraryError,
  skillFileMimeType,
  type ManagedSkill,
  type SkillEntry,
  type SkillLibrary,
} from "@/skills/library"
import { cn } from "@/lib/utils"
import { resolveSkillLink } from "@/skills/content"
import { findDocsHeading } from "@/components/premium/docs-pages/docs-data"
import "./skill-library.css"

type Edit = { value: string; saved: string }
type UploadResult = {
  id: number
  path: string
  file: File
  status: "saved" | "conflict" | "failed" | "skipped"
  message: string
}
const ignoreSections = () => {}
const editKey = (id: string, path: string) => `${id}\u0000${path}`
const includesEdit = (key: string, id: string, path: string) =>
  key === editKey(id, path) || key.startsWith(`${editKey(id, path)}/`)
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "操作失败，请保留当前内容后重试。"
const filename = (path: string) => path.split("/").at(-1) ?? path
const textFile = (entry: SkillEntry) =>
  entry.mimeType.startsWith("text/") ||
  /\.(md|mdx|txt|json|ya?ml|toml|ts|tsx|js|jsx|py|sh|css|html|csv|xml|svg|ini|conf|log)$/i.test(
    entry.path
  )
const dateLabel = (value: string | null) =>
  value
    ? new Intl.DateTimeFormat("zh-CN", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(value))
    : "—"

function SkillSourceLabel({ skill }: { skill: ManagedSkill }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px]",
        skill.origin === "official"
          ? "bg-primary/8 text-primary"
          : "bg-muted text-muted-foreground"
      )}
    >
      {skill.origin === "official" ? <LockKeyhole className="size-3" /> : null}
      {skill.origin === "official"
        ? `官方${skill.version ? ` · ${skill.version}` : ""}`
        : "本地"}
    </span>
  )
}

function FilePreview({
  library,
  skill,
  entry,
  edit,
  onEdit,
  onLoaded,
  busy,
  onSave,
  onClose,
  onOpenFile,
  hash,
}: {
  library: SkillLibrary
  skill: ManagedSkill
  entry: SkillEntry
  edit: Edit | undefined
  onEdit: (value: string) => void
  onLoaded: (value: string) => void
  busy: boolean
  onSave: (value: string) => Promise<void>
  onClose: () => void
  onOpenFile: (path: string, hash: string) => void
  hash: string
}) {
  const [loaded, setLoaded] = useState<{
    blob: Blob
    text?: string
    url: string
  } | null>(null)
  const root = useRef<HTMLElement>(null)
  const [error, setError] = useState("")
  const [editing, setEditing] = useState(false)
  const isText = textFile(entry)
  const loadCallback = useRef(onLoaded)
  useLayoutEffect(() => {
    loadCallback.current = onLoaded
  }, [onLoaded])
  useEffect(() => {
    let live = true
    let url: string | undefined
    void library
      .readFile(skill.id, entry.path)
      .then(async (blob) => {
        const text = isText ? await blob.text() : undefined
        if (!live) return
        url = URL.createObjectURL(blob)
        setLoaded({ blob, text, url })
        setError("")
        if (text !== undefined) loadCallback.current(text)
      })
      .catch((cause: unknown) => {
        if (live) setError(errorMessage(cause))
      })
    return () => {
      live = false
      if (url) URL.revokeObjectURL(url)
    }
  }, [library, skill.id, entry.path, entry.modifiedAt, isText])
  useEffect(() => {
    if (!loaded || !hash) return
    const request = requestAnimationFrame(() =>
      findDocsHeading(root.current, hash)?.scrollIntoView({ block: "start" })
    )
    return () => cancelAnimationFrame(request)
  }, [loaded, hash])
  function followLink(event: MouseEvent<HTMLDivElement>) {
    const anchor = (event.target as Element).closest("a")
    let href = anchor?.getAttribute("href")
    if (!href) return
    if (href.startsWith("https://skill.invalid/")) {
      const target = new URL(href)
      href = target.pathname + target.hash
    }
    const target = resolveSkillLink(entry.path, href)
    if (!target) return
    event.preventDefault()
    event.stopPropagation()
    if (
      !skill.entries.some(
        (item) => item.kind === "file" && item.path === target.path
      )
    ) {
      setError(`找不到文件 ${target.path}，请从目录选择已有文件。`)
      return
    }
    setError("")
    if (target.path === entry.path && target.hash)
      findDocsHeading(root.current, target.hash)?.scrollIntoView({
        block: "start",
      })
    else onOpenFile(target.path, target.hash)
  }
  const source = edit?.value ?? loaded?.text ?? ""
  const dirty = !!edit && edit.value !== edit.saved
  const markdown = /\.mdx?$/i.test(entry.path)
  const reading = (
    <div className="mx-auto max-w-[72ch]">
      <MarkdownReading
        source={source}
        linkBase={`https://skill.invalid/${entry.path}`}
        onSections={ignoreSections}
        onLink={followLink}
        empty={
          <p className="text-sm text-muted-foreground">
            这个文件还是空的，可以开始编辑。
          </p>
        }
      />
    </div>
  )
  const download = async () => {
    try {
      const blob = await library.readFile(skill.id, entry.path)
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement("a")
      anchor.href = url
      anchor.download = filename(entry.path)
      anchor.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }
  return (
    <section
      ref={root}
      className="skill-file-preview flex min-h-0 flex-1 flex-col"
      aria-label={`${entry.path} 文件内容`}
    >
      <div className="flex min-h-14 shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border px-5 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <FileText className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate text-sm font-medium" title={entry.path}>
            {entry.path}
          </span>
          {dirty ? (
            <span className="shrink-0 text-xs text-primary">未保存</span>
          ) : null}
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="icon-sm"
            title="下载文件"
            aria-label="下载文件"
            onClick={() => void download()}
          >
            <Download />
          </Button>
          {!skill.readOnly && loaded?.text !== undefined ? (
            <>
              {editing ? (
                <Button
                  size="sm"
                  className="rounded-full"
                  disabled={busy || !dirty}
                  onClick={() => void onSave(source)}
                >
                  {busy ? "保存中…" : "保存文件"}
                </Button>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  className="rounded-full"
                  onClick={() => setEditing(true)}
                >
                  编辑文件
                </Button>
              )}
            </>
          ) : null}
          <Button
            variant="ghost"
            size="icon-sm"
            title="关闭文件"
            aria-label="关闭文件"
            onClick={onClose}
          >
            <X />
          </Button>
        </div>
      </div>
      {error ? (
        <p role="alert" className="mx-5 mt-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {!loaded && !error ? (
        <div className="space-y-4 p-8" role="status" aria-label="正在读取文件">
          <div className="h-7 w-2/5 rounded bg-muted" />
          <div className="h-3 w-4/5 rounded bg-muted" />
          <div className="h-3 w-3/5 rounded bg-muted" />
        </div>
      ) : null}
      {loaded?.text !== undefined ? (
        editing ? (
          <div className="flex min-h-0 flex-1 p-4">
            <MarkdownEditor
              value={source}
              onChange={onEdit}
              ariaLabel={`${entry.path} 内容`}
              title={filename(entry.path)}
              markdown={markdown}
              preview={reading}
            />
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto p-6 md:p-8" tabIndex={0}>
            {markdown ? (
              reading
            ) : (
              <pre className="font-mono text-[13px] leading-6 break-words whitespace-pre-wrap">
                {source || "（空文件）"}
              </pre>
            )}
          </div>
        )
      ) : loaded ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 overflow-auto p-8">
          {entry.mimeType.startsWith("image/") &&
          entry.mimeType !== "image/svg+xml" ? (
            <img
              src={loaded.url}
              alt={filename(entry.path)}
              className="max-h-[60vh] max-w-full rounded-lg object-contain"
            />
          ) : (
            <>
              <FileText className="size-12 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                此文件暂不支持预览，可下载查看。
              </p>
              <Button
                variant="outline"
                className="rounded-full"
                onClick={() => void download()}
              >
                <Download />
                下载文件
              </Button>
            </>
          )}
        </div>
      ) : null}
    </section>
  )
}

export function SkillLibraryScreen({
  skillId,
  onOpenSkill,
  onCatalogChange,
  onExperiment,
}: {
  skillId: string | null
  onOpenSkill: (id: string | null) => void
  onCatalogChange?: (skills: readonly ManagedSkill[]) => void
  onExperiment?: (skillId: string) => void
}) {
  const { skillLibrary: library, skills: source } = useAppDependencies()
  const [catalog, setCatalog] = useState<readonly ManagedSkill[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [busy, setBusy] = useState(false)
  const operation = useRef(false)
  const mounted = useRef(false)
  const scope = useRef(skillId)
  const callback = useRef(onCatalogChange)
  const [query, setQuery] = useState("")
  const [filter, setFilter] = useState<"all" | "local" | "official">("all")
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState("")
  const [newDescription, setNewDescription] = useState("")
  const [deleting, setDeleting] = useState<string | null>(null)
  const [selected, setSelected] = useState<Record<string, string | null>>({})
  const [selectedHashes, setSelectedHashes] = useState<Record<string, string>>(
    {}
  )
  const [edits, setEdits] = useState<Record<string, Edit>>({})
  const [uploads, setUploads] = useState<Record<string, UploadResult[]>>({})
  const serial = useRef(0)
  useLayoutEffect(() => {
    scope.current = skillId
    callback.current = onCatalogChange
  }, [skillId, onCatalogChange])
  useEffect(() => {
    mounted.current = true
    let live = true
    const list = library
      ? library.list()
      : source.list().then((items) =>
          items.map((item) => ({
            id: item.id,
            name: item.name,
            description: item.description,
            origin: item.origin ?? "local",
            version: item.version,
            readOnly: true,
            modifiedAt: null,
            entries: item.files.map((file) => ({
              path: file.path,
              kind: "file" as const,
              size: new Blob([file.content]).size,
              mimeType: skillFileMimeType(file.path),
              modifiedAt: null,
            })),
          }))
        )
    void list
      .then((items) => {
        if (live) {
          setCatalog(items)
          setLoaded(true)
        }
      })
      .catch((cause: unknown) => {
        if (live) {
          setError(errorMessage(cause))
          setLoaded(true)
        }
      })
    return () => {
      live = false
      mounted.current = false
    }
  }, [library, source])
  const unsaved = Object.values(edits).some((edit) => edit.value !== edit.saved)
  useEffect(() => {
    if (!unsaved) return
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ""
    }
    window.addEventListener("beforeunload", warn)
    return () => window.removeEventListener("beforeunload", warn)
  }, [unsaved])
  const skill = catalog.find((item) => item.id === skillId)
  const selectedPath = skillId ? selected[skillId] : null
  const entry = skill?.entries.find(
    (item) => item.path === selectedPath && item.kind === "file"
  )
  const update = useCallback((next: ManagedSkill) => {
    if (!mounted.current) return
    setCatalog((current) => {
      const items = current.some((item) => item.id === next.id)
        ? current.map((item) => (item.id === next.id ? next : item))
        : [...current, next]
      return items
    })
  }, [])
  useEffect(() => {
    if (loaded) callback.current?.(catalog)
  }, [catalog, loaded])
  async function run<T>(work: () => Promise<T>, success?: string): Promise<T> {
    if (operation.current) throw new Error("正在保存，请稍后再试。")
    operation.current = true
    setBusy(true)
    setError("")
    const target = scope.current
    try {
      const result = await work()
      if (mounted.current && scope.current === target && success)
        setNotice(success)
      return result
    } catch (cause) {
      if (mounted.current && scope.current === target)
        setError(errorMessage(cause))
      throw cause
    } finally {
      operation.current = false
      if (mounted.current) setBusy(false)
    }
  }
  async function create() {
    if (!library) return
    try {
      await run(async () => {
        const created = await library.create({
          name: newName,
          description: newDescription,
        })
        update(created)
        if (mounted.current) {
          setCreating(false)
          setNewName("")
          setNewDescription("")
          if (scope.current === null) onOpenSkill(created.id)
        }
      })
    } catch {
      /* Form input remains available for retry. */
    }
  }
  async function copy(item: ManagedSkill) {
    if (!library) return
    const startingScope = scope.current
    try {
      await run(async () => {
        const copied = await library.copyToLocal(item.id)
        update(copied)
        if (mounted.current && scope.current === startingScope)
          onOpenSkill(copied.id)
      }, "已复制为本地 Skill")
    } catch {
      /* Error is displayed by run. */
    }
  }
  async function deleteSkill(item: ManagedSkill) {
    if (!library) return
    try {
      await run(async () => {
        await library.deleteSkill(item.id)
        if (mounted.current) {
          setCatalog((current) =>
            current.filter((value) => value.id !== item.id)
          )
          setDeleting(null)
        }
      }, "Skill 已删除")
    } catch {
      /* Confirmation remains open for retry. */
    }
  }
  async function mutate(work: () => Promise<ManagedSkill>, success: string) {
    return run(async () => {
      const result = await work()
      update(result)
    }, success)
  }
  async function uploadFiles(files: File[], folder: string) {
    if (!library || !skill) return
    const id = skill.id
    try {
      await run(async () => {
        const results: UploadResult[] = []
        for (const file of files) {
          const path = folder ? `${folder}/${file.name}` : file.name
          try {
            update(await library.writeFile(id, path, file))
            results.push({
              id: ++serial.current,
              path,
              file,
              status: "saved",
              message: "已保存",
            })
          } catch (cause) {
            results.push({
              id: ++serial.current,
              path,
              file,
              status:
                cause instanceof SkillLibraryError && cause.code === "conflict"
                  ? "conflict"
                  : "failed",
              message: errorMessage(cause),
            })
          }
          if (mounted.current)
            setUploads((current) => ({ ...current, [id]: [...results] }))
        }
      })
    } catch {
      /* Every completed file retains its individual result. */
    }
  }
  async function saveUploadedFile(result: UploadResult, replace: boolean) {
    if (!library || !skill) return
    const id = skill.id
    const key = editKey(id, result.path)
    if (replace && edits[key] && edits[key].value !== edits[key].saved) {
      setError("此文件有未保存的编辑。请先保存编辑，再替换上传文件。")
      return
    }
    try {
      await run(async () => {
        try {
          update(
            await library.writeFile(id, result.path, result.file, { replace })
          )
        } catch (cause) {
          if (mounted.current)
            setUploads((current) => ({
              ...current,
              [id]: (current[id] ?? []).map((item) =>
                item.id === result.id
                  ? {
                      ...item,
                      status:
                        cause instanceof SkillLibraryError &&
                        cause.code === "conflict"
                          ? "conflict"
                          : "failed",
                      message: errorMessage(cause),
                    }
                  : item
              ),
            }))
          throw cause
        }
        if (!mounted.current) return
        setEdits((current) => {
          const next = { ...current }
          delete next[key]
          return next
        })
        setUploads((current) => ({
          ...current,
          [id]: (current[id] ?? []).map((item) =>
            item.id === result.id
              ? {
                  ...item,
                  status: "saved",
                  message: replace ? "已替换并保存" : "已保存",
                }
              : item
          ),
        }))
      })
    } catch {
      /* Keep the conflicting file available for retry. */
    }
  }
  async function experiment() {
    if (!skill || !onExperiment || !library) return
    const id = skill.id
    try {
      await run(async () => {
        for (const [key, edit] of Object.entries(edits)) {
          if (!key.startsWith(`${id}\u0000`) || edit.value === edit.saved)
            continue
          const path = key.slice(id.length + 1)
          const next = await library.writeFile(
            id,
            path,
            new Blob([edit.value], { type: skillFileMimeType(path) }),
            { replace: true }
          )
          update(next)
          if (mounted.current)
            setEdits((current) => ({
              ...current,
              [key]: { ...current[key], saved: edit.value },
            }))
        }
      })
      if (mounted.current && scope.current === id) onExperiment(id)
    } catch {
      /* run preserves drafts and displays the failure. */
    }
  }
  const pathKey = skill && entry ? editKey(skill.id, entry.path) : ""
  const visible = catalog.filter(
    (item) =>
      (filter === "all" || item.origin === filter) &&
      `${item.name} ${item.description}`
        .toLowerCase()
        .includes(query.toLowerCase().trim())
  )
  const storageText =
    library?.storage.kind === "desktop"
      ? library.storage.root
      : "当前浏览器 · 与桌面端目录独立"
  return (
    <div
      className="skill-library flex h-full min-h-0 flex-col bg-background"
      data-testid="skill-library"
    >
      <div className="shrink-0 border-b border-border px-5 py-5 md:px-8 md:py-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            {skillId ? (
              <Button
                variant="ghost"
                size="sm"
                className="mb-3 -ml-2 rounded-full text-muted-foreground"
                onClick={() => onOpenSkill(null)}
              >
                <ChevronLeft />
                全部 Skill
              </Button>
            ) : null}
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-xl font-semibold tracking-tight">
                {skill?.name ?? (skillId ? "Skill 文件" : "Skill")}
              </h1>
              {skill ? <SkillSourceLabel skill={skill} /> : null}
            </div>
            <p className="mt-2 max-w-[70ch] text-[13px] leading-6 text-muted-foreground">
              {skill?.description ||
                (skillId
                  ? "管理这个 Skill 的文件与目录。"
                  : "整理操作规范、脚本和参考资料，构建 Agent 的技能。")}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {skill && onExperiment ? (
              <Button
                variant="outline"
                className="rounded-full"
                disabled={busy || !library}
                onClick={() => void experiment()}
              >
                在新会话中实验
              </Button>
            ) : null}
            {skill ? (
              skill.origin === "official" ? (
                <Button
                  className="rounded-full"
                  disabled={busy || !library}
                  onClick={() => void copy(skill)}
                >
                  <Copy />
                  复制为本地 Skill
                </Button>
              ) : null
            ) : !skillId ? (
              <Button
                className="rounded-full"
                disabled={busy || !library}
                onClick={() => setCreating((value) => !value)}
              >
                <Plus />
                新建 Skill
              </Button>
            ) : null}
          </div>
        </div>
        {skill?.readOnly ? (
          <p className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
            <LockKeyhole className="size-3.5" />
            {skill.origin === "official"
              ? "官方已发布版本只读，需要修改时可复制为本地 Skill。"
              : "当前接入仅支持查看文件。"}
          </p>
        ) : null}
      </div>
      {!library ? (
        <p
          role="status"
          className="border-b border-border bg-muted px-5 py-3 text-sm text-muted-foreground"
        >
          当前接入尚未提供 Skill
          文件存储，仅显示已有目录。连接文件存储后即可管理。
        </p>
      ) : null}
      {error ? (
        <div
          role="alert"
          className="flex items-start justify-between gap-4 border-b border-border bg-destructive/5 px-5 py-3 text-sm text-destructive"
        >
          <span>{error}</span>
          <button
            aria-label="关闭错误提示"
            onClick={() => setError("")}
            className="rounded outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="size-4" />
          </button>
        </div>
      ) : null}
      {notice ? (
        <div
          role="status"
          className="flex items-center justify-between gap-3 border-b border-border px-5 py-2 text-xs text-primary"
        >
          <span>{notice}</span>
          <button
            aria-label="关闭操作提示"
            onClick={() => setNotice("")}
            className="rounded outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="size-3.5" />
          </button>
        </div>
      ) : null}
      {!loaded ? (
        <div
          className="space-y-6 p-8"
          role="status"
          aria-label="正在读取 Skill"
        >
          <div className="h-9 w-1/3 rounded-full bg-muted" />
          {[1, 2, 3].map((item) => (
            <div key={item} className="h-14 w-full rounded-lg bg-muted" />
          ))}
        </div>
      ) : !skillId ? (
        <div className="min-h-0 flex-1 overflow-auto px-5 py-6 md:px-8">
          {creating ? (
            <form
              className="mb-6 rounded-xl border border-border bg-muted/30 p-5"
              onSubmit={(event) => {
                event.preventDefault()
                void create()
              }}
            >
              <div className="flex items-center justify-between gap-4">
                <h2 className="text-sm font-medium">新建本地 Skill</h2>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="取消新建 Skill"
                  onClick={() => setCreating(false)}
                  type="button"
                >
                  <X />
                </Button>
              </div>
              <div className="mt-4 grid gap-4 md:grid-cols-2">
                <label className="grid gap-2 text-xs font-medium">
                  名称
                  <input
                    autoFocus
                    className="skill-input"
                    value={newName}
                    onChange={(event) => setNewName(event.target.value)}
                    placeholder="例如：生产环境巡检"
                    maxLength={100}
                    required
                  />
                </label>
                <label className="grid gap-2 text-xs font-medium">
                  说明（可选）
                  <input
                    className="skill-input"
                    value={newDescription}
                    onChange={(event) => setNewDescription(event.target.value)}
                    placeholder="这个 Skill 解决什么问题"
                  />
                </label>
              </div>
              <div className="mt-4 flex items-center justify-between gap-4">
                <span className="text-xs text-muted-foreground">
                  创建后会生成 SKILL.md，可继续添加文件。
                </span>
                <Button
                  type="submit"
                  className="rounded-full"
                  disabled={busy || !newName.trim()}
                >
                  创建 Skill
                </Button>
              </div>
            </form>
          ) : null}
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
            <div className="flex gap-1" role="group" aria-label="Skill 来源">
              {(["all", "local", "official"] as const).map((value) => (
                <Button
                  key={value}
                  variant="ghost"
                  size="sm"
                  className={cn(
                    "rounded-full px-4 text-muted-foreground",
                    filter === value && "bg-muted text-foreground"
                  )}
                  aria-pressed={filter === value}
                  onClick={() => setFilter(value)}
                >
                  {value === "all"
                    ? "全部"
                    : value === "local"
                      ? "本地"
                      : "官方"}
                </Button>
              ))}
            </div>
            <label className="flex w-full items-center gap-2 rounded-full border border-border px-3 sm:w-64">
              <Search className="size-4 text-muted-foreground" />
              <input
                className="h-9 min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground"
                aria-label="搜索 Skill"
                placeholder="搜索 Skill"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
          </div>
          <div className="skill-catalog-heading grid grid-cols-[minmax(0,1fr)_7rem_8rem_3rem] gap-3 border-b border-border px-3 pb-3 text-[11px] text-muted-foreground">
            <span>名称</span>
            <span>来源</span>
            <span>最近修改</span>
            <span />
          </div>
          {visible.map((item) => (
            <div key={item.id} className="border-b border-border last:border-0">
              <div className="skill-catalog-row grid grid-cols-[minmax(0,1fr)_7rem_8rem_3rem] items-center gap-3 rounded-lg px-3 py-4 transition-colors hover:bg-muted/50">
                <button
                  className="flex min-w-0 items-center gap-3 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => onOpenSkill(item.id)}
                >
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted text-primary">
                    <BookOpen className="size-5" strokeWidth={1.5} />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">
                      {item.name}
                    </span>
                    <span className="mt-1 block truncate text-xs text-muted-foreground">
                      {item.description ||
                        `${item.entries.filter((value) => value.kind === "file").length} 个文件`}
                    </span>
                  </span>
                </button>
                <div className="skill-catalog-source">
                  <SkillSourceLabel skill={item} />
                </div>
                <span className="skill-catalog-date text-xs text-muted-foreground tabular-nums">
                  {dateLabel(item.modifiedAt)}
                </span>
                <div className="flex justify-end">
                  {item.origin === "official" ? (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      title={`复制 ${item.name}`}
                      aria-label={`复制 ${item.name}`}
                      disabled={busy || !library}
                      onClick={() => void copy(item)}
                    >
                      <Copy />
                    </Button>
                  ) : (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      title={`删除 ${item.name}`}
                      aria-label={`删除 ${item.name}`}
                      disabled={busy || !library}
                      onClick={() => setDeleting(item.id)}
                    >
                      <Trash2 />
                    </Button>
                  )}
                </div>
              </div>
              {deleting === item.id ? (
                <div className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-muted px-4 py-3">
                  <p className="text-xs">
                    删除「{item.name}」及其中全部文件？此操作不能撤销。
                  </p>
                  <div className="flex gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setDeleting(null)}
                    >
                      取消
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      disabled={busy}
                      onClick={() => void deleteSkill(item)}
                    >
                      确认删除
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
          ))}
          {!visible.length ? (
            <div className="flex flex-col items-center py-16 text-center">
              <FolderOpen
                className="mb-4 size-9 text-muted-foreground"
                strokeWidth={1.5}
              />
              <h2 className="text-sm font-medium">
                {query || filter !== "all"
                  ? "没有匹配的 Skill"
                  : "从第一个 Skill 开始"}
              </h2>
              <p className="mt-2 text-xs text-muted-foreground">
                {query || filter !== "all"
                  ? "试试其他关键词，或切换来源。"
                  : "新建 Skill，然后添加 SKILL.md、脚本和参考文件。"}
              </p>
              {!query && filter === "all" ? (
                <Button
                  className="mt-5 rounded-full"
                  disabled={!library}
                  onClick={() => setCreating(true)}
                >
                  <Plus />
                  新建 Skill
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : skill ? (
        <div className="min-h-0 flex-1 overflow-hidden">
          {entry && library ? (
            <FilePreview
              key={`${skill.id}:${entry.path}`}
              library={library}
              skill={skill}
              entry={entry}
              edit={edits[pathKey]}
              busy={busy}
              hash={selectedHashes[skill.id] ?? ""}
              onOpenFile={(path, hash) => {
                setSelected((current) => ({ ...current, [skill.id]: path }))
                setSelectedHashes((current) => ({
                  ...current,
                  [skill.id]: hash,
                }))
              }}
              onClose={() =>
                setSelected((current) => ({ ...current, [skill.id]: null }))
              }
              onLoaded={(value) =>
                setEdits((current) =>
                  current[pathKey]
                    ? current
                    : { ...current, [pathKey]: { value, saved: value } }
                )
              }
              onEdit={(value) =>
                setEdits((current) => ({
                  ...current,
                  [pathKey]: { value, saved: current[pathKey]?.saved ?? value },
                }))
              }
              onSave={async (value) => {
                try {
                  await mutate(
                    () =>
                      library.writeFile(
                        skill.id,
                        entry.path,
                        new Blob([value], {
                          type: entry.mimeType || skillFileMimeType(entry.path),
                        }),
                        { replace: true }
                      ),
                    "文件已保存"
                  )
                  if (mounted.current)
                    setEdits((current) => ({
                      ...current,
                      [pathKey]: {
                        value: current[pathKey]?.value ?? value,
                        saved: value,
                      },
                    }))
                } catch {
                  /* Keep editor content on failed persistence. */
                }
              }}
            />
          ) : (
            <div className="flex h-full min-h-0 flex-col">
              <FileManager
                key={skill.id}
                entries={skill.entries}
                disabled={busy || !library}
                readOnly={skill.readOnly}
                onOpenFile={(path) => {
                  setSelected((current) => ({ ...current, [skill.id]: path }))
                  setSelectedHashes((current) => ({
                    ...current,
                    [skill.id]: "",
                  }))
                  if (!library)
                    setError(
                      "当前接入未提供文件读取，请连接 Skill 文件存储后重试。"
                    )
                }}
                onUpload={uploadFiles}
                onCreateDirectory={(path) =>
                  library
                    ? mutate(
                        () => library.createDirectory(skill.id, path),
                        "目录已创建"
                      )
                    : Promise.reject(new Error("文件存储尚未连接"))
                }
                onCreateFile={(path) =>
                  library
                    ? mutate(
                        () =>
                          library.writeFile(
                            skill.id,
                            path,
                            new Blob([""], { type: skillFileMimeType(path) })
                          ),
                        "文件已创建"
                      )
                    : Promise.reject(new Error("文件存储尚未连接"))
                }
                onRename={async (path, next) => {
                  if (!library) return
                  if (
                    Object.entries(edits).some(
                      ([key, edit]) =>
                        includesEdit(key, skill.id, path) &&
                        edit.value !== edit.saved
                    )
                  )
                    throw new Error(
                      "请先保存此文件或目录下的未保存编辑，再重命名。"
                    )
                  await mutate(
                    () => library.rename(skill.id, path, next),
                    "名称已更新"
                  )
                }}
                onRemove={async (path) => {
                  if (!library) return
                  if (
                    Object.entries(edits).some(
                      ([key, edit]) =>
                        includesEdit(key, skill.id, path) &&
                        edit.value !== edit.saved
                    )
                  )
                    throw new Error(
                      "请先保存此文件或目录下的未保存编辑，再删除。"
                    )
                  await mutate(() => library.remove(skill.id, path), "已删除")
                  setEdits((current) =>
                    Object.fromEntries(
                      Object.entries(current).filter(
                        ([key]) => !includesEdit(key, skill.id, path)
                      )
                    )
                  )
                }}
              />
              {(uploads[skill.id]?.length ?? 0) > 0 ? (
                <section
                  aria-label="文件上传结果"
                  className="max-h-52 shrink-0 overflow-auto border-t border-border bg-muted/30 px-5 py-3"
                >
                  <div className="mb-2 flex items-center justify-between">
                    <h2 className="text-xs font-medium">文件上传结果</h2>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label="关闭上传结果"
                      disabled={busy}
                      onClick={() =>
                        setUploads((current) => ({
                          ...current,
                          [skill.id]: [],
                        }))
                      }
                    >
                      <X />
                    </Button>
                  </div>
                  {uploads[skill.id]?.map((result) => (
                    <div
                      key={result.id}
                      className="flex flex-wrap items-center justify-between gap-2 py-1.5 text-xs"
                    >
                      <span
                        className="min-w-0 flex-1 truncate"
                        title={result.path}
                      >
                        {result.path}
                      </span>
                      <span
                        className={cn(
                          "max-w-64",
                          result.status === "saved"
                            ? "text-primary"
                            : "text-muted-foreground"
                        )}
                      >
                        {result.status === "conflict"
                          ? "同名文件已存在"
                          : result.message}
                      </span>
                      {result.status === "conflict" ? (
                        <div className="flex gap-1">
                          <Button
                            size="xs"
                            variant="outline"
                            className="rounded-full"
                            disabled={busy}
                            onClick={() => void saveUploadedFile(result, true)}
                          >
                            替换
                          </Button>
                          <Button
                            size="xs"
                            variant="ghost"
                            disabled={busy}
                            onClick={() =>
                              setUploads((current) => ({
                                ...current,
                                [skill.id]: current[skill.id].map((item) =>
                                  item.id === result.id
                                    ? {
                                        ...item,
                                        status: "skipped",
                                        message: "已跳过",
                                      }
                                    : item
                                ),
                              }))
                            }
                          >
                            跳过
                          </Button>
                        </div>
                      ) : null}
                      {result.status === "failed" ? (
                        <Button
                          size="xs"
                          variant="outline"
                          className="rounded-full"
                          disabled={busy}
                          onClick={() => void saveUploadedFile(result, false)}
                        >
                          重试
                        </Button>
                      ) : null}
                    </div>
                  ))}
                </section>
              ) : null}
            </div>
          )}
        </div>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8">
          <FolderOpen className="size-9 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            这个 Skill 已不存在，请返回列表选择。
          </p>
          <Button
            variant="outline"
            className="rounded-full"
            onClick={() => onOpenSkill(null)}
          >
            返回 Skill 列表
            <ChevronRight />
          </Button>
        </div>
      )}
      <footer className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-border px-5 py-2.5 text-[11px] text-muted-foreground md:px-8">
        <span className="truncate" title={storageText}>
          {storageText}
        </span>
        <span>
          {skill?.origin === "official"
            ? "已发布文件包 · 只读"
            : "本地文件 · 保存后生效"}
        </span>
      </footer>
    </div>
  )
}
