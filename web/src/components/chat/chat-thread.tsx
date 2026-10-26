"use client"
import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"
import { ArrowDown, Bot } from "lucide-react"
import { useAppDependencies } from "@/app/dependencies"
import { threadTask } from "@/desktop/runtime"
import type { ThreadStore } from "@/chat/thread-store"
import { useThreadState } from "@/chat/react"
import { providerModelLabel } from "@/providers/source"
import {
  TurnView,
  type ThreadActions,
} from "@/components/arc/blocks/ai-chat/chat-thread"
import type { Turn } from "@/components/arc/blocks/ai-chat/chat-state"
import type { ChatModel } from "@/components/arc/blocks/ai-chat/chat-data"
import { nextCut } from "@/components/arc/blocks/ai-chat/chat-reveal"
import { useReduced } from "@/components/arc/blocks/ai-chat/chat-parts"
import {
  ClaudeMark,
  OpenaiMark,
  GeminiColorMark,
} from "@/components/arc/blocks/ai-chat/ai-chat-marks"
import { toArcTurns } from "./arc-bridge"
import styles from "@/components/arc/blocks/ai-chat/chat.module.css"

const graphemes = new Intl.Segmenter("zh", { granularity: "grapheme" })
const ArcTurn = memo(function ArcTurn({
  turn,
  model,
  last,
  busy,
  reduced,
  actions,
}: {
  turn: Turn
  model: ChatModel
  last: boolean
  busy: boolean
  reduced: boolean
  actions: ThreadActions
}) {
  const reply = turn.versions[0].reply
  const [reveal, setReveal] = useState({
    id: reply.id,
    text: reply.text,
    shown: reply.text.length,
    marks: [] as number[],
  })
  const latest = useRef(reply),
    clock = useRef(0)
  useLayoutEffect(() => {
    latest.current = reply
  }, [reply])
  const running = reply.status === "streaming" && !reduced
  useEffect(() => {
    if (!running) return
    let frame = 0
    const tick = (now: number) => {
      frame = requestAnimationFrame(tick)
      if (now - clock.current < 34) return
      clock.current = now
      const target = latest.current
      setReveal((current) => {
        const from =
          current.id === target.id && target.text.startsWith(current.text)
            ? Math.min(current.shown, target.text.length)
            : 0
        if (from >= target.text.length) return current
        let cut = nextCut(
          target.text,
          from,
          target.text.length - from > 600 ? 4 : 3,
          false
        )
        if (
          cut === from &&
          /[^\p{ASCII}]/u.test(target.text.slice(from)) &&
          !/^\s*```/.test(target.text.slice(from))
        ) {
          const chars = [...graphemes.segment(target.text.slice(from))].slice(
            0,
            6
          )
          cut = from + chars.reduce((n, char) => n + char.segment.length, 0)
        }
        return cut > from
          ? {
              id: target.id,
              text: target.text,
              shown: cut,
              marks: [...(current.id === target.id ? current.marks : []), from],
            }
          : current
      })
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [running])
  const shown = running
    ? reveal.id === reply.id
      ? Math.min(reveal.shown, reply.text.length)
      : 0
    : reply.text.length
  const version = {
    ...turn.versions[0],
    reply: { ...reply, shown, marks: running ? reveal.marks : undefined },
  }
  return (
    <TurnView
      turn={turn}
      version={version}
      model={model}
      last={last}
      busy={busy}
      reduced={reduced}
      actions={actions}
    />
  )
})

/** Cognacta's Arc thread, reveal clock and scroll behavior consume the existing per-thread store. */
export function ChatThread({ store }: { store: ThreadStore }) {
  const { desktop } = useAppDependencies(),
    state = useThreadState(store),
    reduced = useReduced()
  const desktopBusy = useSyncExternalStore(
    desktop.subscribe,
    () => Boolean(threadTask(desktop.getState(), state.threadId)),
    () => false
  )
  const busy =
    state.status === "streaming" ||
    state.status === "submitted" ||
    state.status === "stopping"
  const modelId =
    state.metadata?.resolvedModel ??
    state.metadata?.requestedModel ??
    store.getDraft().model ??
    ""
  const model = useMemo<ChatModel>(
    () => ({
      id: modelId,
      name: providerModelLabel(modelId) || "Assistant",
      mark: /claude/i.test(modelId)
        ? ClaudeMark
        : /gemini/i.test(modelId)
          ? GeminiColorMark
          : /gpt|openai/i.test(modelId)
            ? OpenaiMark
            : Bot,
    }),
    [modelId]
  )
  const turns = useMemo(
    () => toArcTurns(state.messages, modelId, state.error?.message),
    [state.messages, modelId, state.error?.message]
  )
  const [announcement, announce] = useState("")
  const turnsRef = useRef(turns),
    stateRef = useRef({ busy: busy || desktopBusy, modelId })
  useLayoutEffect(() => {
    turnsRef.current = turns
    stateRef.current = { busy: busy || desktopBusy, modelId }
  }, [turns, busy, desktopBusy, modelId])
  const actions = useMemo<ThreadActions>(
    () => ({
      retry: (id) => {
        if (
          stateRef.current.busy ||
          threadTask(desktop.getState(), store.getState().threadId) ||
          store.appendOnly
        )
          return
        const reply = turnsRef.current.find((turn) => turn.id === id)
          ?.versions[0].reply
        if (reply) store.retry(reply.id)
      },
      retryInPlace: (id) => {
        if (
          stateRef.current.busy ||
          threadTask(desktop.getState(), store.getState().threadId) ||
          store.appendOnly
        )
          return
        const reply = turnsRef.current.find((turn) => turn.id === id)
          ?.versions[0].reply
        if (reply) store.retry(reply.id)
      },
      edit: (_id, text) => {
        if (
          stateRef.current.busy ||
          threadTask(desktop.getState(), store.getState().threadId)
        )
          return
        const accepted = store.send(text, undefined, stateRef.current.modelId)
        if (accepted) store.updateDraft({ text: "", attachments: [] })
      },
      select: () => {},
      feedback: () => {},
      canFeedback: false,
      canRetry: !store.appendOnly,
      copied: (ok) => announce(ok ? "已复制到剪贴板" : "复制失败，请重试"),
    }),
    [store, desktop]
  )
  const scroller = useRef<HTMLDivElement>(null),
    content = useRef<HTMLDivElement>(null),
    stuck = useRef(true),
    [jump, setJump] = useState(false)
  useEffect(() => {
    const node = scroller.current,
      body = content.current
    if (!node || !body) return
    let frame = 0
    const observer = new ResizeObserver(() => {
      if (!stuck.current) return
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        node.scrollTop = node.scrollHeight
      })
    })
    observer.observe(body)
    node.scrollTop = node.scrollHeight
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
    }
  }, [])
  return (
    <section
      className={styles.root}
      aria-label="对话"
      style={{ height: "100%", background: "transparent" }}
    >
      <div
        ref={scroller}
        data-slot="message-scroller-viewport"
        className="min-h-0 flex-1 [scrollbar-width:none] overflow-y-auto"
        tabIndex={0}
        onScroll={(event) => {
          const node = event.currentTarget
          stuck.current =
            node.scrollHeight - node.clientHeight - node.scrollTop < 40
          setJump(!stuck.current)
        }}
      >
        <div ref={content} className={styles.thread} aria-busy={busy}>
          {turns.map((turn, index) => (
            <ArcTurn
              key={turn.id}
              turn={turn}
              model={model}
              last={index === turns.length - 1}
              busy={busy || desktopBusy}
              reduced={reduced}
              actions={actions}
            />
          ))}
          {store.appendOnly && !busy ? (
            <p className="text-xs text-muted-foreground">
              需要重新尝试时，请发送一条新消息继续。
            </p>
          ) : null}
        </div>
      </div>
      {jump ? (
        <button
          type="button"
          aria-label="滚动到最新消息"
          className="bg-surface absolute right-4 bottom-4 rounded-full border border-border p-2"
          onClick={() => {
            const node = scroller.current
            if (node) {
              stuck.current = true
              node.scrollTo({
                top: node.scrollHeight,
                behavior: reduced ? "instant" : "smooth",
              })
              setJump(false)
            }
          }}
        >
          <ArrowDown size={16} />
        </button>
      ) : null}
      <span role="status" className="sr-only">
        {announcement}
      </span>
    </section>
  )
}
