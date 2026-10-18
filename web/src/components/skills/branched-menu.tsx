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
  icon?: IconSvgElement | ReactNode
  badge?: ReactNode
}

export type BranchedMenuItem = {
  label: string
  value?: string
  /** Indentation depth for flat document outlines; does not add folding. */
  depth?: number
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
      (item, index) => item.children && toSet(defaultOpen).has(index)
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
  const markerShown = activeSection >= 0 && open.has(activeSection)
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
      const target = open.has(index)
        ? PAD * 2 + item.children.length * rowHeight
        : 0
      if (firstFold.current || reduceMotion) {
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
  const endX = indent - 8
  const rowY = (k: number) => PAD + k * rowHeight + rowHeight / 2
  const branch = (k: number) =>
    `M ${trunk} ${rowY(k) - r} A ${r} ${r} 0 0 0 ${trunk + r} ${rowY(k)} H ${endX}`
  const reach = (k: number) =>
    `M ${trunk} 0 V ${rowY(k) - r} A ${r} ${r} 0 0 0 ${trunk + r} ${rowY(k)} H ${endX}`
  const length = (k: number) =>
    rowY(k) - r + (Math.PI * r) / 2 + (endX - trunk - r)

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
        const kids = item.children
        const isOpen = kids ? open.has(index) : false
        const leafValue = item.value ?? item.label
        const leafActive = !kids && leafValue === active
        const bodyHeight = kids ? PAD * 2 + kids.length * rowHeight : 0
        return (
          <div
            key={item.value ?? item.label}
            className="branched-menu__section"
            style={
              item.depth ? { marginInlineStart: item.depth * 12 } : undefined
            }
            data-open={isOpen ? "" : undefined}
          >
            <button
              ref={(element) => {
                heads.current[index] = element
              }}
              type="button"
              className="branched-menu__head"
              aria-expanded={kids ? isOpen : undefined}
              aria-current={leafActive ? "true" : undefined}
              data-active={leafActive ? "" : undefined}
              onClick={() => (kids ? toggle(index) : select(leafValue, item))}
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
                      width={indent}
                      height={bodyHeight}
                      aria-hidden="true"
                    >
                      <path
                        className="branched-menu__base"
                        d={`M ${trunk} 0 V ${rowY(kids.length - 1) - r}`}
                      />
                      {kids.map((kid, k) => (
                        <path
                          key={kid.value}
                          className="branched-menu__base"
                          d={branch(k)}
                        />
                      ))}
                      {kids.map((kid, k) => (
                        <path
                          key={kid.value}
                          className="branched-menu__reach"
                          d={reach(k)}
                          style={{
                            strokeDasharray: length(k),
                            strokeDashoffset:
                              kid.value === active ? 0 : length(k),
                          }}
                        />
                      ))}
                    </svg>
                    {kids.map((kid) => (
                      <button
                        key={kid.value}
                        type="button"
                        className="branched-menu__item"
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
