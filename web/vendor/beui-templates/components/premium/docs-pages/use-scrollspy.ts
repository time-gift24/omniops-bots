"use client";

import { useEffect, useState } from "react";
import { docsSectionId } from "./docs-data";

/**
 * Tracks which section heading is being read.
 *
 * The last heading above the reading line (30% of the viewport) wins. Short
 * final sections never reach the line, so reaching the page end selects the
 * last section. State syncs on mount so restored scroll positions are right.
 */
export function useScrollspy(ids: readonly string[]) {
  // A stable key keeps inline arrays from re-binding listeners every render.
  const key = ids.join("\u0000");
  const [active, setActive] = useState<string | undefined>(ids[0]);

  useEffect(() => {
    const sectionIds = key ? key.split("\u0000") : [];
    if (sectionIds.length === 0) {
      setActive(undefined);
      return;
    }

    const headings = sectionIds
      .map((id) => ({ id, el: document.getElementById(docsSectionId(id)) }))
      .filter((item): item is { id: string; el: HTMLElement } => !!item.el);

    const update = () => {
      const line = window.innerHeight * 0.3;
      let current = sectionIds[0];
      for (const heading of headings) {
        if (heading.el.getBoundingClientRect().top <= line) {
          current = heading.id;
        }
      }
      const atEnd =
        window.innerHeight + window.scrollY >=
        document.documentElement.scrollHeight - 2;
      setActive(atEnd ? sectionIds[sectionIds.length - 1] : current);
    };

    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [key]);

  return active;
}
