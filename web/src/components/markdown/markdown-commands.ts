export type MarkdownCommand =
  "bold" | "italic" | "heading" | "list" | "quote" | "code" | "link"

/** Replace only the selection (or selected lines); the rest of the source stays byte-for-byte intact. */
export function markdownCommand(
  value: string,
  start: number,
  end: number,
  command: MarkdownCommand
) {
  const selected = value.slice(start, end)
  if (["heading", "list", "quote"].includes(command)) {
    const from = start === 0 ? 0 : value.lastIndexOf("\n", start - 1) + 1
    const nextLine = value.indexOf("\n", Math.max(start, end - 1))
    const to = nextLine < 0 ? value.length : nextLine
    const prefix =
      command === "heading" ? "## " : command === "list" ? "- " : "> "
    const lines = value.slice(from, to).split("\n")
    const remove = lines.every((line) => line.startsWith(prefix))
    const insert = lines
      .map((line) => (remove ? line.slice(prefix.length) : prefix + line))
      .join("\n")
    return { from, to, insert, start: from, end: from + insert.length }
  }
  const markers =
    command === "bold"
      ? ["**", "**", "文字"]
      : command === "italic"
        ? ["*", "*", "文字"]
        : command === "link"
          ? ["[", "](https://)", "链接文字"]
          : selected.includes("\n")
            ? ["```\n", "\n```", "代码"]
            : ["`", "`", "代码"]
  const [before, after, fallback] = markers
  const text = selected || fallback
  return {
    from: start,
    to: end,
    insert: before + text + after,
    start: start + before.length,
    end: start + before.length + text.length,
  }
}
