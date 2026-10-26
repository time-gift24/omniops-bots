"use client"
import {
  useCallback,
  Fragment,
  createElement,
  createContext,
  isValidElement,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react"
import type { LucideIcon } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/arc/dialog/dialog"
import { SearchField } from "@/components/arc/search-field/search-field"
import { motionTokens } from "@/components/arc/motion-tokens"
import { motion, useReducedMotion } from "motion/react"
export type MorphicCommandItem = {
  id: string
  label: string
  description?: string
  group?: string
  icon?: LucideIcon | ReactElement
  keywords?: string[]
  hint?: string
  onSelect?: () => void
}
type Value = {
  open: boolean
  setOpen: (open: boolean) => void
  items: readonly MorphicCommandItem[]
  onSelect?: (item: MorphicCommandItem) => void
  fallback?: RefObject<HTMLElement | null>
}
const Context = createContext<Value | null>(null)
export function MorphicCommandPalette({
  items,
  children,
  open: controlled,
  defaultOpen = false,
  onOpenChange,
  onSelect,
  shortcut = "k",
  fallbackFocusRef,
}: {
  items: readonly MorphicCommandItem[]
  children: ReactNode
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  onSelect?: (item: MorphicCommandItem) => void
  shortcut?: string | false
  fallbackFocusRef?: RefObject<HTMLElement | null>
}) {
  const [internal, setInternal] = useState(defaultOpen),
    open = controlled ?? internal
  const setOpen = useCallback(
    (next: boolean) => {
      if (controlled === undefined) setInternal(next)
      onOpenChange?.(next)
    },
    [controlled, onOpenChange]
  )
  useEffect(() => {
    if (!shortcut) return
    const listener = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.repeat ||
        !(event.metaKey || event.ctrlKey) ||
        event.key.toLowerCase() !== shortcut
      )
        return
      if (document.querySelector('[aria-modal="true"]')) return
      event.preventDefault()
      setOpen(!open)
    }
    window.addEventListener("keydown", listener)
    return () => window.removeEventListener("keydown", listener)
  }, [shortcut, open, setOpen])
  return (
    <Context.Provider
      value={{ open, setOpen, items, onSelect, fallback: fallbackFocusRef }}
    >
      {children}
    </Context.Provider>
  )
}
export function MorphicCommandPaletteContent({
  title,
  description,
  placeholder,
  emptyMessage,
  clearLabel = "清空搜索",
  closeLabel = "关闭搜索",
}: {
  title: string
  description?: string
  placeholder?: string
  emptyMessage?: string
  clearLabel?: string
  closeLabel?: string
  footer?: boolean
}) {
  const context = useContext(Context)
  if (!context) throw new Error("Search content requires its palette")
  const { open, setOpen, items, onSelect, fallback } = context
  const [query, setQuery] = useState(""),
    [active, setActive] = useState(0)
  const input = useRef<HTMLInputElement>(null),
    origin = useRef<HTMLElement | null>(null),
    id = useId(),
    reduce = useReducedMotion()
  const search = query.trim().toLocaleLowerCase(),
    rows = items.filter((item) =>
      [item.label, item.group, item.description, ...(item.keywords ?? [])]
        .filter(Boolean)
        .join(" ")
        .toLocaleLowerCase()
        .includes(search)
    )
  function changeOpen(next: boolean) {
    setOpen(next)
    if (!next) {
      setQuery("")
      setActive(0)
    }
  }
  function select(item: MorphicCommandItem) {
    changeOpen(false)
    item.onSelect?.()
    onSelect?.(item)
  }
  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent
        unstyled
        data-slot="dialog-content"
        className="w-[calc(100vw-2rem)] max-w-xl p-0"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          const target = document.activeElement
          if (target instanceof HTMLElement) origin.current = target
          input.current?.focus()
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          const target = origin.current
          const visible =
            target?.isConnected &&
            !target.closest("[inert],[hidden]") &&
            target.getClientRects().length
          ;(visible ? target : fallback?.current)?.focus({
            preventScroll: true,
          })
        }}
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <DialogDescription className="sr-only">
          {description ?? title}
        </DialogDescription>
        <div
          data-slot="command"
          className="p-2"
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault()
              setActive((value) =>
                rows.length
                  ? (value +
                      (event.key === "ArrowDown" ? 1 : -1) +
                      rows.length) %
                    rows.length
                  : 0
              )
            } else if (event.key === "Enter" && rows[active]) {
              event.preventDefault()
              select(rows[active])
            }
          }}
        >
          <div className="flex items-center gap-2 border-b border-border px-2 pb-2">
            <SearchField
              ref={input}
              data-slot="command-input"
              role="combobox"
              aria-controls={`${id}-list`}
              aria-expanded={open}
              aria-activedescendant={
                rows[active] ? `${id}-${active}` : undefined
              }
              value={query}
              label={title}
              onValueChange={(value) => {
                setQuery(value)
                setActive(0)
              }}
              placeholder={placeholder}
              aria-label={title}
              className="min-w-0 flex-1"
            />
            <button
              type="button"
              aria-label={query ? clearLabel : closeLabel}
              onClick={() => (query ? setQuery("") : changeOpen(false))}
              className="rounded-lg px-2 py-1 text-xs text-muted-foreground"
            >
              {query ? "清空" : "Esc"}
            </button>
          </div>
          <div
            id={`${id}-list`}
            role="listbox"
            aria-label={title}
            className="max-h-[60dvh] overflow-auto py-1"
          >
            {rows.length ? (
              rows.map((item, index) => {
                const Icon = item.icon
                return (
                  <Fragment key={item.id}>
                    {item.group && rows[index - 1]?.group !== item.group ? (
                      <p
                        data-slot="command-group-heading"
                        className="px-3 pt-3 pb-1 text-xs text-muted-foreground"
                      >
                        {item.group}
                      </p>
                    ) : null}
                    <button
                      data-slot="command-item"
                      id={`${id}-${index}`}
                      role="option"
                      aria-selected={active === index}
                      onPointerMove={() => setActive(index)}
                      onClick={() => select(item)}
                      className="relative flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm outline-none"
                    >
                      {active === index ? (
                        <motion.span
                          layoutId={id}
                          className="absolute inset-0 rounded-lg bg-accent"
                          transition={
                            reduce
                              ? { duration: 0 }
                              : motionTokens.spring.snappy
                          }
                        />
                      ) : null}
                      <span className="relative flex w-full min-w-0 items-center gap-2">
                        {isValidElement(Icon)
                          ? Icon
                          : Icon
                            ? createElement(Icon as LucideIcon, { size: 16 })
                            : null}
                        <span className="min-w-0 flex-1 truncate">
                          {item.label}
                          {item.description ? (
                            <span className="block text-xs text-muted-foreground">
                              {item.description}
                            </span>
                          ) : null}
                        </span>
                      </span>
                    </button>
                  </Fragment>
                )
              })
            ) : (
              <p className="p-6 text-center text-sm text-muted-foreground">
                {emptyMessage}
              </p>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
