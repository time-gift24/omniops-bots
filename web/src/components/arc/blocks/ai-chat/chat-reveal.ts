const FENCE = /^\s*```/
const isSpace = (char: string | undefined) =>
  char === " " || char === "\n" || char === "\t"

function wordEnd(text: string, from: number) {
  let i = from
  while (i < text.length && isSpace(text[i])) i += 1
  while (i < text.length && !isSpace(text[i])) i += 1
  return i
}

/**
 * Where the next chunk ends: `words` whole words after `from`. A word still arriving waits for the next tick, a code
 * fence shows as a whole line, and a list marker or heading mark never shows without its first word, so no block
 * changes shape after it appears.
 */
export function nextCut(
  text: string,
  from: number,
  words: number,
  final: boolean
): number {
  let i = from
  for (let n = 0; n < words && i < text.length; n += 1) i = wordEnd(text, i)
  if (i >= text.length && !final) {
    let j = text.length
    while (j > from && !isSpace(text[j - 1])) j -= 1
    i = j
  }
  if (i <= from) return from
  for (let guard = 0; guard < 4; guard += 1) {
    const lineStart = text.lastIndexOf("\n", i - 1) + 1
    const newline = text.indexOf("\n", lineStart)
    const lineEnd = newline === -1 ? text.length : newline
    if (FENCE.test(text.slice(lineStart, lineEnd))) {
      if (newline !== -1) return Math.max(i, newline + 1)
      return final ? text.length : Math.max(from, lineStart)
    }
    if (/^\s*(\d+\.|[-*]|#{1,4})\s*$/.test(text.slice(lineStart, i))) {
      const end = wordEnd(text, i)
      if (end >= text.length && !final) return Math.max(from, lineStart)
      i = end
      continue
    }
    break
  }
  return i
}
