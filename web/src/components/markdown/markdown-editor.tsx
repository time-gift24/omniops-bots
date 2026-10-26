import { useEffect, useId, useRef, useState, type ReactNode } from "react"
import { Bold, Italic, Heading2, List, Quote, Code2, Link2 } from "lucide-react"
import { Button } from "@/components/arc/button/button"
import { Tooltip } from "@/components/arc/tooltip/tooltip"
import { Tabs, TabsList, TabsTrigger } from "@/components/motion/tabs"
import { Markdown } from "./document-markdown"
import { markdownCommand, type MarkdownCommand } from "./markdown-commands"
import { cn } from "@/lib/utils"
import "./editor.css"

const commands = [
  ["bold", "加粗", Bold],
  ["italic", "斜体", Italic],
  ["heading", "二级标题", Heading2],
  ["list", "列表", List],
  ["quote", "引用", Quote],
  ["code", "代码", Code2],
  ["link", "链接", Link2],
] as const

const shortcuts: Readonly<Record<string, MarkdownCommand | undefined>> = {
  b: "bold",
  i: "italic",
  k: "link",
  e: "code",
}

export function MarkdownEditor({
  value,
  onChange,
  ariaLabel,
  title = "Markdown",
  readOnly = false,
  disabled = false,
  maxLength,
  placeholder,
  preview,
  className,
  markdown = true,
  autoFocus = false,
  initialPreview = false,
}: {
  value: string
  onChange: (value: string) => void
  ariaLabel: string
  title?: ReactNode
  readOnly?: boolean
  disabled?: boolean
  maxLength?: number
  placeholder?: string
  preview?: ReactNode
  className?: string
  markdown?: boolean
  autoFocus?: boolean
  initialPreview?: boolean
}) {
  const [mode, setMode] = useState(initialPreview ? "preview" : "write")
  const input = useRef<HTMLTextAreaElement>(null)
  const id = useId()
  const viewing = readOnly || mode === "preview"
  useEffect(() => {
    if (autoFocus && !disabled && !readOnly) input.current?.focus()
  }, [autoFocus, disabled, readOnly])
  function format(command: MarkdownCommand) {
    const node = input.current
    if (!node || disabled || readOnly) return
    const edit = markdownCommand(
      value,
      node.selectionStart,
      node.selectionEnd,
      command
    )
    if (
      maxLength !== undefined &&
      value.length - (edit.to - edit.from) + edit.insert.length > maxLength
    )
      return
    node.focus({ preventScroll: true })
    node.setSelectionRange(edit.from, edit.to)
    // Browser editing preserves native undo; setRangeText covers engines without insertText.
    if (!document.execCommand("insertText", false, edit.insert)) {
      node.setRangeText(edit.insert, edit.from, edit.to, "end")
      onChange(node.value)
    }
    node.setSelectionRange(edit.start, edit.end)
  }
  return (
    <div
      data-slot="markdown-editor"
      data-mode={viewing ? "preview" : "source"}
      className={cn("markdown-workspace", className)}
    >
      <div className="markdown-workspace-heading">
        <span className="markdown-workspace-title">{title}</span>
        {!readOnly && markdown ? (
          <Tabs value={mode} onValueChange={setMode} variant="segment">
            <TabsList aria-label="Markdown 视图">
              <TabsTrigger
                value="write"
                aria-controls={`${id}-source`}
                className="min-h-8 px-3 py-1.5 text-xs"
              >
                编写
              </TabsTrigger>
              <TabsTrigger
                value="preview"
                aria-controls={`${id}-preview`}
                className="min-h-8 px-3 py-1.5 text-xs"
              >
                预览
              </TabsTrigger>
            </TabsList>
          </Tabs>
        ) : (
          <span className="editor-detail">{readOnly ? "只读" : "源码"}</span>
        )}
      </div>
      {!readOnly && markdown ? (
        <div
          className="markdown-formatting"
          role="toolbar"
          aria-label="Markdown 格式"
          hidden={viewing}
        >
          {commands.map(([command, label, Icon]) => (
            <Tooltip key={command} content={label}>
              <Button
                variant="ghost"
                size="sm"
                className="editor-icon"
                aria-label={label}
                disabled={disabled}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => format(command)}
              >
                <Icon size={16} />
              </Button>
            </Tooltip>
          ))}
        </div>
      ) : null}
      <div className="markdown-canvas">
        {!readOnly ? (
          <textarea
            ref={input}
            id={`${id}-source`}
            hidden={viewing}
            aria-label={ariaLabel}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            disabled={disabled}
            maxLength={maxLength}
            autoFocus={autoFocus}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            placeholder={placeholder ?? "开始编写…"}
            className="markdown-source"
            onKeyDown={(event) => {
              if (
                event.nativeEvent.isComposing ||
                !(event.metaKey || event.ctrlKey) ||
                event.altKey
              )
                return
              const command = shortcuts[event.key.toLowerCase()]
              if (command && markdown) {
                event.preventDefault()
                event.stopPropagation()
                format(command)
              }
            }}
          />
        ) : null}
        {viewing ? (
          <div
            id={`${id}-preview`}
            tabIndex={0}
            aria-label={`${ariaLabel}预览`}
            className="markdown-preview"
          >
            {preview ??
              (value.trim() ? (
                <Markdown>{value}</Markdown>
              ) : (
                <p className="editor-empty">暂无内容</p>
              ))}
          </div>
        ) : null}
      </div>
      <div className="markdown-status" aria-hidden="true">
        <span>{markdown ? "Markdown" : "纯文本"}</span>
        <span>
          {value.split("\n").length} 行 <span className="mx-2">·</span>
          {value.length.toLocaleString("zh-CN")}
          {maxLength ? ` / ${maxLength.toLocaleString("zh-CN")}` : ""} 字符
        </span>
      </div>
    </div>
  )
}
