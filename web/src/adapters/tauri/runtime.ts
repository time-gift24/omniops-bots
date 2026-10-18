import type { ChatEvent, ChatRequest } from "@/chat/dto"
import type { ChatGateway } from "@/chat/gateway"
import type {
  ApprovalDecision,
  BrowserViewport,
  DesktopRuntime,
  DesktopSnapshot,
} from "@/desktop/runtime"
import {
  object,
  readChatEvent,
  readDesktopSnapshot,
  readRpcError,
  string,
} from "./protocol"
import { safeHttpUrl, serializeRequest } from "./attachments"

/** The SDK boundary is injected so the same lifecycle is tested without a native window. */
export interface TauriBridge {
  invoke(command: string, args?: Record<string, unknown>): Promise<unknown>
  listen(
    event: string,
    handler: (payload: unknown) => void
  ): Promise<() => void>
}
export type RunContext = {
  workspacePath?: string
  agentId?: string
  instructions?: string
}
type PendingRun = {
  runId: string
  threadId: string
  events: ChatEvent[]
  wake?: () => void
  terminal: boolean
  stopping: boolean
  started: boolean
  start?: Promise<void>
}
const initialState: DesktopSnapshot = {
  simulated: false,
  task: null,
  browserRequest: 0,
  browser: {
    url: "",
    title: "",
    status: "empty",
    canGoBack: false,
    canGoForward: false,
  },
}
const failure = (
  message: string,
  kind:
    | "transport"
    | "invalid-request"
    | "aborted"
    | "invalid-response" = "transport"
): ChatEvent => ({ type: "failed", error: { kind, message } })

export function createTauriRuntime(bridge: TauriBridge) {
  let state = initialState
  let version = 0
  let disposed = false
  let connected = false
  let unavailable = false
  let unlisten: (() => void) | undefined
  let resolveContext: (
    threadId: string
  ) => Promise<RunContext> = async () => ({})
  const listeners = new Set<() => void>()
  const runs = new Map<string, PendingRun>()
  let pendingStop: { runId: string; confirmation?: Promise<void> } | undefined
  const request = (method: string, params: Record<string, unknown> = {}) =>
    bridge.invoke("runtime_request", { method, params })
  const publish = (next: DesktopSnapshot) => {
    state = next
    version++
    for (const listener of [...listeners]) listener()
  }
  const clearTask = (runId: string) => {
    if (state.task?.runId === runId) publish({ ...state, task: null })
  }
  const push = (run: PendingRun, event: ChatEvent) => {
    if (run.terminal) return
    run.events.push(event)
    if (event.type === "completed" || event.type === "failed") {
      run.terminal = true
      if (!run.stopping) clearTask(run.runId)
    }
    run.wake?.()
    run.wake = undefined
  }
  const disconnected = (message: string) => {
    connected = false
    unavailable = true
    pendingStop = undefined
    for (const run of runs.values()) push(run, failure(message))
    publish({
      ...state,
      task: null,
      browser: { ...state.browser, status: "error", error: message },
    })
  }
  const onEvent = (value: unknown) => {
    if (disposed || unavailable) return
    try {
      const event = object(value)
      if (event.event === "desktop_state") {
        const snapshot = readDesktopSnapshot(event.state)
        if (pendingStop && state.task?.runId === pendingStop.runId) {
          publish({ ...snapshot, task: { ...state.task, phase: "stopping" } })
          return
        }
        // A queued final state must not resurrect a run already settled locally.
        if (snapshot.task && runs.get(snapshot.task.runId)?.terminal) return
        const preparing = [...runs.values()].find(
          (run) => !run.started && !run.terminal
        )
        publish(
          !snapshot.task && preparing && state.task?.runId === preparing.runId
            ? { ...snapshot, task: state.task }
            : snapshot
        )
      } else if (event.event === "chat_event") {
        const run = runs.get(string(event.runId))
        if (run && run.threadId === event.threadId)
          push(run, readChatEvent(event.data))
      } else if (
        event.event === "runtime_exit" ||
        event.event === "runtime_error"
      )
        disconnected("桌面服务已断开，请重新打开应用。")
    } catch {
      disconnected("桌面服务返回了无效数据，请重新打开应用。")
    }
  }
  const stop = (runId: string): Promise<void> => {
    if (pendingStop?.runId === runId && pendingStop.confirmation)
      return pendingStop.confirmation
    const run = runs.get(runId)
    if (state.task?.runId !== runId)
      return Promise.reject(new Error("这个任务已结束。"))
    const owner = {
      runId,
      confirmation: undefined as Promise<void> | undefined,
    }
    pendingStop = owner
    if (run) run.stopping = true
    const previous = state.task
    publish({
      ...state,
      task: { ...previous, phase: "stopping", error: undefined },
    })
    const stopping = (async () => {
      if (run) await run.start
      // Even a terminal stream event cannot substitute for the stop acknowledgement.
      if (!run || run.started) await request("stop", { runId })
      if (pendingStop === owner) pendingStop = undefined
      if (run) {
        run.stopping = false
        if (!run.terminal) push(run, failure("任务已停止。", "aborted"))
        runs.delete(runId)
      }
      clearTask(runId)
    })().catch(() => {
      if (pendingStop === owner) pendingStop = undefined
      if (unavailable) {
        clearTask(runId)
        return
      }
      if (run) run.stopping = false
      if (state.task?.runId === runId)
        publish({
          ...state,
          task: {
            ...previous,
            ...(run?.terminal ? { phase: "running", approval: undefined } : {}),
            error: "停止未能完成，请重试。",
          },
        })
      throw new Error("停止未能完成，请重试。")
    })
    owner.confirmation = stopping
    return stopping
  }
  let navigating = false
  const navigate = async (method: string, params?: Record<string, unknown>) => {
    if (!connected) throw new Error("桌面服务未连接。")
    if (state.task || navigating)
      throw new Error("请等待当前任务或页面加载结束。")
    navigating = true
    try {
      await request(method, params)
    } catch {
      throw new Error("浏览器操作未能完成，请重试。")
    } finally {
      navigating = false
    }
  }
  let viewport: BrowserViewport | null = null
  let viewportKey = ""
  let viewportWrite: Promise<void> | undefined
  let viewportVersion = 0
  const setBrowserViewport = (
    bounds: BrowserViewport | null
  ): Promise<void> => {
    const key = JSON.stringify(bounds)
    if (key === viewportKey) return viewportWrite ?? Promise.resolve()
    viewportKey = key
    viewport = bounds
    viewportVersion++
    if (!viewportWrite) {
      let complete!: () => void
      let fail!: (error: Error) => void
      const completion = new Promise<void>((resolve, reject) => {
        complete = resolve
        fail = reject
      })
      viewportWrite = completion
      void (async () => {
        try {
          let sent = -1
          while (sent !== viewportVersion) {
            sent = viewportVersion
            const bounds = viewport
            await bridge.invoke("browser_set_bounds", {
              bounds: bounds
                ? { ...bounds, visible: true }
                : {
                    x: 0,
                    y: 0,
                    width: 0,
                    height: 0,
                    visible: false,
                    interactive: false,
                  },
            })
          }
          viewportWrite = undefined
          complete()
        } catch {
          viewportKey = ""
          viewportWrite = undefined
          fail(new Error("浏览器画面暂时无法显示，请重新打开右侧面板。"))
        }
      })()
      return completion
    }
    return viewportWrite
  }
  const desktop: DesktopRuntime = {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    setBrowserViewport,
    decide: async (decision: ApprovalDecision) => {
      const task = state.task
      if (
        !task ||
        task.runId !== decision.runId ||
        task.approval?.id !== decision.approvalId ||
        task.phase !== "awaiting-approval"
      )
        throw new Error("此操作已更新，请查看当前待批准操作。")
      publish({
        ...state,
        task: { ...task, phase: "submitting", error: undefined },
      })
      try {
        await request("decide", { ...decision })
      } catch {
        if (
          state.task?.runId === task.runId &&
          state.task.approval?.id === task.approval?.id &&
          state.task.phase === "submitting"
        )
          publish({ ...state, task })
        throw new Error("审批未能提交，内容已保留，请重试。")
      }
    },
    stop,
    navigate: (url) => navigate("navigate", { url: safeHttpUrl(url, true) }),
    back: () => navigate("back"),
    forward: () => navigate("forward"),
    reload: () => navigate("reload"),
  }
  const gatewayFor = (threadId: string): ChatGateway => {
    let currentRun: PendingRun | undefined
    return {
      async *stream(input: ChatRequest) {
        if (!connected || disposed) {
          yield failure("桌面服务未连接，请重新打开应用。")
          return
        }
        if (state.task || navigating) {
          yield failure(
            "其他会话有任务正在执行，请等待结束。",
            "invalid-request"
          )
          return
        }
        const run: PendingRun = {
          runId: crypto.randomUUID(),
          threadId,
          events: [],
          terminal: false,
          stopping: false,
          started: false,
        }
        runs.set(run.runId, run)
        currentRun = run
        publish({
          ...state,
          task: {
            runId: run.runId,
            threadId,
            title: input.messages.at(-1)?.text.slice(0, 80) ?? "正在执行任务",
            phase: "running",
          },
        })
        run.start = (async () => {
          let serialized, context
          try {
            serialized = await serializeRequest(input)
            context = await resolveContext(threadId)
          } catch (error) {
            push(
              run,
              failure(
                error instanceof Error ? error.message : "任务输入不可用。",
                "invalid-request"
              )
            )
            return
          }
          if (run.stopping || run.terminal || disposed) {
            push(run, failure("任务已停止。", "aborted"))
            return
          }
          try {
            const { instructions, ...scope } = context
            // The subscription and queue already exist before this command can emit.
            const ack = object(
              await request("chat_start", {
                runId: run.runId,
                threadId,
                ...scope,
                request: {
                  ...serialized,
                  instructions:
                    [instructions, input.instructions]
                      .filter(Boolean)
                      .join("\n\n") || undefined,
                },
              })
            )
            if (ack.runId !== run.runId)
              throw new Error("invalid acknowledgement")
            run.started = true
          } catch (error) {
            push(run, {
              type: "failed",
              error: readRpcError(error, "任务未能连接桌面服务，请重试。"),
            })
          }
        })()
        try {
          while (true) {
            if (!run.events.length && !run.terminal)
              await new Promise<void>((resolve) => {
                run.wake = resolve
              })
            const event = run.events.shift()
            if (event) yield event
            if (run.terminal && !run.events.length) return
          }
        } finally {
          if (!run.stopping) runs.delete(run.runId)
          if (currentRun === run && !run.stopping) currentRun = undefined
        }
      },
      abort: () => (currentRun ? stop(currentRun.runId) : Promise.resolve()),
    }
  }
  return {
    desktop,
    gatewayFor,
    request,
    setContextResolver(resolver: typeof resolveContext) {
      resolveContext = resolver
    },
    async initialize() {
      unlisten = await bridge.listen("runtime-event", onEvent)
      const before = version
      try {
        const snapshot = readDesktopSnapshot(await request("status"))
        if (unavailable) throw new Error("runtime unavailable")
        if (version === before) publish(snapshot)
        connected = true
      } catch {
        unlisten()
        unlisten = undefined
        throw new Error("桌面服务启动失败，请检查本地运行环境后重新打开应用。")
      }
    },
    dispose() {
      disposed = true
      unlisten?.()
      disconnected("桌面连接已关闭。")
      listeners.clear()
      void setBrowserViewport(null).catch(() => {})
    },
  }
}
