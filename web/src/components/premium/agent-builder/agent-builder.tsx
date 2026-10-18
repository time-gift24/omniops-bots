"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import { BotIcon } from "@hugeicons-pro/core-stroke-rounded";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { ChatScreen } from "@/components/chat/chat-screen";
import {
  Button,
  type ButtonState,
  StatefulButton,
} from "@/components/motion/button";
import { EASE_OUT } from "@/lib/ease";
import { cn } from "@/lib/utils";
import {
  AGENT_MODELS,
  AGENT_SKILLS,
  AGENT_TOOLS,
  type AgentConfiguration,
  type AgentModel,
  type AgentResource,
  DEFAULT_AGENT,
  type McpServer,
  MCP_SERVERS,
} from "./agent-builder-data";
import { AgentConfigurationPanel } from "./agent-configuration";

/** 试运行空状态的引导问题，贴合业务构建者的验证场景。 */
const TEST_SUGGESTIONS = [
  "你能帮我做什么？",
  "查一下订单 1024 的最新状态",
  "这周的客户问题有什么共同点？",
] as const;

export type AgentBuilderProps = {
  initialConfiguration?: AgentConfiguration;
  models?: readonly AgentModel[];
  mcpServers?: readonly McpServer[];
  tools?: readonly AgentResource[];
  skills?: readonly AgentResource[];
  /** 试运行会话的线程 ID，复用现有流式对话栈。 */
  threadId?: string;
  onSave?: (configuration: AgentConfiguration) => void | Promise<void>;
  className?: string;
};

export function AgentBuilder({
  initialConfiguration = DEFAULT_AGENT,
  models = AGENT_MODELS,
  mcpServers = MCP_SERVERS,
  tools = AGENT_TOOLS,
  skills = AGENT_SKILLS,
  threadId = "agent-test",
  onSave,
  className,
}: AgentBuilderProps) {
  const [configuration, setConfiguration] = useState(initialConfiguration);
  const [saved, setSaved] = useState(initialConfiguration);
  const [saveState, setSaveState] = useState<ButtonState>("idle");
  const [error, setError] = useState("");
  const lock = useRef(false);
  const resetTimer = useRef<number | undefined>(undefined);
  const reduce = useReducedMotion();
  const dirty = JSON.stringify(configuration) !== JSON.stringify(saved);
  const saving = saveState === "loading";

  useEffect(() => () => window.clearTimeout(resetTimer.current), []);

  function settle(state: ButtonState) {
    setSaveState(state);
    window.clearTimeout(resetTimer.current);
    resetTimer.current = window.setTimeout(() => setSaveState("idle"), 1800);
  }

  async function save() {
    if (lock.current) return;
    if (!configuration.name.trim() || !configuration.instructions.trim()) {
      setError("请先填写名称和指令，再保存。");
      return;
    }
    if (!models.some((model) => model.id === configuration.model)) {
      setError("请选择一个可用的模型。");
      return;
    }
    lock.current = true;
    setSaveState("loading");
    setError("");
    try {
      await onSave?.(configuration);
      setSaved(configuration);
      settle("success");
    } catch {
      setError("保存失败，请重试。");
      settle("error");
    } finally {
      lock.current = false;
    }
  }

  return (
    <div
      className={cn(
        "h-full w-full overflow-y-auto bg-background px-5 py-8 text-foreground sm:px-8 lg:overflow-hidden",
        className,
      )}
    >
      <div className="mx-auto flex min-h-full max-w-6xl flex-col lg:h-full">
        <header className="mb-8 flex shrink-0 flex-wrap items-center justify-between gap-5">
          <div className="flex min-w-0 items-center gap-3">
            <span className="grid size-11 shrink-0 place-items-center rounded-full bg-accent text-accent-foreground">
              <HugeiconsIcon icon={BotIcon} aria-hidden="true" size={20} />
            </span>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="truncate text-xl font-medium">
                  {configuration.name.trim() || "未命名 agent"}
                </h2>
                <AnimatePresence initial={false}>
                  {dirty ? (
                    <motion.span
                      animate={{ opacity: 1, scale: 1 }}
                      className="shrink-0 rounded-full border border-amber-500/25 bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-300"
                      exit={{ opacity: 0, scale: reduce ? 1 : 0.85 }}
                      initial={{ opacity: 0, scale: reduce ? 1 : 0.85 }}
                      transition={{ duration: 0.2, ease: EASE_OUT }}
                    >
                      未保存
                    </motion.span>
                  ) : null}
                </AnimatePresence>
              </div>
              <p className="mt-1 truncate text-sm text-muted-foreground">
                {configuration.description.trim() ||
                  "定义它的思考方式、回复风格和能力边界。"}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              disabled={!dirty || saving}
              onClick={() => {
                setConfiguration(saved);
                setError("");
              }}
              variant="ghost"
            >
              放弃更改
            </Button>
            <StatefulButton
              disabled={(!dirty && saveState === "idle") || saving}
              errorText="重试"
              loadingText="保存中"
              onClick={() => void save()}
              state={saveState}
              successText="已保存"
            >
              保存
            </StatefulButton>
          </div>
        </header>

        {error ? (
          <p className="mb-6 text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}

        <div className="grid flex-1 gap-10 lg:min-h-0 lg:grid-cols-2 lg:gap-14">
          <div className="min-w-0 lg:min-h-0 lg:overflow-y-auto">
            <AgentConfigurationPanel
              disabled={saving}
              models={models}
              mcpServers={mcpServers}
              onChange={(next) => {
                setConfiguration(next);
                setError("");
              }}
              tools={tools}
              skills={skills}
              value={configuration}
            />
          </div>
          <div className="flex min-h-[480px] min-w-0 flex-col lg:min-h-0">
            <div className="min-h-0 flex-1 overflow-hidden rounded-2xl border border-border">
              <ChatScreen
                threadId={threadId}
                suggestions={TEST_SUGGESTIONS}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
