import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react"
import { useAppDependencies } from "@/app/dependencies"
import type {
  HistoricalResource,
  Publication,
  PublicationPreview,
  ResourceKind,
  ResourceVersion,
} from "@/resources/publication"
import { Button } from "@/components/motion/button"
import type { DesktopConnection } from "@/desktop/runtime"

const fieldClass =
  "h-10 w-full min-w-0 rounded-lg border border-border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
const phases = {
  prepared: "已冻结本机内容，尚未上传",
  uploaded: "草稿修订已上传，尚未发布",
  published: "正式版本已发布",
}
const tagValid = (tag: string) => /^v\.\d+\.\d+\.\d+$/.test(tag)

type PanelProps = {
  onOpenResource?: (resource: HistoricalResource) => Promise<void> | void
}
/** An account change discards only this view; durable operations retain their owner. */
export function ResourcePublicationPanel(props: PanelProps) {
  const { desktop } = useAppDependencies()
  const snapshot = useSyncExternalStore(
    desktop.subscribe,
    desktop.getState,
    desktop.getState
  )
  return (
    <PublicationEditor
      key={JSON.stringify([
        snapshot.connection?.destination,
        snapshot.connection?.account,
      ])}
      {...props}
      connection={snapshot.connection}
    />
  )
}

/** Publishing always uses a persisted frozen operation, never current editor text. */
function PublicationEditor({
  onOpenResource,
  connection,
}: PanelProps & { connection?: DesktopConnection }) {
  const { publications: source, agents, skillLibrary } = useAppDependencies()
  const permitted =
    connection?.state === "connected" &&
    connection.permissions.includes("official-maintain")
  const [kind, setKind] = useState<ResourceKind>("skill")
  const [resources, setResources] = useState<
    readonly {
      kind: ResourceKind
      id: string
      name: string
      official: boolean
    }[]
  >([])
  const [localId, setLocalId] = useState("")
  const [officialId, setOfficialId] = useState("")
  const [createOfficial, setCreateOfficial] = useState(false)
  const [expectedRevision, setExpectedRevision] = useState("")
  const [operations, setOperations] = useState<readonly Publication[]>([])
  const [operation, setOperation] = useState<Publication | null>(null)
  const [preview, setPreview] = useState<PublicationPreview | null>(null)
  const [releaseTag, setReleaseTag] = useState("")
  const [agentTags, setAgentTags] = useState<Record<string, string>>({})
  const [submission, setSubmission] = useState<
    Parameters<NonNullable<typeof source>["publish"]>[0] | null
  >(null)
  const [versions, setVersions] = useState<readonly ResourceVersion[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [historyContentId, setHistoryContentId] = useState("")
  const [history, setHistory] = useState<HistoricalResource | null>(null)
  const [busy, setBusy] = useState("")
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const mounted = useRef(false),
    active = useRef(false)
  const id = useId()
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    if (!source || !permitted) return
    let live = true
    void Promise.all([
      agents.load(),
      skillLibrary?.list() ?? Promise.resolve([]),
      source.listOperations(),
    ]).then(
      ([loaded, skills, retained]) => {
        if (!live) return
        setResources(
          [
            ...loaded.agents.map((item) => ({
              kind: "agent" as const,
              id: item.id,
              name: item.configuration.name,
              official: item.source === "official",
            })),
            ...skills.map((item) => ({
              kind: "skill" as const,
              id: item.officialId ?? item.id,
              name: item.name,
              official: item.origin === "official",
            })),
          ].filter(
            (item, index, all) =>
              all.findIndex(
                (other) => other.kind === item.kind && other.id === item.id
              ) === index
          )
        )
        setOperations(retained.items)
      },
      () => {
        if (live) setError("资源或保留的发布操作读取失败，请重新打开此分区。")
      }
    )
    return () => {
      live = false
    }
  }, [agents, skillLibrary, source, permitted])
  async function run(label: string, action: () => Promise<void>) {
    if (active.current || !permitted || !source) return
    active.current = true
    setBusy(label)
    setError("")
    setNotice("")
    try {
      await action()
    } catch (cause) {
      if (mounted.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "操作失败，已保存的内容和原操作身份均保留。"
        )
    } finally {
      active.current = false
      if (mounted.current) setBusy("")
    }
  }
  function accept(value: Publication) {
    setOperation(value)
    setOperations((items) => [
      value,
      ...items.filter((item) => item.operationId !== value.operationId),
    ])
    setPreview(value.preview ?? null)
    if (value.publication) {
      setReleaseTag(value.publication.releaseTag)
      setAgentTags(
        Object.fromEntries(
          value.publication.affectedAgents.map((agent) => [
            agent.agentId,
            agent.releaseTag,
          ])
        )
      )
      setSubmission({ operationId: value.operationId, ...value.publication })
    }
  }
  function resetPublication() {
    setOperation(null)
    setPreview(null)
    setSubmission(null)
    setReleaseTag("")
    setAgentTags({})
    setNotice("")
    setError("")
  }
  async function freeze() {
    const value = await source!.prepare({
      kind,
      id: localId,
      ...(createOfficial
        ? { createOfficial: true }
        : officialId.trim()
          ? { officialId: officialId.trim() }
          : {}),
      ...(expectedRevision.trim()
        ? { expectedRevision: expectedRevision.trim() }
        : createOfficial
          ? { expectedRevision: null }
          : {}),
    })
    if (!mounted.current) return
    resetPublication()
    accept(value)
  }
  async function loadVersions(next?: string) {
    const value = await source!.versions({
      kind,
      id: officialId.trim(),
      ...(next ? { cursor: next } : {}),
    })
    if (!mounted.current) return
    setVersions((items) =>
      next
        ? [
            ...items,
            ...value.items.filter(
              (item) => !items.some((old) => old.contentId === item.contentId)
            ),
          ]
        : value.items
    )
    setCursor(value.nextCursor)
    if (!next) {
      setHistoryContentId("")
      setHistory(null)
    }
  }
  async function selectHistory(editable: boolean) {
    const value = await source!.selectHistory({
      kind,
      id: officialId.trim(),
      contentId: historyContentId,
      editable,
    })
    if (!mounted.current) return
    if (
      value.contentId !== historyContentId ||
      value.kind !== kind ||
      value.officialId !== officialId.trim()
    )
      throw new Error("返回的历史版本与所选内容不一致。")
    setHistory(value)
    if (editable && value.localId) {
      setNotice(`已创建独立本机工作副本：${value.localId}`)
      if (onOpenResource) await onOpenResource(value)
    }
  }
  const publishValid =
    tagValid(releaseTag) &&
    !!preview &&
    preview.affectedAgents.every((agent) =>
      tagValid(agentTags[agent.agentId] ?? "")
    )
  return (
    <section
      aria-label="资源发布"
      className="mx-auto w-full max-w-3xl space-y-8 px-5 py-7 sm:px-8 sm:py-10"
    >
      {!source ? (
        <p className="text-sm text-muted-foreground">
          当前接入不支持官方资源发布。
        </p>
      ) : !permitted ? (
        <p role="status" className="text-sm text-muted-foreground">
          连接平台并使用具备官方维护权限的账号后，可管理工作副本和发布。
        </p>
      ) : (
        <>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          {notice ? (
            <p role="status" className="text-sm">
              {notice}
            </p>
          ) : null}
          <div className="space-y-2">
            <label htmlFor={`${id}-kind`} className="block text-sm">
              资源类型
            </label>
            <select
              id={`${id}-kind`}
              className={fieldClass}
              value={kind}
              disabled={!!busy}
              onChange={(event) => {
                setKind(event.target.value as ResourceKind)
                setLocalId("")
                setOfficialId("")
                setVersions([])
                setHistory(null)
                resetPublication()
              }}
            >
              <option value="skill">Skill</option>
              <option value="agent">Agent</option>
            </select>
          </div>
          <section className="space-y-4" aria-labelledby={`${id}-history`}>
            <h2 id={`${id}-history`} className="text-base font-medium">
              官方版本与工作副本
            </h2>
            <label htmlFor={`${id}-official`} className="block text-sm">
              官方资源 ID
            </label>
            <input
              id={`${id}-official`}
              className={fieldClass}
              list={`${id}-officials`}
              maxLength={256}
              placeholder="已有工作副本绑定时可留空"
              value={officialId}
              disabled={!!busy}
              onChange={(event) => {
                setOfficialId(event.target.value)
                setVersions([])
                setHistoryContentId("")
                setHistory(null)
              }}
            />
            <datalist id={`${id}-officials`}>
              {resources
                .filter((item) => item.kind === kind && item.official)
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
            </datalist>
            <Button
              variant="outline"
              size="sm"
              disabled={!!busy || !officialId.trim()}
              onClick={() => void run("读取正式版本", () => loadVersions())}
            >
              读取正式版本
            </Button>
            {versions.length ? (
              <div className="space-y-3">
                <label htmlFor={`${id}-version`} className="block text-sm">
                  精确正式版本
                </label>
                <select
                  id={`${id}-version`}
                  className={fieldClass}
                  value={historyContentId}
                  disabled={!!busy}
                  onChange={(event) => {
                    setHistoryContentId(event.target.value)
                    setHistory(null)
                  }}
                >
                  <option value="">选择版本</option>
                  {versions.map((item) => (
                    <option key={item.contentId} value={item.contentId}>
                      {item.releaseTag ?? "无标签"} · {item.contentId}
                    </option>
                  ))}
                </select>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!!busy || !historyContentId}
                    onClick={() =>
                      void run("读取历史版本", () => selectHistory(false))
                    }
                  >
                    查看只读版本
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!!busy || !historyContentId}
                    onClick={() =>
                      void run("创建工作副本", () => selectHistory(true))
                    }
                  >
                    创建独立工作副本
                  </Button>
                  {cursor ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={!!busy}
                      onClick={() =>
                        void run("读取更多版本", () => loadVersions(cursor))
                      }
                    >
                      更多版本
                    </Button>
                  ) : null}
                </div>
              </div>
            ) : null}
            {history ? (
              <div className="space-y-2 text-sm">
                <p className="break-all">
                  {history.localId ? "本机工作副本" : "只读正式版本"} ·{" "}
                  {history.contentId}
                </p>
                {history.agent && !history.localId && onOpenResource ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!!busy}
                    onClick={() =>
                      void run("开始历史版本会话", async () => {
                        await onOpenResource(history)
                      })
                    }
                  >
                    使用此版本开始新会话
                  </Button>
                ) : null}
                {history.agent ? (
                  <pre
                    aria-label="历史 Agent 配置"
                    className="max-h-72 overflow-auto rounded-lg border border-border p-3 text-xs whitespace-pre-wrap"
                  >
                    {JSON.stringify(history.agent.configuration, null, 2)}
                  </pre>
                ) : history.skill ? (
                  <ul className="max-h-56 overflow-auto text-xs text-muted-foreground">
                    {history.skill.entries.map((entry) => (
                      <li key={entry.path} className="break-all">
                        {entry.path} · {entry.size} bytes
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
          </section>
          <section
            className="space-y-4 border-t border-border pt-7"
            aria-labelledby={`${id}-draft`}
          >
            <h2 id={`${id}-draft`} className="text-base font-medium">
              上传草稿与发布
            </h2>
            <p className="text-sm text-muted-foreground">
              先在编辑器保存本机内容。准备操作会冻结完整包，之后的编辑留待下一次修订。
            </p>
            <label htmlFor={`${id}-local`} className="block text-sm">
              已保存的本机资源
            </label>
            <select
              id={`${id}-local`}
              className={fieldClass}
              value={localId}
              disabled={!!busy}
              onChange={(event) => {
                setLocalId(event.target.value)
                resetPublication()
              }}
            >
              <option value="">选择本机资源</option>
              {resources
                .filter((item) => item.kind === kind && !item.official)
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name} · {item.id}
                  </option>
                ))}
            </select>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1 accent-primary"
                checked={createOfficial}
                disabled={!!busy}
                onChange={(event) => setCreateOfficial(event.target.checked)}
              />
              为此资源创建新的官方身份
            </label>
            <label htmlFor={`${id}-revision`} className="block text-sm">
              草稿基线 revision（留空读取当前草稿）
            </label>
            <input
              id={`${id}-revision`}
              className={fieldClass}
              maxLength={256}
              value={expectedRevision}
              disabled={!!busy}
              onChange={(event) => setExpectedRevision(event.target.value)}
            />
            <Button
              variant="outline"
              size="sm"
              disabled={!!busy || !localId}
              onClick={() => void run("冻结已保存内容", freeze)}
            >
              准备新的上传修订
            </Button>
            {operations.length ? (
              <div className="space-y-2">
                <label htmlFor={`${id}-retained`} className="block text-sm">
                  恢复已保留的发布操作
                </label>
                <select
                  id={`${id}-retained`}
                  className={fieldClass}
                  value={operation?.operationId ?? ""}
                  disabled={!!busy}
                  onChange={(event) => {
                    const value = operations.find(
                      (item) => item.operationId === event.target.value
                    )
                    if (!value) return
                    resetPublication()
                    setKind(value.kind)
                    setLocalId(value.localId)
                    setOfficialId(value.officialId ?? "")
                    accept(value)
                  }}
                >
                  <option value="">选择原操作继续</option>
                  {operations.map((item) => (
                    <option key={item.operationId} value={item.operationId}>
                      {item.kind} · {item.localId} · {phases[item.phase]} ·{" "}
                      {item.operationId}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
            {operation ? (
              <div className="space-y-4">
                <p role="status" className="text-sm">
                  {phases[operation.phase]}
                </p>
                <dl className="space-y-1 text-xs break-all text-muted-foreground">
                  <div>操作：{operation.operationId}</div>
                  <div>内容：{operation.contentId}</div>
                  {operation.officialId ? (
                    <div>官方身份：{operation.officialId}</div>
                  ) : null}
                  {operation.draftRevisionId ? (
                    <div>草稿修订：{operation.draftRevisionId}</div>
                  ) : null}
                </dl>
                <details>
                  <summary className="cursor-pointer text-sm">
                    冻结文件清单 · {operation.files.length} 项
                  </summary>
                  <ul className="mt-2 max-h-48 overflow-auto text-xs text-muted-foreground">
                    {operation.files.map((file) => (
                      <li key={file.path} className="break-all">
                        {file.path}
                        {file.kind === "folder"
                          ? "/"
                          : ` · ${file.bytes ?? 0} bytes`}
                      </li>
                    ))}
                  </ul>
                </details>
                {operation.phase === "prepared" ? (
                  <Button
                    size="sm"
                    disabled={!!busy}
                    onClick={() =>
                      void run("上传完整草稿", async () => {
                        const value = await source.uploadDraft(
                          operation.operationId
                        )
                        if (mounted.current) accept(value)
                      })
                    }
                  >
                    上传完整草稿／原键重试
                  </Button>
                ) : null}
                {operation.phase === "uploaded" ? (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!!busy || !!submission}
                      onClick={() =>
                        void run("预览原子发布", async () => {
                          const value = await source.preview(
                            operation.operationId
                          )
                          if (!mounted.current) return
                          if (
                            value.contentId !== operation.contentId ||
                            value.kind !== operation.kind
                          )
                            throw new Error("发布预览内容与冻结修订不一致。")
                          setPreview(value)
                        })
                      }
                    >
                      获取发布预览
                    </Button>
                    {preview ? (
                      <div className="space-y-3" aria-label="原子发布预览">
                        <p className="text-sm">
                          本次将一次发布 {1 + preview.affectedAgents.length}{" "}
                          个正式版本。
                          {preview.expectedContentId === null
                            ? "该资源尚无正式版本。"
                            : "将核对所选正式基线。"}
                        </p>
                        <p className="text-xs break-all text-muted-foreground">
                          基线：
                          {preview.baseline ??
                            preview.expectedContentId ??
                            "首次发布"}
                        </p>
                        <label htmlFor={`${id}-tag`} className="block text-sm">
                          {operation.kind === "skill" ? "Skill" : "Agent"}{" "}
                          新标签
                        </label>
                        <input
                          id={`${id}-tag`}
                          className={fieldClass}
                          placeholder="v.1.0.0"
                          maxLength={80}
                          value={releaseTag}
                          disabled={!!busy || !!submission}
                          onChange={(event) =>
                            setReleaseTag(event.target.value)
                          }
                        />
                        {preview.affectedAgents.map((agent) => (
                          <div key={agent.agentId} className="space-y-2">
                            <label
                              className="block text-sm"
                              htmlFor={`${id}-${agent.agentId}`}
                            >
                              受影响 Agent {agent.agentId} 新标签
                            </label>
                            <input
                              id={`${id}-${agent.agentId}`}
                              className={fieldClass}
                              placeholder="v.1.0.0"
                              maxLength={80}
                              value={agentTags[agent.agentId] ?? ""}
                              disabled={!!busy || !!submission}
                              onChange={(event) =>
                                setAgentTags((current) => ({
                                  ...current,
                                  [agent.agentId]: event.target.value,
                                }))
                              }
                            />
                            <p className="text-xs break-all text-muted-foreground">
                              原内容：{agent.expectedContentId}
                            </p>
                          </div>
                        ))}
                        <Button
                          size="sm"
                          disabled={!!busy || (!submission && !publishValid)}
                          onClick={() =>
                            void run("提交原子发布", async () => {
                              const request = submission ?? {
                                operationId: operation.operationId,
                                releaseTag,
                                affectedAgents: preview.affectedAgents.map(
                                  (agent) => ({
                                    ...agent,
                                    releaseTag: agentTags[agent.agentId],
                                  })
                                ),
                              }
                              setSubmission(request)
                              const value = await source.publish(request)
                              if (mounted.current) accept(value)
                            })
                          }
                        >
                          {submission
                            ? "使用原标签和原键重试发布"
                            : "确认标签并发布全部版本"}
                        </Button>
                        {submission ? (
                          <p className="text-xs text-muted-foreground">
                            提交身份与标签已固定。回执不明时继续原键重试；解决基线或标签冲突后，请准备新的修订。
                          </p>
                        ) : null}
                      </div>
                    ) : null}
                  </>
                ) : null}
                {operation.release ? (
                  <ul aria-label="正式发布回执" className="space-y-1 text-sm">
                    {operation.release.versions.map((version) => (
                      <li
                        key={`${version.kind}:${version.id}`}
                        className="break-all"
                      >
                        {version.kind} {version.id} · {version.releaseTag} ·{" "}
                        {version.contentId}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
          </section>
          {busy ? (
            <p role="status" className="text-sm text-muted-foreground">
              正在{busy}…
            </p>
          ) : null}
        </>
      )}
    </section>
  )
}
