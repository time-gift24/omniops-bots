import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react"
import {
  BookOpen,
  ChevronRight,
  Copy,
  Download,
  FileText,
  Save,
  FolderOpen,
  LockKeyhole,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react"
import { useAppDependencies } from "@/app/dependencies"
import { Button } from "@/components/motion/button"
import { Input } from "@/components/motion/input"
import { useSaveShortcut } from "@/hooks/use-save-shortcut"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  BookOpen01Icon,
  Bug01Icon,
  Download01Icon,
  ListViewIcon,
} from "@hugeicons-pro/core-stroke-rounded"
import { SkillDocument } from "./skill-document"
import { FileManager } from "@/components/premium/file-manager/file-manager"
import {
  SkillLibraryError,
  skillFileMimeType,
  type ManagedSkill,
  type SkillEntry,
  type SkillLibrary,
} from "@/skills/library"
import { cn } from "@/lib/utils"
import "./skill-library.css"

type Edit = { value: string; saved: string }
type UploadResult = {
  id: number
  path: string
  file: File
  status: "saved" | "conflict" | "failed" | "skipped"
  message: string
}
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
  files,
  onEdit,
  onLoaded,
  busy,
  onSave,
  onOpenFile,
  active,
  actions,
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
  const [editingPath, setEditingPath] = useState<string | null>(null)
  const editing = editingPath === entry.path
  const isText = textFile(entry)
  const loadCallback = useRef(onLoaded)
  const currentSource = useRef("")
  const currentPath = useRef(entry.path)
  const mounted = useRef(false)
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
  }, [onLoaded, source, entry.path])
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
        actions={
          <>
            <Button
              variant="ghost"
              size="icon-sm"
              className="rounded-full"
              aria-label="下载文件"
              title="下载文件"
              onClick={() => void download()}
            >
              <HugeiconsIcon
                icon={Download01Icon}
                size={16}
                aria-hidden="true"
              />
            </Button>
            {actions}
          </>
        }
        loading={!ready && !readFailure}
        busy={busy}
        dirty={dirty}
        readOnly={skill.readOnly || !isText || (!ready && !!readFailure)}
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
}: {
  skillId: string | null
  onOpenSkill: (id: string | null) => void
  onCatalogChange?: (skills: readonly ManagedSkill[]) => void
  onExperiment?: (skillId: string) => void
  active?: boolean
}) {
  const { skillLibrary: library, skills: source } = useAppDependencies()
  const [catalog, setCatalog] = useState<readonly ManagedSkill[]>([])
  const [loaded, setLoaded] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [busy, setBusy] = useState(false)
  const operation = useRef(false)
  const mounted = useRef(false)
  const scope = useRef(skillId)
  const currentActive = useRef(active)
  const callback = useRef(onCatalogChange)
  const [query, setQuery] = useState("")
  const [filter, setFilter] = useState<"all" | "local" | "official">("all")
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState("")
  const [newDescription, setNewDescription] = useState("")
  const nameInput = useRef<HTMLInputElement>(null)
  const createButton = useRef<HTMLButtonElement>(null)
  const createFormId = useId()
  const [deleting, setDeleting] = useState<string | null>(null)
  const [selected, setSelected] = useState<Record<string, string | null>>({})
  const [listViews, setListViews] = useState<Record<string, boolean>>({})
  const [edits, setEdits] = useState<Record<string, Edit>>({})
  const [uploads, setUploads] = useState<Record<string, UploadResult[]>>({})
  const currentEdits = useRef(edits)
  const serial = useRef(0)
  useEffect(() => {
    if (creating && active && window.matchMedia("(pointer: fine)").matches)
      nameInput.current?.focus()
  }, [creating, active])
  useLayoutEffect(() => {
    scope.current = skillId
    currentActive.current = active
    callback.current = onCatalogChange
    currentEdits.current = edits
  }, [skillId, active, onCatalogChange, edits])
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
    (creating && !!(newName || newDescription))
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
  const listView = !!skillId && (listViews[skillId] ?? false)
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
          if (scope.current === null && currentActive.current)
            onOpenSkill(created.id)
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
          setUploads((current) => ({ ...current, [item.id]: [] }))
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
  async function uploadFiles(files: File[], folder: string) {
    if (!library || !skill) return
    const id = skill.id
    try {
      await run(async () => {
        setUploads((current) => ({
          ...current,
          [id]: (current[id] ?? []).filter(
            (item) => item.status === "conflict" || item.status === "failed"
          ),
        }))
        for (const file of files) {
          const path = folder ? `${folder}/${file.name}` : file.name
          let result: UploadResult
          try {
            update(await library.writeFile(id, path, file))
            result = {
              id: ++serial.current,
              path,
              file,
              status: "saved",
              message: "已保存",
            }
          } catch (cause) {
            result = {
              id: ++serial.current,
              path,
              file,
              status:
                cause instanceof SkillLibraryError && cause.code === "conflict"
                  ? "conflict"
                  : "failed",
              message: errorMessage(cause),
            }
          }
          if (mounted.current)
            setUploads((current) => ({
              ...current,
              [id]: [...(current[id] ?? []), result],
            }))
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
    if (!skill || skill.readOnly || !onExperiment || !library) return
    const main = skill.entries.find(
      (item) => item.kind === "file" && item.path === "SKILL.md"
    )
    if (!main) {
      setError("请先新建或上传 SKILL.md，再开始实验。")
      setListViews((current) => ({ ...current, [skill.id]: true }))
      return
    }
    const mainEdit = currentEdits.current[editKey(skill.id, "SKILL.md")]
    if ((mainEdit ? new Blob([mainEdit.value]).size : main.size) > 256 * 1024) {
      setError(
        "SKILL.md 不能超过 256 KiB，请精简入口并将参考资料拆分为独立文件。"
      )
      setSelected((current) => ({ ...current, [skill.id]: "SKILL.md" }))
      setListViews((current) => ({ ...current, [skill.id]: false }))
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
      <Button
        variant="ghost"
        size="icon"
        className="size-7 text-muted-foreground/70 hover:text-foreground"
        aria-label={listView ? "阅读视图" : "列表查看"}
        title={listView ? "阅读视图" : "列表查看"}
        aria-pressed={listView}
        onClick={() =>
          setListViews((current) => ({ ...current, [skill.id]: !listView }))
        }
      >
        <HugeiconsIcon
          icon={listView ? BookOpen01Icon : ListViewIcon}
          size={16}
          aria-hidden="true"
        />
      </Button>
    </>
  ) : null
  return (
    <div
      className="skill-library relative flex h-full min-h-0 flex-col bg-background"
      data-testid="skill-library"
    >
      {!skillId ? <h1 className="sr-only">Skill</h1> : null}
      {!skillId && active ? (
        <div
          role="group"
          aria-label="页面操作"
          data-slot="page-actions"
          className="absolute top-3 right-3 z-20 flex flex-col items-center gap-1"
        >
          {creating ? (
            <Button
              variant="ghost"
              size="icon"
              className="size-7 text-muted-foreground/70 hover:text-foreground"
              aria-label="取消新建 Skill"
              title="取消新建 Skill"
              disabled={busy}
              onClick={() => {
                setCreating(false)
                createButton.current?.focus()
              }}
            >
              <X aria-hidden="true" />
            </Button>
          ) : null}
          <Button
            ref={createButton}
            variant="ghost"
            size="icon"
            className="size-7 text-muted-foreground/70 hover:text-foreground"
            aria-label={creating ? "创建 Skill" : "新建 Skill"}
            title={creating ? "创建 Skill" : "新建 Skill"}
            type={creating ? "submit" : "button"}
            form={creating ? createFormId : undefined}
            disabled={busy || !library || !loaded || loadFailed}
            aria-expanded={creating}
            onClick={creating ? undefined : () => setCreating(true)}
          >
            {creating ? (
              <Save aria-hidden="true" />
            ) : (
              <Plus aria-hidden="true" />
            )}
          </Button>
        </div>
      ) : null}
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
      ) : !skillId ? (
        <div className="min-h-0 flex-1 overflow-auto py-6 pr-14 pl-5 md:pl-8">
          {creating ? (
            <form
              id={createFormId}
              className="mb-6 rounded-xl border border-border bg-muted/30 p-5"
              onKeyDown={(event) => {
                if (event.key === "Escape" && !busy) {
                  event.preventDefault()
                  setCreating(false)
                  createButton.current?.focus()
                }
              }}
              onSubmit={(event) => {
                event.preventDefault()
                void create()
              }}
            >
              <div className="flex items-center justify-between gap-4">
                <h2 className="text-sm font-medium">新建本地 Skill</h2>
              </div>
              <div className="mt-4 grid gap-4 md:grid-cols-2">
                <Input
                  ref={nameInput}
                  label="名称"
                  name="skill-name"
                  autoComplete="off"
                  classNames={{
                    label: "text-xs",
                    field: "h-9 bg-background",
                    input: "text-[13px] font-normal",
                  }}
                  value={newName}
                  onChange={setNewName}
                  placeholder="例如：生产环境巡检"
                  maxLength={100}
                  disabled={busy}
                  pattern={".*\\S.*"}
                  required
                />
                <Input
                  label="说明"
                  name="skill-description"
                  autoComplete="off"
                  classNames={{
                    label: "text-xs",
                    field: "h-9 bg-background",
                    input: "text-[13px] font-normal",
                  }}
                  value={newDescription}
                  onChange={setNewDescription}
                  placeholder="这个 Skill 解决什么问题"
                  maxLength={4096}
                  disabled={busy}
                  pattern={".*\\S.*"}
                  required
                />
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
            <Input
              type="search"
              name="skill-search"
              autoComplete="off"
              className="w-full sm:w-64"
              classNames={{ field: "h-9", input: "min-w-0 text-[13px]" }}
              leftIcon={<Search aria-hidden="true" />}
              aria-label="搜索 Skill"
              placeholder="搜索 Skill…"
              value={query}
              onChange={setQuery}
            />
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
            </div>
          ) : null}
        </div>
      ) : skill ? (
        <div className="min-h-0 flex-1 overflow-hidden">
          {entry && library ? (
            <div className={listView ? "hidden" : "h-full"}>
              <FilePreview
                key={skill.id}
                library={library}
                skill={skill}
                entry={entry}
                edit={edits[pathKey]}
                busy={busy}
                active={active && !listView}
                actions={detailActions}
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
            </div>
          ) : null}
          <div
            className={
              listView || !entry || !library
                ? "flex h-full min-h-0 flex-col"
                : "hidden"
            }
          >
            <FileManager
              key={skill.id}
              actions={active ? detailActions : null}
              entries={skill.entries}
              disabled={busy || !library}
              readOnly={skill.readOnly}
              onOpenFile={(path) => {
                setSelected((current) => ({ ...current, [skill.id]: path }))
                setListViews((current) => ({ ...current, [skill.id]: false }))
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
              onCreateFile={async (path) => {
                if (!library) throw new Error("文件存储尚未连接")
                await mutate(
                  () =>
                    library.writeFile(
                      skill.id,
                      path,
                      new Blob([""], { type: skillFileMimeType(path) })
                    ),
                  "文件已创建"
                )
                if (mounted.current && scope.current === skill.id) {
                  setSelected((current) => ({ ...current, [skill.id]: path }))
                  setListViews((current) => ({ ...current, [skill.id]: false }))
                }
              }}
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
                if (!mounted.current) return
                setSelected((current) => {
                  const previous = current[skill.id] ?? selectedPath
                  return previous &&
                    (previous === path || previous.startsWith(`${path}/`))
                    ? {
                        ...current,
                        [skill.id]: `${next}${previous.slice(path.length)}`,
                      }
                    : current
                })
                setEdits((current) =>
                  Object.fromEntries(
                    Object.entries(current).filter(
                      ([key]) => !includesEdit(key, skill.id, path)
                    )
                  )
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
                      role="status"
                      className={cn(
                        "max-w-64",
                        result.status === "saved"
                          ? "text-primary"
                          : "text-muted-foreground"
                      )}
                    >
                      {result.status === "conflict"
                        ? skill.entries.some(
                            (item) =>
                              item.kind === "file" && item.path === result.path
                          )
                          ? "同名文件已存在"
                          : "名称冲突，请修改名称后重新上传"
                        : result.message}
                    </span>
                    {result.status === "conflict" ? (
                      <div className="flex gap-1">
                        {skill.entries.some(
                          (item) =>
                            item.kind === "file" && item.path === result.path
                        ) ? (
                          <Button
                            size="xs"
                            variant="outline"
                            className="rounded-full"
                            disabled={busy}
                            onClick={() => void saveUploadedFile(result, true)}
                          >
                            替换
                          </Button>
                        ) : null}
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
