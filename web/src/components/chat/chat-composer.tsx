"use client";

import * as React from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowUp01Icon,
  Attachment01Icon,
  Cancel01Icon,
  StopIcon,
} from "@hugeicons-pro/core-stroke-rounded";

import type { ThreadStore } from "@/chat/thread-store.ts";
import { useThreadState } from "@/chat/react.ts";
import { Button } from "@/components/motion/button";
import {
  AgentComposerAttach,
  AgentComposerAttachments,
  AgentComposerError,
  AgentComposerInput,
  AgentComposerProvider,
  AgentComposerToolbar,
  type AgentComposerParts,
} from "@/components/premium/agent-chat-input/composition";
import { cn } from "@/lib/utils";

export function ChatComposer({
  store,
  placeholder = "描述你的问题或任务…",
  initialText,
  className,
}: {
  store: ThreadStore;
  placeholder?: string;
  /** 初始文本（用户消息「编辑」动作）；父级用 key 变化触发重挂载生效。 */
  initialText?: string;
  className?: string;
}) {
  const state = useThreadState(store);
  const busy = state.status === "submitted" || state.status === "streaming";

  const [text, setText] = React.useState(initialText ?? "");
  const [files, setFiles] = React.useState<File[]>([]);
  const fileInput = React.useRef<HTMLInputElement>(null);

  const canSubmit = text.trim().length > 0 && !busy;

  function submit() {
    if (!canSubmit) return;
    store.send(
      text,
      files.map((file) => ({ name: file.name, mediaType: file.type })),
    );
    setText("");
    setFiles([]);
  }

  const inputPart = (
    <textarea
      aria-label="消息输入"
      value={text}
      onChange={(event) => setText(event.target.value)}
      placeholder={placeholder}
      rows={2}
      onKeyDown={(event) => {
        if (
          event.key === "Enter" &&
          !event.shiftKey &&
          !event.nativeEvent.isComposing
        ) {
          event.preventDefault();
          submit();
        }
      }}
      className="block max-h-48 min-h-16 w-full resize-none bg-transparent px-4 pt-3 pb-1 text-sm leading-6 text-foreground outline-none placeholder:text-muted-foreground"
    />
  );

  const attachPart = (
    <Button
      type="button"
      variant="plain"
      size="icon"
      aria-label="添加附件"
      className="size-9 rounded-full text-muted-foreground"
      onClick={() => fileInput.current?.click()}
    >
      <HugeiconsIcon icon={Attachment01Icon} aria-hidden className="size-4.5" />
    </Button>
  );

  const actionPart = (
    <Button
      type="button"
      size="icon"
      aria-label={busy ? "停止生成" : "发送"}
      disabled={!busy && !canSubmit}
      onClick={() => (busy ? store.stop() : submit())}
      className="size-9 rounded-full"
    >
      <HugeiconsIcon
        icon={busy ? StopIcon : ArrowUp01Icon}
        aria-hidden
        className={busy ? "size-4 fill-current" : "size-4.5"}
      />
    </Button>
  );

  const attachmentsPart = files.length > 0 && (
    <ul aria-label="附件列表" className="flex flex-wrap gap-2">
      {files.map((file, index) => (
        <li
          key={`${file.name}-${index}`}
          className="flex max-w-full items-center gap-1 rounded-full border border-border bg-background py-0.5 pr-1 pl-3 text-xs"
        >
          <span className="truncate">{file.name}</span>
          <Button
            type="button"
            variant="plain"
            size="icon"
            aria-label={`移除附件 ${file.name}`}
            className="size-6 rounded-full text-muted-foreground"
            onClick={() =>
              setFiles((previous) => previous.filter((_, i) => i !== index))
            }
          >
            <HugeiconsIcon icon={Cancel01Icon} className="size-3" />
          </Button>
        </li>
      ))}
    </ul>
  );

  const parts: AgentComposerParts = {
    input: inputPart,
    toolbar: null,
    attach: attachPart,
    action: actionPart,
    attachments: attachmentsPart,
  };

  return (
    <AgentComposerProvider
      parts={parts}
      state={{
        text,
        model: "",
        models: [],
        busy,
        disabled: false,
        canSubmit,
        setModel: () => {},
        submit,
        stop: () => store.stop(),
        attach: () => fileInput.current?.click(),
      }}
    >
      <form
        aria-label="发送消息"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        className={cn(
          "w-full rounded-xl border border-border bg-card transition-[border-color,box-shadow] duration-200 focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30",
          className,
        )}
      >
        <AgentComposerAttachments className="px-3 pt-3" />
        <AgentComposerInput />
        <AgentComposerToolbar className="px-2 pb-2">
          <AgentComposerAttach />
          <div className="ml-auto">{actionPart}</div>
        </AgentComposerToolbar>
        <AgentComposerError className="px-4 pb-2 text-sm text-destructive" />
        <input
          ref={fileInput}
          type="file"
          multiple
          aria-label="选择附件文件"
          className="sr-only"
          tabIndex={-1}
          onChange={(event) => {
            // 先快照文件列表：清空 input 后 files 会被置空，
            // 而 setState 更新函数在渲染期才执行，读到的将是空 FileList。
            const selected = Array.from(event.target.files ?? []);
            if (selected.length > 0) {
              setFiles((previous) => [...previous, ...selected]);
            }
            event.target.value = "";
          }}
        />
      </form>
    </AgentComposerProvider>
  );
}
