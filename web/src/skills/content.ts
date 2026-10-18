export function splitFrontmatter(source: string): {
  metadata: string | null
  body: string
} {
  const match = /^---\r?\n((?:[^\n]*\n)*?)---(?:\r?\n|$)/.exec(source)
  return match
    ? { metadata: match[1], body: source.slice(match[0].length) }
    : { metadata: null, body: source }
}

export function resolveSkillLink(
  currentPath: string,
  href: string
): { path: string; hash: string } | null {
  const link = href.trim()
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(link) || /\p{Cc}/u.test(link)) {
    return null
  }
  try {
    decodeURI(link)
    const root = new URL("https://skill.invalid/")
    const base = new URL(
      currentPath.split("/").map(encodeURIComponent).join("/"),
      root
    )
    const target = new URL(link, base)
    if (target.origin !== root.origin) return null
    return {
      path: decodeURIComponent(target.pathname.slice(1)),
      hash: decodeURIComponent(target.hash.slice(1)),
    }
  } catch {
    return null
  }
}

export function headingSlug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, "")
      .trim()
      .replace(/\s+/g, "-") || "section"
  )
}
