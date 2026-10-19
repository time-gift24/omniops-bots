# omniops-bots LLM 领域术语

系统用统一术语描述对话和模型调用。

## Language

**Provider**：一个具有独立身份和固定接入地址的模型服务配置，可提供多个模型。
_Avoid_: 将 Provider 等同于厂商品牌或协议

**Model**：绑定到某个 Provider 的模型 ID 和具体调用协议；一次调用的目标由该绑定决定。

**Protocol**：模型调用采用的 API 协议，决定请求、响应及流式事件的具体格式，并映射到系统统一语义。
_Avoid_: 将 SSE、NDJSON 等流式分帧方式称为模型调用协议

**Generation**：一次模型调用；工具执行后的下一次模型调用属于新的 Generation。
_Avoid_: 将完整工具循环称为一次 Generation

**Message**：对话历史中的一次用户输入、assistant 输出或工具结果。

**AssistantMessage**：一次 Generation 产生的完整 assistant 历史单位，可包含文本、推理和工具调用。

**Part**：AssistantMessage 内有确定位置的一块内容。

**ToolCall**：模型要求调用方执行的一个具名工具调用，具有关联身份和参数。

**ToolResult**：对应一个 ToolCall 的执行结果，包括执行失败。

**NativeReplay**：与 assistant 内容绑定、下一次调用回放该内容时需要保留的原生信息。

**FinishReason**：模型停止本次输出的原因，区别于调用发生的网络或协议失败。

**Completed**：一次 Generation 已正常收尾并返回完整结果；不表示上层用户任务或工具循环已经结束。

## Desktop 图执行

**Thread**：业务会话，可包含多轮显式发起的 Run；聊天适配器在会话内固定 Agent／Skill 装配快照，等待用户输入时不占用执行名额。

**Run**：用户明确发起的一轮图执行，可包含多次 Generation 和图内并行分支；失败、取消或重启中断后不自动续跑。
_Avoid_: 将单次 Generation 的 Completed 当作 Run 已完成

**Graph**：由代码定义并随 desktop 发版的 LangGraph 编排，拥有自己的输入、state 与结果，不强制包含 messages；Agent 配置只负责提示词、Skill 和工具选择。

**GraphThreadId**：一个 Run 独有的图执行标识，对应 LangGraph 的 thread_id；保留业务 threadId → runId → graphThreadId 映射及原生 checkpoint_ns。

**Checkpoint**：LangGraph 图状态、父关系与 pending writes 的保存证据，由本地 SQLite 持久化；聊天历史不能替代它，保存也不表示允许重启后续跑。
