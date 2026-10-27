import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react"
import { useAppDependencies } from "@/app/dependencies"
import type {
  DesktopUpdate,
  DiagnosticPackage,
  DiagnosticThread,
  DiagnosticUploadState,
  DiagnosticFilePreview,
  SavedDiagnosticPackage,
} from "@/desktop/runtime"
import { Button } from "@/components/motion/button"

const connectionLabels = {
  offline: "离线",
  connecting: "正在连接",
  connected: "已连接",
  reconnecting: "重连中",
  blocked: "连接需要处理",
  closing: "正在关闭",
  closed: "已断开",
}
const updateLabels: Record<DesktopUpdate["phase"], string> = {
  disabled: "更新未配置",
  idle: "当前没有待安装更新",
  checking: "正在检查更新…",
  available: "有新版本可下载",
  downloading: "正在下载…",
  ready: "已验证，待安装",
  installing: "正在准备安装…",
  failed: "更新失败",
}
const message = (cause: unknown, fallback: string) =>
  cause instanceof Error ? cause.message : fallback
const bytes = (value: number) =>
  `${(value / 1024 / 1024).toLocaleString("zh-CN", { maximumFractionDigits: 1 })} MiB`

/** App-scoped maintenance uses only desktop interfaces. Preparing evidence never uploads it. */
export function ClientMaintenance() {
  const { desktop } = useAppDependencies()
  const snapshot = useSyncExternalStore(
    desktop.subscribe,
    desktop.getState,
    desktop.getState
  )
  const connection = snapshot.connection
  const [loadedUpdate, setUpdate] = useState<DesktopUpdate | null>(null)
  const update = snapshot.update ?? loadedUpdate
  const [threads, setThreads] = useState<readonly DiagnosticThread[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [threadId, setThreadId] = useState("")
  const [prepared, setPrepared] = useState<DiagnosticPackage | null>(null)
  const [packages, setPackages] = useState<readonly SavedDiagnosticPackage[]>(
    []
  )
  const [previewPath, setPreviewPath] = useState("")
  const [filePreview, setFilePreview] = useState<DiagnosticFilePreview | null>(
    null
  )
  const [selectedAttachments, setSelectedAttachments] = useState<string[]>([])
  const [includedAttachments, setIncludedAttachments] = useState<string[]>([])
  const [receipt, setReceipt] = useState<DiagnosticUploadState | null>(null)
  const [consent, setConsent] = useState(false)
  const [consentFor, setConsentFor] = useState("")
  const [busy, setBusy] = useState("")
  const [error, setError] = useState("")
  const active = useRef(false)
  const mounted = useRef(false)
  const id = useId()
  useEffect(() => {
    mounted.current = true
    let live = true
    const work = [
      desktop.readUpdate?.().then((value) => {
        if (live) setUpdate(value)
      }),
      desktop.listDiagnosticThreads?.().then((value) => {
        if (!live) return
        setThreads(value.items)
        setCursor(value.nextCursor)
      }),
      desktop.listDiagnosticPackages?.().then((value) => {
        if (live) setPackages(value)
      }),
    ].filter(Boolean)
    void Promise.allSettled(work).then((results) => {
      if (live && results.some((result) => result.status === "rejected"))
        setError("部分维护信息读取失败，可重新检查更新或刷新诊断列表。")
    })
    return () => {
      live = false
      mounted.current = false
    }
  }, [desktop])
  async function run(label: string, operation: () => Promise<void>) {
    if (active.current) return
    active.current = true
    setBusy(label)
    setError("")
    try {
      await operation()
    } catch (cause) {
      if (mounted.current)
        setError(message(cause, "操作未完成，材料已保留，请重试。"))
    } finally {
      active.current = false
      if (mounted.current) setBusy("")
    }
  }
  async function loadThreads(next?: string) {
    const value = await desktop.listDiagnosticThreads?.(
      next ? { cursor: next } : {}
    )
    if (!value || !mounted.current) return
    setThreads((current) =>
      next
        ? [
            ...current,
            ...value.items.filter(
              (item) => !current.some((old) => old.threadId === item.threadId)
            ),
          ]
        : value.items
    )
    setCursor(value.nextCursor)
  }
  async function prepare() {
    const value = await desktop.exportDiagnostics?.(
      threadId,
      selectedAttachments
    )
    if (!value || !mounted.current) return
    acceptPackage(value)
    setIncludedAttachments([...selectedAttachments])
    if (desktop.listDiagnosticPackages) {
      const saved = await desktop.listDiagnosticPackages()
      if (mounted.current) setPackages(saved)
    }
  }
  function acceptPackage(value: DiagnosticPackage) {
    setPrepared(value)
    setPreviewPath("")
    setFilePreview(null)
    setConsent(false)
    setConsentFor("")
    setReceipt(null)
  }
  async function openPackage(uploadId: string) {
    const value = await desktop.openDiagnosticPackage?.(uploadId)
    if (!value || !mounted.current) return
    if (value.uploadId !== uploadId)
      throw new Error("诊断包身份不一致，请刷新列表。")
    acceptPackage(value)
    setThreadId(value.threadId)
    setSelectedAttachments([])
    setIncludedAttachments([])
  }
  async function previewFile(path: string) {
    if (!prepared || !prepared.preview.files.some((file) => file.path === path))
      return
    const value = await desktop.previewDiagnosticFile?.(prepared.uploadId, path)
    if (!value || !mounted.current) return
    setPreviewPath(path)
    setFilePreview(value)
  }
  async function received(operation: () => Promise<DiagnosticUploadState>) {
    const value = await operation()
    if (!mounted.current || !prepared) return
    if (
      value.uploadId !== prepared.uploadId ||
      (value.state === "received" &&
        (value.threadId !== prepared.threadId ||
          value.bundleSha256 !== prepared.bundleSha256))
    )
      throw new Error("接收回执与本次材料不一致，请重新查询。")
    setReceipt(value)
  }
  const attachmentsChanged =
    JSON.stringify(selectedAttachments) !== JSON.stringify(includedAttachments)
  const receiver = JSON.stringify([
    connection?.destination ?? "",
    connection?.account ?? "",
    prepared?.uploadId ?? "",
    prepared?.bundleSha256 ?? "",
  ])
  const agreed = consent && consentFor === receiver
  const mayUpload =
    connection?.state === "connected" &&
    connection.permissions.includes("diagnostic-own")
  const tasks = snapshot.tasks ?? (snapshot.task ? [snapshot.task] : [])
  return (
    <section
      aria-label="连接与维护"
      className="mx-auto w-full max-w-3xl space-y-10 px-5 py-7 sm:px-8 sm:py-10"
    >
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <section aria-labelledby={`${id}-connection`} className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id={`${id}-connection`} className="text-base font-medium">
            平台连接
          </h2>
          <span role="status" className="text-sm">
            {snapshot.simulated
              ? "网页演示"
              : connectionLabels[connection?.state ?? "offline"]}
          </span>
        </div>
        {connection?.destination ? (
          <p className="text-sm break-all text-muted-foreground">
            {connection.destination}
          </p>
        ) : null}
        {connection?.account ? (
          <p className="text-sm text-muted-foreground">
            当前账号：{connection.account}
          </p>
        ) : null}
        {!snapshot.simulated && connection?.state !== "connected" ? (
          <p className="text-sm text-muted-foreground">
            请检查网络、登录和平台接入配置。本机已有材料仍会保留。
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          {desktop.reconnectPlatform ? (
            <Button
              variant="outline"
              size="sm"
              disabled={
                !!busy ||
                connection?.state === "connecting" ||
                connection?.state === "closing"
              }
              onClick={() =>
                void run("重新连接", () => desktop.reconnectPlatform!())
              }
            >
              重新连接
            </Button>
          ) : null}
          <span className="text-sm text-muted-foreground">
            {tasks.length
              ? `${tasks.length} 项任务正在本机执行`
              : "当前没有执行任务"}
          </span>
        </div>
      </section>
      <section
        aria-labelledby={`${id}-update`}
        className="space-y-4 border-t border-border pt-7"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id={`${id}-update`} className="text-base font-medium">
            客户端更新
          </h2>
          {update?.currentVersion ? (
            <span className="text-sm text-muted-foreground">
              当前版本 {update.currentVersion}
            </span>
          ) : null}
        </div>
        <p role="status" className="text-sm">
          {update
            ? updateLabels[update.phase]
            : desktop.readUpdate
              ? "正在读取更新状态…"
              : "当前接入不支持应用更新"}
          {update?.version ? ` · ${update.version}` : ""}
        </p>
        {update?.notes ? (
          <p className="text-sm leading-7 whitespace-pre-wrap">
            {update.notes}
          </p>
        ) : null}
        {update?.error ? (
          <p role="alert" className="text-sm text-destructive">
            {update.error}
          </p>
        ) : null}
        {update?.phase === "downloading" ? (
          <div className="space-y-2">
            <progress
              className="h-2 w-full accent-primary"
              value={update.totalBytes ? update.downloadedBytes : undefined}
              max={update.totalBytes}
              aria-label="更新下载进度"
            />
            <p className="text-xs text-muted-foreground tabular-nums">
              {bytes(update.downloadedBytes)}
              {update.totalBytes ? ` / ${bytes(update.totalBytes)}` : ""}
            </p>
          </div>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {desktop.checkUpdate ? (
            <Button
              variant="outline"
              size="sm"
              disabled={
                !!busy ||
                update?.phase === "disabled" ||
                update?.phase === "installing"
              }
              onClick={() =>
                void run("检查更新", async () => {
                  const value = await desktop.checkUpdate!()
                  if (mounted.current) setUpdate(value)
                })
              }
            >
              检查更新
            </Button>
          ) : null}
          {desktop.downloadUpdate && update?.phase === "available" ? (
            <Button
              size="sm"
              disabled={!!busy}
              onClick={() =>
                void run("下载更新", async () => {
                  const value = await desktop.downloadUpdate!()
                  if (mounted.current) setUpdate(value)
                })
              }
            >
              下载更新
            </Button>
          ) : null}
          {desktop.installUpdate && update?.phase === "ready" ? (
            <Button
              size="sm"
              disabled={!!busy}
              onClick={() =>
                void run("安装更新", async () => {
                  const value = await desktop.installUpdate!()
                  if (mounted.current) setUpdate(value)
                })
              }
            >
              确认安装并重启
            </Button>
          ) : null}
        </div>
      </section>
      <section
        aria-labelledby={`${id}-diagnostics`}
        className="space-y-4 border-t border-border pt-7"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id={`${id}-diagnostics`} className="text-base font-medium">
            会话诊断
          </h2>
          {desktop.listDiagnosticThreads ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={!!busy}
              onClick={() => void run("刷新诊断列表", () => loadThreads())}
            >
              刷新诊断列表
            </Button>
          ) : null}
        </div>
        {!desktop.exportDiagnostics ? (
          <p className="text-sm text-muted-foreground">
            当前接入不支持诊断导出。
          </p>
        ) : (
          <>
            <label htmlFor={`${id}-thread`} className="block text-sm">
              选择会话
            </label>
            <select
              id={`${id}-thread`}
              className="h-10 w-full min-w-0 rounded-lg border border-border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={threadId}
              disabled={!!busy}
              onChange={(event) => {
                setThreadId(event.target.value)
                setPrepared(null)
                setSelectedAttachments([])
                setIncludedAttachments([])
                setReceipt(null)
                setConsent(false)
              }}
            >
              <option value="">
                {threads.length ? "请选择需要排查的会话" : "暂无可导出的会话"}
              </option>
              {threads.map((thread) => (
                <option value={thread.threadId} key={thread.threadId}>
                  {thread.title} · {thread.threadId}
                </option>
              ))}
            </select>
            {cursor ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={!!busy}
                onClick={() =>
                  void run("读取更多会话", () => loadThreads(cursor))
                }
              >
                更多会话
              </Button>
            ) : null}
            <Button
              variant="outline"
              size="sm"
              disabled={!threadId || !!busy}
              onClick={() => void run("准备诊断材料", prepare)}
            >
              {prepared ? "重新准备材料" : "准备诊断材料"}
            </Button>
          </>
        )}
        {desktop.openDiagnosticPackage && packages.length ? (
          <div className="space-y-2">
            <label htmlFor={`${id}-saved-package`} className="block text-sm">
              已保留的诊断包
            </label>
            <select
              id={`${id}-saved-package`}
              aria-label="已保留的诊断包"
              className="h-10 w-full min-w-0 rounded-lg border border-border bg-background px-3 text-sm"
              value={
                packages.some((item) => item.uploadId === prepared?.uploadId)
                  ? prepared!.uploadId
                  : ""
              }
              disabled={!!busy}
              onChange={(event) => {
                if (event.target.value)
                  void run("打开诊断包", () => openPackage(event.target.value))
              }}
            >
              <option value="">选择之前导出的材料</option>
              {packages.map((item) => (
                <option value={item.uploadId} key={item.uploadId}>
                  {item.threadId} · {new Date(item.createdAt).toLocaleString()}{" "}
                  · {item.uploadId}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        {prepared ? (
          <div className="space-y-4">
            <p role="status" className="text-sm">
              材料已导出到本机，尚未上传。
            </p>
            <p className="text-xs break-all text-muted-foreground">
              {prepared.packageFile}
            </p>
            <details>
              <summary className="cursor-pointer text-sm font-medium">
                预览材料 · {prepared.preview.files.length} 个文件
              </summary>
              <ul className="mt-3 max-h-56 space-y-2 overflow-auto text-xs text-muted-foreground">
                {prepared.preview.files.map((file) => (
                  <li
                    key={file.path}
                    className="flex min-w-0 justify-between gap-4"
                  >
                    {desktop.previewDiagnosticFile ? (
                      <button
                        type="button"
                        className="text-left break-all underline underline-offset-4 hover:text-foreground disabled:opacity-50"
                        disabled={!!busy}
                        onClick={() =>
                          void run("预览文件", () => previewFile(file.path))
                        }
                      >
                        {file.path}
                      </button>
                    ) : (
                      <span className="break-all">{file.path}</span>
                    )}
                    <span className="shrink-0 tabular-nums">
                      {bytes(file.bytes)}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
            {filePreview ? (
              <section aria-label="诊断文件内容" className="space-y-2">
                <p className="text-xs break-all text-muted-foreground">
                  {previewPath}
                </p>
                {filePreview.mediaType === "text/plain" ? (
                  <pre className="max-h-96 overflow-auto rounded-lg border border-border bg-muted/30 p-3 text-xs break-words whitespace-pre-wrap">
                    {filePreview.text}
                  </pre>
                ) : (
                  <img
                    src={filePreview.dataUrl}
                    alt={`诊断附件 ${previewPath}`}
                    className="max-h-96 max-w-full rounded-lg border border-border object-contain"
                  />
                )}
                {filePreview.truncated ? (
                  <p className="text-xs text-muted-foreground">
                    内容超过预览上限，仅显示前一部分。
                  </p>
                ) : null}
              </section>
            ) : desktop.previewDiagnosticFile &&
              prepared.preview.files.length ? (
              <p className="text-xs text-muted-foreground">
                展开材料列表并选择文件，检查脱敏正文和实际附件后确认上传。
              </p>
            ) : null}
            <p className="text-xs text-muted-foreground">
              脱敏策略：{prepared.preview.redactionPolicy}
            </p>
            {prepared.preview.missing.length ? (
              <div
                role="status"
                className="space-y-2 text-sm text-muted-foreground"
              >
                <p>材料不完整</p>
                <ul className="list-inside list-disc">
                  {prepared.preview.missing.map((item, index) => (
                    <li key={`${item.item}:${index}`} className="break-all">
                      {item.item}：{item.reason}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {prepared.preview.attachments.length ? (
              <fieldset className="space-y-2">
                <legend className="mb-2 text-sm font-medium">可选附件</legend>
                {prepared.preview.attachments.map((file) => (
                  <label
                    key={file.id}
                    className="flex items-center gap-2 text-sm"
                  >
                    <input
                      type="checkbox"
                      disabled={!!busy}
                      checked={selectedAttachments.includes(file.id)}
                      onChange={(event) => {
                        setSelectedAttachments((current) =>
                          event.target.checked
                            ? [...current, file.id]
                            : current.filter((id) => id !== file.id)
                        )
                        setConsent(false)
                      }}
                    />
                    {file.name}
                  </label>
                ))}
                {attachmentsChanged ? (
                  <p className="text-xs text-muted-foreground">
                    附件选择已改变，请重新准备材料后预览。
                  </p>
                ) : null}
              </fieldset>
            ) : null}
            <p className="text-sm">
              接收服务：{connection?.destination ?? "未取得接收服务"}
              <br />
              账号：{connection?.account ?? "未取得接收账号"}
            </p>
            <label className="flex items-start gap-2 text-sm leading-6">
              <input
                className="mt-1 accent-primary"
                type="checkbox"
                checked={agreed}
                disabled={
                  !!busy ||
                  attachmentsChanged ||
                  (!!desktop.previewDiagnosticFile &&
                    !!prepared.preview.files.length &&
                    !filePreview)
                }
                onChange={(event) => {
                  setConsent(event.target.checked)
                  setConsentFor(event.target.checked ? receiver : "")
                }}
              />
              我已预览所选材料，同意将该会话诊断上传到上述服务。
            </label>
            <div className="flex flex-wrap gap-2">
              {desktop.uploadDiagnostics ? (
                <Button
                  size="sm"
                  disabled={
                    !!busy ||
                    !agreed ||
                    !mayUpload ||
                    attachmentsChanged ||
                    !connection?.destination ||
                    !connection?.account ||
                    receipt?.state === "received"
                  }
                  onClick={() =>
                    void run("上传诊断", () =>
                      received(() =>
                        desktop.uploadDiagnostics!(prepared.uploadId, true)
                      )
                    )
                  }
                >
                  上传诊断
                </Button>
              ) : null}
              {desktop.diagnosticUploadStatus &&
              receipt?.state !== "received" ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!!busy}
                  onClick={() =>
                    void run("查询接收状态", () =>
                      received(() =>
                        desktop.diagnosticUploadStatus!(prepared.uploadId)
                      )
                    )
                  }
                >
                  查询接收状态
                </Button>
              ) : null}
            </div>
            {receipt ? (
              <p role="status" className="text-sm">
                {receipt.state === "received"
                  ? `服务端已接收${receipt.incomplete ? "，材料不完整" : ""} · ${receipt.diagnosticId}`
                  : receipt.state === "pending"
                    ? "接收待确认"
                    : "上传失败，原材料仍保留"}
              </p>
            ) : null}
          </div>
        ) : null}
      </section>
      {busy ? (
        <p role="status" className="text-sm text-muted-foreground">
          正在{busy}…
        </p>
      ) : null}
    </section>
  )
}
