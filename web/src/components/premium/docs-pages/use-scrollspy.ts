// Adapted from @beui-pro/docs-article · beui.collectui.pro
"use client"

import { useEffect, useState, type RefObject } from "react"
import { findDocsHeading } from "./docs-data"

/**
 * Tracks which section heading is being read.
 *
 * The last heading above the reading line (30% of the viewport) wins. Short
 * final sections never reach the line, so reaching the page end selects the
 * last section. State syncs on mount so restored scroll positions are right.
 */
export function useScrollspy(
  ids: readonly string[],
  containerRef: RefObject<HTMLElement | null>
) {
  // A stable key keeps inline arrays from re-binding listeners every render.
  const key = ids.join("\u0000")
  const [active, setActive] = useState<string | undefined>(ids[0])

  useEffect(() => {
    const sectionIds = key ? key.split("\u0000") : []
    if (sectionIds.length === 0) return

    const container = containerRef.current
    if (!container) return

    const update = () => {
      const headings = sectionIds.map((id) => ({
        id,
        el: findDocsHeading(container, id),
      }))
      const line =
        container.getBoundingClientRect().top + container.clientHeight * 0.3
      let current = sectionIds[0]
      for (const heading of headings) {
        if (heading.el && heading.el.getBoundingClientRect().top <= line) {
          current = heading.id
        }
      }
      const atEnd =
        container.scrollHeight > container.clientHeight &&
        container.clientHeight + container.scrollTop >=
          container.scrollHeight - 2
      setActive(atEnd ? sectionIds[sectionIds.length - 1] : current)
    }

    container.addEventListener("scroll", update, { passive: true })
    const observer = new ResizeObserver(update)
    observer.observe(container)
    return () => {
      container.removeEventListener("scroll", update)
      observer.disconnect()
    }
  }, [key, containerRef])

  return active && ids.includes(active) ? active : ids[0]
}
