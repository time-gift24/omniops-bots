import assert from "node:assert/strict"
import { test } from "node:test"
import { markdownCommand } from "../src/components/markdown/markdown-commands.ts"

test("Markdown commands preserve source outside the selected text and lines", () => {
  const source = '---\r\nname: agent\r\n---\r\n\n#### 原始标题\n\n![图](a.png)\n'
  const start = source.indexOf("原始")
  const edit = markdownCommand(source, start, start + 4, "bold")
  assert.equal(source.slice(0, edit.from) + edit.insert + source.slice(edit.to), source.replace("原始标题", "**原始标题**"))
  assert.equal(edit.start, start + 2)
  assert.equal(edit.end, start + 6)
  assert.deepEqual(markdownCommand("a\nb\nc", 0, 3, "list"), { from: 0, to: 3, insert: "- a\n- b", start: 0, end: 7 })
  assert.equal(markdownCommand("- a\n- b", 0, 7, "list").insert, "a\nb")
  assert.equal(markdownCommand("\na", 0, 0, "heading").insert, "## ")
  assert.equal(markdownCommand("a\nb", 0, 3, "code").insert, "```\na\nb\n```")
  assert.equal(markdownCommand("", 0, 0, "link").insert, "[链接文字](https://)")
})
