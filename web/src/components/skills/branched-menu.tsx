// Adapted from React Bits BranchedMenu (reactbits.dev) — TypeScript port.
// Extended with a controlled `active` prop, per-item badges and an aria label.
"use client"

import {
  isValidElement,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react"
import { animate, useReducedMotion } from "motion/react"
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react"
import { SPRING_GLIDE } from "@/lib/ease"
import "./branched-menu.css"

export type BranchedMenuChild = {
  value: string
  label: string
  /** Additional heading levels below the first branch row. */
  depth?: number
  icon?: IconSvgElement | ReactNode
  badge?: ReactNode
}

export type BranchedMenuItem = {
  label: string
  value?: string
  icon?: IconSvgElement | ReactNode
  badge?: ReactNode
  children?: readonly BranchedMenuChild[]
}

export type BranchedMenuProps = {
  items: readonly BranchedMenuItem[]
  /** Controlled selected value. Leave undefined to manage selection internally. */
  active?: string
  defaultOpen?: number | readonly number[]
  defaultActive?: string
  /** Document headings navigate while their branches stay expanded. */
  collapsible?: boolean
  onSelect?: (value: string, item: BranchedMenuItem | BranchedMenuChild) => void
  onToggle?: (index: number, open: boolean) => void
  ariaLabel?: string
  color?: string
  accentColor?: string
  lineColor?: string
  width?: number
  rowHeight?: number
  indent?: number
  trunk?: number
  radius?: number
  lineWidth?: number
  fontSize?: number
  drawDuration?: number
  className?: string
}

const PAD = 6
const MARK = 16
const DEPTH_STEP = 12

const renderIcon = (icon: IconSvgElement | ReactNode) =>
  isValidElement(icon) ? (
    icon
  ) : (
    <HugeiconsIcon icon={icon as IconSvgElement} size={16} strokeWidth={1.7} />
  )

const toSet = (open: number | readonly number[]): ReadonlySet<number> =>
  new Set(typeof open === "number" ? (open >= 0 ? [open] : []) : open)

export function BranchedMenu({
  items,
  active: controlledActive,
  defaultOpen = 0,
  defaultActive = "",
  collapsible = true,
  onSelect,
  onToggle,
  ariaLabel,
  color = "#f5f5f5",
  accentColor = "#f5f5f5",
  lineColor = "#3f3f46",
  width = 240,
  rowHeight = 36,
  indent = 40,
  trunk = 14,
  radius = 10,
  lineWidth = 1.5,
  fontSize = 14,
  drawDuration = 400,
  className = "",
}: BranchedMenuProps) {
  const [open, setOpen] = useState<ReadonlySet<number>>(() =>
    toSet(defaultOpen)
  )
  const [internalActive, setInternalActive] = useState(() => {
    if (defaultActive) return defaultActive
    const first = items.find(
      (item, index) =>
        item.children && (!collapsible || toSet(defaultOpen).has(index))
    )
    return first?.children?.[0]?.value ?? ""
  })
  const active = controlledActive ?? internalActive
  const navRef = useRef<HTMLElement>(null)
  const heads = useRef<(HTMLButtonElement | null)[]>([])
  const markerRef = useRef<HTMLSpanElement>(null)

  const activeSection = items.findIndex((item) =>
    item.children?.some((kid) => kid.value === active)
  )
  const markerShown =
    activeSection >= 0 && (!collapsible || open.has(activeSection))
  useLayoutEffect(() => {
    const place = (glide: boolean) => {
      const marker = markerRef.current
      const head = heads.current[activeSection]
      if (!marker) return
      const on = markerShown && head
      if (!glide) marker.style.transition = "none"
      if (on && head)
        marker.style.top = `${head.offsetTop + (head.offsetHeight - MARK) / 2}px`
      marker.toggleAttribute("data-on", Boolean(on))
      if (!glide) {
        void marker.offsetHeight
        marker.style.transition = ""
      }
    }
    place(true)
    let first = true
    const observer = new ResizeObserver(() => {
      if (first) {
        first = false
        return
      }
      place(false)
    })
    if (navRef.current) observer.observe(navRef.current)
    return () => observer.disconnect()
  }, [activeSection, markerShown, items, fontSize, rowHeight])

  const folds = useRef<(HTMLDivElement | null)[]>([])
  const foldHeights = useRef<number[]>([])
  const firstFold = useRef(true)
  const reduceMotion = useReducedMotion()
  useLayoutEffect(() => {
    items.forEach((item, index) => {
      if (!item.children) return
      const fold = folds.current[index]
      if (!fold) return
      const target =
        !collapsible || open.has(index)
          ? PAD * 2 + item.children.length * rowHeight
          : 0
      if (firstFold.current || reduceMotion || !collapsible) {
        fold.style.height = `${target}px`
      } else if (foldHeights.current[index] !== target) {
        animate(fold, { height: target }, { ...SPRING_GLIDE })
      }
      foldHeights.current[index] = target
    })
    firstFold.current = false
  })

  const select = (
    value: string,
    item: BranchedMenuItem | BranchedMenuChild
  ) => {
    setInternalActive(value)
    onSelect?.(value, item)
  }
  const toggle = (index: number) => {
    const isOpen = !open.has(index)
    setOpen((previous) => {
      const next = new Set(previous)
      if (isOpen) next.add(index)
      else next.delete(index)
      return next
    })
    onToggle?.(index, isOpen)
  }

  const r = Math.min(radius, rowHeight / 2 - 2)
  const rowY = (k: number) => PAD + k * rowHeight + rowHeight / 2

  return (
    <nav
      ref={navRef}
      aria-label={ariaLabel}
      className={`branched-menu${className ? ` ${className}` : ""}`}
      style={
        {
          "--bm-w": `${width}px`,
          "--bm-ink": color,
          "--bm-accent": accentColor,
          "--bm-line": lineColor,
          "--bm-font": `${fontSize}px`,
          "--bm-row": `${rowHeight}px`,
          "--bm-indent": `${indent}px`,
          "--bm-line-w": lineWidth,
          "--bm-draw": `${drawDuration}ms`,
        } as CSSProperties
      }
    >
      <span
        ref={markerRef}
        className="branched-menu__marker"
        aria-hidden="true"
      />
      {items.map((item, index) => {
        const kids = item.children?.length ? item.children : undefined
        const isOpen = kids ? !collapsible || open.has(index) : false
        const leafValue = item.value ?? item.label
        const leafActive = (!kids || !collapsible) && leafValue === active
        const bodyHeight = kids ? PAD * 2 + kids.length * rowHeight : 0
        const ancestors: number[] = []
        const stems = new Map<
          number,
          { x: number; start: number; end: number }
        >()
        const branches = (kids ?? []).map((kid, k, siblings) => {
          const depth = kid.depth ?? 0
          while (
            ancestors.length &&
            (siblings[ancestors[ancestors.length - 1]].depth ?? 0) >= depth
          )
            ancestors.pop()
          const parent = ancestors.at(-1) ?? -1
          const x =
            trunk +
            (parent < 0 ? 0 : (siblings[parent].depth ?? 0) + 1) * DEPTH_STEP
          const start = parent < 0 ? 0 : rowY(parent)
          const y = rowY(k)
          const end = indent - 8 + depth * DEPTH_STEP
          const corner = `A ${r} ${r} 0 0 0 ${x + r} ${y} H ${end}`
          stems.set(parent, { x, start, end: y - r })
          ancestors.push(k)
          return {
            parent,
            branch: `M ${x} ${y - r} ${corner}`,
            reach: `M ${x} ${start} V ${y - r} ${corner}`,
          }
        })
        const activeBranches = new Set<number>()
        for (
          let k = kids?.findIndex((kid) => kid.value === active) ?? -1;
          k >= 0;
          k = branches[k].parent
        )
          activeBranches.add(k)
        return (
          <div
            key={item.value ?? item.label}
            className="branched-menu__section"
            data-open={isOpen ? "" : undefined}
          >
            <button
              ref={(element) => {
                heads.current[index] = element
              }}
              type="button"
              className="branched-menu__head"
              title={item.label}
              aria-expanded={kids && collapsible ? isOpen : undefined}
              aria-current={leafActive ? "true" : undefined}
              data-active={leafActive ? "" : undefined}
              onClick={() =>
                kids && collapsible ? toggle(index) : select(leafValue, item)
              }
            >
              {item.icon ? (
                <span className="branched-menu__icon" aria-hidden="true">
                  {renderIcon(item.icon)}
                </span>
              ) : null}
              <span className="branched-menu__label">{item.label}</span>
              {item.badge ? (
                <span className="branched-menu__badge">{item.badge}</span>
              ) : null}
            </button>
            {kids ? (
              <div className="branched-menu__body">
                <div
                  className="branched-menu__fold"
                  ref={(element) => {
                    folds.current[index] = element
                  }}
                >
                  <div
                    className="branched-menu__tree"
                    style={{ height: bodyHeight }}
                  >
                    <svg
                      className="branched-menu__lines"
                      width={
                        indent +
                        kids.reduce(
                          (max, kid) => Math.max(max, kid.depth ?? 0),
                          0
                        ) *
                          DEPTH_STEP
                      }
                      height={bodyHeight}
                      aria-hidden="true"
                    >
                      {[...stems].map(([parent, stem]) => (
                        <path
                          key={parent}
                          className="branched-menu__base"
                          d={`M ${stem.x} ${stem.start} V ${stem.end}`}
                        />
                      ))}
                      {kids.map((kid, k) => (
                        <path
                          key={kid.value}
                          className="branched-menu__base"
                          d={branches[k].branch}
                        />
                      ))}
                      {kids.map((kid, k) => (
                        <path
                          key={kid.value}
                          className="branched-menu__reach"
                          d={branches[k].reach}
                          pathLength={1}
                          style={{
                            strokeDasharray: 1,
                            strokeDashoffset: activeBranches.has(k) ? 0 : 1,
                          }}
                        />
                      ))}
                    </svg>
                    {kids.map((kid) => (
                      <button
                        key={kid.value}
                        type="button"
                        className="branched-menu__item"
                        title={kid.label}
                        style={
                          kid.depth
                            ? {
                                paddingInlineStart:
                                  indent + kid.depth * DEPTH_STEP,
                              }
                            : undefined
                        }
                        aria-current={kid.value === active ? "true" : undefined}
                        data-active={kid.value === active ? "" : undefined}
                        tabIndex={isOpen ? 0 : -1}
                        onClick={() => select(kid.value, kid)}
                      >
                        {kid.icon ? (
                          <span
                            className="branched-menu__icon"
                            aria-hidden="true"
                          >
                            {renderIcon(kid.icon)}
                          </span>
                        ) : null}
                        <span className="branched-menu__label">
                          {kid.label}
                        </span>
                        {kid.badge ? (
                          <span className="branched-menu__badge">
                            {kid.badge}
                          </span>
                        ) : null}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        )
      })}
    </nav>
  )
}
