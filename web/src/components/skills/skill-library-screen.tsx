import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react"
import {
  BookOpen,
  ChevronRight,
  Copy,
  FileText,
  FolderOpen,
  LockKeyhole,
  Search,
  Trash2,
  X,
} from "lucide-react"
import { useAppDependencies } from "@/app/dependencies"
import { Button } from "@/components/motion/button"
import { Input } from "@/components/motion/input"
import { Select } from "@/components/premium/select/select"
import { useSaveShortcut } from "@/hooks/use-save-shortcut"
import { HugeiconsIcon } from "@hugeicons/react"
import { Bug01Icon } from "@hugeicons-pro/core-stroke-rounded"
import { SkillDocument } from "./skill-document"
import { SkillScreen } from "./skill-screen"
import type { Skill } from "@/skills/source"
import { EMPTY_SKILL_CONTENT, readSkillMetadata } from "@/skills/content"
import {
  skillFileMimeType,
  type ManagedSkill,
  type SkillEntry,
  type SkillLibrary,
} from "@/skills/library"
import { cn } from "@/lib/utils"
import "./skill-library.css"

type Edit = { value: string; saved: string }
const editKey = (id: string, path: string) => `${id}\u0000${path}`
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "操作失败，请保留当前内容后重试。"
const filename = (path: string) => path.split("/").at(-1) ?? path
const textFile = (entry: SkillEntry) =>
  entry.mimeType.startsWith("text/") ||
  /\.(md|mdx|txt|json|ya?ml|toml|ts|tsx|js|jsx|py|sh|css|html|csv|xml|svg|ini|conf|log)$/i.test(
    entry.path
  )
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
      {skill.origin === "official" ? "官方" : "本地"}
    </span>
  )
}

function PackageEntries({
  skill,
  busy,
  onApply,
}: {
  skill: ManagedSkill
  busy: boolean
  onApply: (action: string, path: string, destination: string) => Promise<void>
}) {
  const [action, setAction] = useState("mkdir")
  const [path, setPath] = useState("")
  const [destination, setDestination] = useState("")
  const needsTarget = action === "rename" || action === "remove"
  return (
    <details className="shrink-0 border-b border-border px-5 py-2 text-xs">
      <summary className="cursor-pointer">管理文件与目录</summary>
      <form
        className="flex flex-wrap items-end gap-3 py-3"
        aria-label="管理 Skill 文件与目录"
        onSubmit={(event) => {
          event.preventDefault()
          void onApply(action, path, destination.trim())
            .then(() => setDestination(""))
            .catch(() => {
              // The owner displays the error and keeps this form available for retry.
            })
        }}
      >
        <div className="flex min-w-0 flex-1 basis-40 flex-col gap-1.5">
          <span className="font-medium">操作</span>
          <Select
            label="文件操作"
            value={action}
            disabled={busy}
            onValueChange={setAction}
            options={[
              { id: "mkdir", label: "创建目录" },
              { id: "file", label: "创建文件" },
              { id: "rename", label: "重命名" },
              { id: "remove", label: "删除" },
            ]}
            portal
            className="w-full"
            buttonClassName="w-full min-w-0 pointer-coarse:h-11"
          />
        </div>
        {needsTarget ? (
          <label className="flex min-w-0 flex-1 basis-48 flex-col gap-1.5">
            <span className="font-medium">目标</span>
            {/* Native required validation must still block submitting an empty target. */}
            <select
              aria-label="操作目标"
              value={path}
              disabled={busy}
              required
              onChange={(event) => setPath(event.target.value)}
              className="h-10 w-full min-w-0 rounded-full border border-border bg-background px-3 text-sm font-medium text-foreground outline-none transition-colors hover:border-border-strong focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 pointer-coarse:h-11 motion-reduce:transition-none"
            >
              <option value="">选择文件或目录</option>
              {skill.entries.map((entry) => (
                <option key={entry.path} value={entry.path}>
                  {entry.path}
                  {entry.kind === "folder" ? "/" : ""}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {action !== "remove" ? (
          <Input
            aria-label="目标路径"
            label={action === "mkdir" ? "目录路径" : "新路径"}
            value={destination}
            onChange={setDestination}
            required
            disabled={busy}
            className="min-w-0 flex-1 basis-48"
            classNames={{
              label: "px-0 text-xs font-medium",
              field: "h-10 pointer-coarse:h-11",
            }}
          />
        ) : (
          <p>删除文件或目录及其全部内容，不能撤销。</p>
        )}
        <Button
          size="sm"
          type="submit"
          variant={action === "remove" ? "destructive" : "outline"}
          disabled={
            busy ||
            (needsTarget && !skill.entries.some((entry) => entry.path === path))
          }
        >
          {action === "mkdir"
            ? "创建目录"
            : action === "file"
              ? "创建文件"
              : action === "rename"
                ? "确认重命名"
                : "确认删除条目"}
        </Button>
      </form>
    </details>
  )
}

function FilePreview({
  library,
  skill,
  entry,
  edit,
  files,
  onEdit,
  onLoaded,
  busy,
  onSave,
  onOpenFile,
  active,
  actions,
  initialEditing = false,
  locked = false,
  onAddFile,
}: {
  library: SkillLibrary
  skill: ManagedSkill
  entry: SkillEntry
  edit: Edit | undefined
  files: readonly { path: string; modified: boolean }[]
  onEdit: (value: string) => void
  onLoaded: (value: string) => void
  busy: boolean
  onSave: (value: string) => Promise<void>
  onOpenFile: (path: string) => void
  active: boolean
  actions: ReactNode
  initialEditing?: boolean
  locked?: boolean
  onAddFile?: (path: string, content: Blob, replace?: boolean) => Promise<void>
}) {
  const [readResult, setLoaded] = useState<{
    entry: SkillEntry
    text?: string
    url: string
  } | null>(null)
  const loaded = readResult?.entry === entry ? readResult : null
  const [error, setError] = useState("")
  const [readError, setReadError] = useState<{
    entry: SkillEntry
    message: string
  } | null>(null)
  const [readAttempt, setReadAttempt] = useState(0)
  const readFailure = readError?.entry === entry ? readError.message : ""
  const [editingPath, setEditingPath] = useState<string | null>(
    initialEditing ? entry.path : null
  )
  const editing = editingPath === entry.path
  const isText = textFile(entry)
  const loadCallback = useRef(onLoaded)
  const currentSource = useRef("")
  const currentPath = useRef(entry.path)
  const mounted = useRef(false)
  const currentActive = useRef(active)
  const source = edit?.value ?? loaded?.text ?? ""
  const ready = !!loaded || (isText && edit !== undefined)
  const retryRead = () => {
    setReadError(null)
    setReadAttempt((value) => value + 1)
  }
  useLayoutEffect(() => {
    loadCallback.current = onLoaded
    currentSource.current = source
    currentPath.current = entry.path
    currentActive.current = active
  }, [onLoaded, source, entry.path, active])
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    let live = true
    let url: string | undefined
    void library
      .readFile(skill.id, entry.path)
      .then(async (blob) => {
        const text = isText ? await blob.text() : undefined
        if (!live) return
        url = URL.createObjectURL(blob)
        setLoaded({ entry, text, url })
        setReadError(null)
        setError("")
        if (text !== undefined) loadCallback.current(text)
      })
      .catch((cause: unknown) => {
        if (live)
          setReadError({
            entry,
            message: errorMessage(cause),
          })
      })
    return () => {
      live = false
      if (url) URL.revokeObjectURL(url)
    }
  }, [library, skill.id, entry, isText, readAttempt])
  const dirty = !!edit && edit.value !== edit.saved
  async function save() {
    if (busy || !ready || !editing || skill.readOnly) return
    if (!dirty) {
      setEditingPath(null)
      return
    }
    try {
      await onSave(source)
      if (
        mounted.current &&
        currentPath.current === entry.path &&
        currentSource.current === source
      )
        setEditingPath(null)
    } catch {
      // The library displays the error; keep the current editor available for retry.
    }
  }
  useSaveShortcut({
    active,
    enabled: editing,
    onSave: () => void save(),
  })
  return (
    <section
      className="skill-file-preview flex min-h-0 flex-1 flex-col"
      aria-label={`${entry.path} 文件内容`}
    >
      {error || (readFailure && ready) ? (
        <div
          role="alert"
          className="mx-5 my-3 flex flex-wrap items-center gap-3 text-sm text-destructive"
        >
          <p>{error || readFailure}</p>
          {readFailure && ready ? (
            <Button variant="outline" size="sm" onClick={retryRead}>
              重新读取文件
            </Button>
          ) : null}
        </div>
      ) : null}
      <SkillDocument
        files={files}
        path={entry.path}
        source={source}
        active={active}
        actions={actions}
        loading={!ready && !readFailure}
        busy={busy}
        dirty={dirty}
        readOnly={
          locked || skill.readOnly || !isText || (!ready && !!readFailure)
        }
        editing={editing}
        saveLabel="保存文件"
        onEdit={() => setEditingPath(entry.path)}
        onSave={() => void save()}
        onUndo={() => {
          onEdit(edit?.saved ?? loaded?.text ?? "")
          setEditingPath(null)
          setError("")
        }}
        onChange={onEdit}
        onSelectFile={(path) => {
          setEditingPath(null)
          setError("")
          onOpenFile(path)
        }}
        onAddFile={
          onAddFile
            ? async (path, content, replace) => {
                await onAddFile(path, content, replace)
                if (
                  mounted.current &&
                  currentActive.current &&
                  currentPath.current === entry.path
                ) {
                  setEditingPath(path)
                  onOpenFile(path)
                }
              }
            : undefined
        }
        onError={setError}
        preview={
          readFailure && !ready ? (
            <div className="flex min-h-64 flex-col items-center justify-center gap-4 p-6 text-center">
              <p role="alert" className="text-sm text-destructive">
                {readFailure}
              </p>
              <Button
                variant="outline"
                className="rounded-full"
                onClick={retryRead}
              >
                重新读取文件
              </Button>
            </div>
          ) : !isText ? (
            <div className="flex min-h-64 flex-col items-center justify-center gap-4 p-8">
              {!loaded ? (
                <p role="status">正在读取文件…</p>
              ) : entry.mimeType.startsWith("image/") ? (
                <img
                  src={loaded.url}
                  alt={filename(entry.path)}
                  width={800}
                  height={600}
                  className="max-h-[60vh] max-w-full object-contain"
                />
              ) : (
                <>
                  <FileText className="size-12 text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">
                    此文件暂不支持预览。
                  </p>
                </>
              )}
            </div>
          ) : undefined
        }
      />
    </section>
  )
}

export function SkillLibraryScreen({
  skillId,
  onOpenSkill,
  onCatalogChange,
  onExperiment,
  active = true,
  creating = false,
}: {
  skillId: string | null
  onOpenSkill: (id: string | null) => void
  onCatalogChange?: (skills: readonly ManagedSkill[]) => void
  onExperiment?: (skillId: string) => void
  active?: boolean
  creating?: boolean
}) {
  const { skillLibrary: library, skills: source } = useAppDependencies()
  const [catalog, setCatalog] = useState<readonly ManagedSkill[]>([])
  const [sourceSkills, setSourceSkills] = useState<readonly Skill[]>([])
  const [loaded, setLoaded] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [busy, setBusy] = useState(false)
  const [entriesLocked, setEntriesLocked] = useState(false)
  const operation = useRef(false)
  const mounted = useRef(false)
  const scope = useRef(skillId)
  const currentActive = useRef(active)
  const currentCreating = useRef(creating)
  const callback = useRef(onCatalogChange)
  const [query, setQuery] = useState("")
  const [filter, setFilter] = useState<"all" | "local" | "official">("all")
  const [newContent, setNewContent] = useState(EMPTY_SKILL_CONTENT)
  const draftContent = useRef(newContent)
  useLayoutEffect(() => {
    draftContent.current = newContent
  }, [newContent])
  const searchInput = useRef<HTMLInputElement>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [selected, setSelected] = useState<Record<string, string | null>>({})
  const [edits, setEdits] = useState<Record<string, Edit>>({})
  const currentEdits = useRef(edits)
  useLayoutEffect(() => {
    scope.current = skillId
    currentActive.current = active
    currentCreating.current = creating
    callback.current = onCatalogChange
    currentEdits.current = edits
  }, [skillId, active, creating, onCatalogChange, edits])
  useEffect(() => {
    mounted.current = true
    let live = true
    const list = library
      ? library.list()
      : source.list().then((items) => {
          if (live) setSourceSkills(items)
          return items.map((item) => ({
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
        })
    void list
      .then((items) => {
        if (live) {
          setCatalog(items)
          setLoadFailed(false)
          setLoaded(true)
        }
      })
      .catch((cause: unknown) => {
        if (live) {
          setError(errorMessage(cause))
          setLoadFailed(true)
          setLoaded(true)
        }
      })
    return () => {
      live = false
      mounted.current = false
    }
  }, [library, source, loadAttempt])
  const unsaved =
    Object.values(edits).some((edit) => edit.value !== edit.saved) ||
    newContent !== EMPTY_SKILL_CONTENT
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
  const selectedPath =
    skill &&
    (skill.entries.find(
      (item) => item.kind === "file" && item.path === selected[skill.id]
    )?.path ??
      skill.entries.find((item) => item.path === "SKILL.md")?.path ??
      skill.entries.find((item) => item.kind === "file")?.path)
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
    if (loaded && !loadFailed) callback.current?.(catalog)
  }, [catalog, loaded, loadFailed])
  async function run<T>(work: () => Promise<T>, success?: string): Promise<T> {
    if (operation.current) throw new Error("正在保存，请稍后再试。")
    operation.current = true
    setBusy(true)
    setError("")
    setNotice("")
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
    if (operation.current) return
    if (!library) return
    const content = newContent
    if (new Blob([content]).size > 256 * 1024) {
      setError("SKILL.md 不能超过 256 KiB，请精简内容后保存。")
      return
    }
    try {
      const metadata = readSkillMetadata(content)
      await run(async () => {
        const created = await library.create({
          ...metadata,
          content,
        })
        update(created)
        if (mounted.current) {
          const value = draftContent.current
          setNewContent(EMPTY_SKILL_CONTENT)
          setEdits((current) => ({
            ...current,
            [editKey(created.id, "SKILL.md")]: {
              value,
              saved: content,
            },
          }))
          if (
            scope.current === null &&
            currentActive.current &&
            currentCreating.current
          )
            onOpenSkill(created.id)
        }
      })
    } catch (cause) {
      if (mounted.current && currentCreating.current && scope.current === null)
        setError(errorMessage(cause))
    }
  }
  async function copy(item: ManagedSkill) {
    if (!library) return
    const startingScope = scope.current
    try {
      await run(async () => {
        const copied = await library.copyToLocal(item.id)
        update(copied)
        if (
          mounted.current &&
          scope.current === startingScope &&
          currentActive.current
        )
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
          setEdits((current) =>
            Object.fromEntries(
              Object.entries(current).filter(
                ([key]) => !key.startsWith(`${item.id}\u0000`)
              )
            )
          )
          setSelected((current) => ({ ...current, [item.id]: null }))
          if (scope.current === item.id && currentActive.current)
            onOpenSkill(null)
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
  async function mutateEntries(
    work: () => Promise<ManagedSkill>,
    success: string
  ) {
    if (operation.current) throw new Error("正在保存，请稍后再试。")
    setEntriesLocked(true)
    try {
      await mutate(work, success)
    } finally {
      if (mounted.current) setEntriesLocked(false)
    }
  }
  async function experiment() {
    if (!skill || skill.readOnly || !onExperiment || !library) return
    const main = skill.entries.find(
      (item) => item.kind === "file" && item.path === "SKILL.md"
    )
    if (!main) {
      setError("请先新建或上传 SKILL.md，再开始实验。")
      return
    }
    const mainEdit = currentEdits.current[editKey(skill.id, "SKILL.md")]
    if ((mainEdit ? new Blob([mainEdit.value]).size : main.size) > 256 * 1024) {
      setError(
        "SKILL.md 不能超过 256 KiB，请精简入口并将参考资料拆分为独立文件。"
      )
      setSelected((current) => ({ ...current, [skill.id]: "SKILL.md" }))
      return
    }
    const id = skill.id
    const snapshot = currentEdits.current
    try {
      await run(async () => {
        for (const [key, edit] of Object.entries(snapshot)) {
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
      if (mounted.current && scope.current === id && currentActive.current) {
        if (
          Object.entries(currentEdits.current).some(
            ([key, edit]) =>
              key.startsWith(`${id}\u0000`) &&
              edit.value !== (snapshot[key]?.value ?? edit.saved)
          )
        ) {
          setError("保存期间还有新的修改，请再次点击实验以使用最新内容。")
          return
        }
        onExperiment(id)
      }
    } catch {
      /* run preserves drafts and displays the failure. */
    }
  }
  useSaveShortcut({
    active: active && creating,
    enabled: creating,
    onSave: () => {
      if (!operation.current) void create()
    },
  })
  const pathKey = skill && entry ? editKey(skill.id, entry.path) : ""
  const visible = catalog.filter(
    (item) =>
      (filter === "all" || item.origin === filter) &&
      `${item.name} ${item.description}`
        .toLowerCase()
        .includes(query.toLowerCase().trim())
  )
  const detailActions = skill ? (
    <>
      {onExperiment && !skill.readOnly ? (
        <Button
          variant="ghost"
          size="icon"
          className="size-7 text-muted-foreground/70 hover:text-foreground"
          aria-label="在新会话中实验"
          title="在新会话中实验"
          disabled={busy || !library}
          onClick={() => void experiment()}
        >
          <HugeiconsIcon icon={Bug01Icon} size={16} aria-hidden="true" />
        </Button>
      ) : null}
      {skill.origin === "official" ? (
        <Button
          variant="ghost"
          size="icon"
          className="size-7 text-muted-foreground/70 hover:text-foreground"
          aria-label="复制为本地 Skill"
          title="复制为本地 Skill"
          disabled={busy || !library}
          onClick={() => void copy(skill)}
        >
          <Copy />
        </Button>
      ) : null}
    </>
  ) : null
  return (
    <div
      className="skill-library relative flex h-full min-h-0 flex-col bg-background"
      data-testid="skill-library"
    >
      {!skillId && !creating ? <h1 className="sr-only">Skill</h1> : null}
      {!library ? (
        <p
          role="status"
          className="border-b border-border bg-muted px-5 py-3 text-sm text-muted-foreground"
        >
          当前接入的 Skill 仅供阅读。
        </p>
      ) : null}
      {error ? (
        <div
          role="alert"
          className="flex items-start justify-between gap-4 border-b border-border bg-destructive/5 px-5 py-3 text-sm text-destructive"
        >
          <span>{error}</span>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="关闭错误提示"
            onClick={() => setError("")}
            className="shrink-0 text-inherit hover:text-inherit"
          >
            <X className="size-4" />
          </Button>
        </div>
      ) : null}
      {notice ? (
        <div
          role="status"
          className="flex items-center justify-between gap-3 border-b border-border px-5 py-2 text-xs text-primary"
        >
          <span>{notice}</span>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="关闭操作提示"
            onClick={() => setNotice("")}
            className="shrink-0 text-inherit hover:text-inherit"
          >
            <X className="size-3.5" />
          </Button>
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
      ) : loadFailed ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
          <p className="text-sm text-muted-foreground">未能读取技能列表。</p>
          <Button
            variant="outline"
            className="rounded-full"
            onClick={() => {
              setLoaded(false)
              setLoadFailed(false)
              setError("")
              setLoadAttempt((value) => value + 1)
            }}
          >
            重新读取 Skill
          </Button>
        </div>
      ) : creating ? (
        <div className="flex min-h-0 flex-1 flex-col" data-slot="skill-draft">
          <SkillDocument
            files={[{ path: "SKILL.md" }]}
            path="SKILL.md"
            source={newContent}
            active={active}
            editing
            busy={busy}
            dirty={newContent !== EMPTY_SKILL_CONTENT}
            saveLabel="保存 Skill"
            onEdit={() => {}}
            onSave={() => void create()}
            onUndo={() => {
              setNewContent(EMPTY_SKILL_CONTENT)
              setError("")
              onOpenSkill(null)
            }}
            onChange={setNewContent}
            onSelectFile={() => {}}
            onError={setError}
          />
        </div>
      ) : !skillId ? (
        <div className="min-h-0 flex-1 overflow-auto px-5 py-6 md:px-8">
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
            <div className="flex gap-1" role="group" aria-label="Skill 来源">
              {(["all", "local", "official"] as const).map((value) => (
                <Button
                  key={value}
                  variant="ghost"
                  size="sm"
                  className={cn(
                    "rounded-full px-4 text-muted-foreground",
                    filter === value && "bg-muted text-accent-foreground"
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
            <Input
              ref={searchInput}
              type="search"
              name="skill-search"
              autoComplete="off"
              className="w-full sm:w-64"
              classNames={{
                field: "h-9 pointer-coarse:h-11",
                input: "min-w-0 text-[13px]",
              }}
              leftIcon={<Search aria-hidden="true" />}
              aria-label="搜索 Skill"
              placeholder="搜索 Skill…"
              value={query}
              onChange={setQuery}
            />
          </div>
          <div className="skill-catalog-heading grid grid-cols-[minmax(0,1fr)_7rem_minmax(0,8rem)_3rem] gap-3 border-b border-border px-3 pb-3 text-[11px] text-muted-foreground">
            <span>名称</span>
            <span>来源</span>
            <span>版本</span>
            <span />
          </div>
          {visible.map((item) => (
            <div key={item.id} className="border-b border-border last:border-0">
              <div className="skill-catalog-row grid grid-cols-[minmax(0,1fr)_7rem_minmax(0,8rem)_3rem] items-center gap-3 rounded-lg px-3 py-4 transition-colors hover:bg-muted/50">
                <Button
                  variant="plain"
                  whileHover={undefined}
                  whileTap={undefined}
                  className="flex min-w-0 items-center justify-start gap-3 rounded-md rounded-md! text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
                      {item.description}
                    </span>
                  </span>
                </Button>
                <div className="skill-catalog-source">
                  <SkillSourceLabel skill={item} />
                </div>
                <span
                  className="skill-catalog-version min-w-0 truncate text-xs text-muted-foreground"
                  title={item.version || item.contentId}
                >
                  {item.version || item.contentId || "未标注版本"}
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
                {query || filter !== "all" ? "没有匹配的 Skill" : "暂无 Skill"}
              </h2>
            </div>
          ) : null}
        </div>
      ) : skill ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {library && !skill.readOnly ? (
            <PackageEntries
              key={`entries:${skill.id}`}
              skill={skill}
              busy={busy}
              onApply={async (action, path, destination) => {
                const affected = (key: string) =>
                  key === editKey(skill.id, path) ||
                  key.startsWith(`${editKey(skill.id, path)}/`)
                await mutateEntries(async () => {
                  if (
                    (action === "rename" || action === "remove") &&
                    Object.entries(currentEdits.current).some(
                      ([key, edit]) =>
                        affected(key) && edit.value !== edit.saved
                    )
                  )
                    throw new Error(
                      "目标包含未保存编辑，请先保存或撤销后重试。"
                    )
                  const result =
                    action === "mkdir"
                      ? await library.createDirectory(skill.id, destination)
                      : action === "file"
                        ? await library.writeFile(
                            skill.id,
                            destination,
                            new Blob([""])
                          )
                        : action === "rename"
                          ? await library.rename(skill.id, path, destination)
                          : await library.remove(skill.id, path)
                  if (mounted.current && action === "file")
                    setSelected((current) => ({
                      ...current,
                      [skill.id]: destination,
                    }))
                  if (
                    mounted.current &&
                    (action === "rename" || action === "remove")
                  ) {
                    setEdits((current) =>
                      Object.fromEntries(
                        Object.entries(current).filter(
                          ([key]) => !affected(key)
                        )
                      )
                    )
                    setSelected((current) => ({
                      ...current,
                      [skill.id]: action === "rename" ? destination : null,
                    }))
                  }
                  return result
                }, "文件目录已更新")
              }}
            />
          ) : null}
          {entry && library ? (
            <FilePreview
              key={skill.id}
              library={library}
              skill={skill}
              entry={entry}
              edit={edits[pathKey]}
              initialEditing={
                !!edits[pathKey] &&
                edits[pathKey].value !== edits[pathKey].saved
              }
              busy={busy}
              locked={entriesLocked}
              active={active}
              actions={detailActions}
              onAddFile={
                skill.readOnly
                  ? undefined
                  : (path, content, replace) =>
                      mutateEntries(
                        async () => {
                          const key = editKey(skill.id, path)
                          const edit = currentEdits.current[key]
                          if (replace && edit && edit.value !== edit.saved)
                            throw new Error(
                              "目标包含未保存编辑，请先保存或撤销后重试。"
                            )
                          const result = await library.writeFile(
                            skill.id,
                            path,
                            content,
                            { replace }
                          )
                          if (mounted.current)
                            setEdits((current) =>
                              Object.fromEntries(
                                Object.entries(current).filter(
                                  ([entryKey]) => entryKey !== key
                                )
                              )
                            )
                          return result
                        },
                        replace ? "文件已替换" : "文件已添加"
                      )
              }
              files={skill.entries
                .filter((item) => item.kind === "file")
                .map((item) => {
                  const edit = edits[editKey(skill.id, item.path)]
                  return {
                    path: item.path,
                    modified: !!edit && edit.value !== edit.saved,
                  }
                })}
              onOpenFile={(path) =>
                setSelected((current) => ({ ...current, [skill.id]: path }))
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
                  [pathKey]: {
                    value,
                    saved: current[pathKey]?.saved ?? value,
                  },
                }))
              }
              onSave={async (value) => {
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
              }}
            />
          ) : !library ? (
            <SkillScreen
              skills={sourceSkills}
              skillId={skill.id}
              active={active}
            />
          ) : (
            <p className="p-6 text-sm text-muted-foreground">
              这个 Skill 暂无可读内容。
            </p>
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
    </div>
  )
}
