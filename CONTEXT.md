# omniops-bots Desktop 上下文与领域术语

本仓专注桌面客户端。Node.js 是 desktop 的主后端，负责业务执行与本地数据；Rust 保留在 Tauri／原生宿主边界，不再建设独立 Rust backend harness。

## 仓库结构

| 路径 | 当前职责 |
| --- | --- |
| `web/` | 共享前端、Tauri 与 demo adapter、界面测试 |
| `desktop/runtime/` | Node.js 业务后端、图执行、聊天、资源、浏览器和本地持久化 |
| `desktop/scripts/` | Node 运行资源准备、构建与跨平台打包 |
| `crates/omniops-bots-desktop/` | Tauri 原生宿主、IPC、CEF、sidecar 与退出协调 |
| `crates/omniops-bots-desktop-helper/` | macOS CEF 子进程入口 |
| `crates/omniops-bots-collector/` | Rust 宿主的进程内遥测输出与生命周期 |

Rust workspace 只包含上述三个 crate，采用 Rust 2024／`1.92.0`；桌面 Node 固定为 `26.11.1`。

## 运行与数据边界

- `web/`：React／TypeScript 共享前端；桌面模式使用 Tauri adapter，浏览器预览使用 demo adapter。UI 通过既有接口访问宿主能力，不直接实现模型调用、图执行或文件系统访问。
- `crates/omniops-bots-desktop/`：Tauri 宿主，负责原生窗口／浏览器、IPC、Node sidecar 生命周期与退出协调；helper 承载原生浏览器子进程入口。
- `desktop/runtime/`：随桌面打包的 Node.js 后端，使用 LangGraph／DeepAgents 执行图，负责 Agent／Skill 装配、模型与 MCP 接入、浏览器自动化和本地持久化。
- 调用路径：前端 Tauri adapter → `runtime_request` 原生命令 → Node stdin/stdout JSON 行协议 → runtime；执行事件沿 `runtime-event` 返回前端。原生浏览器窗口布局等宿主操作通过专属 Tauri 命令处理。
- Node 将 Agent、Skill、MCP 配置、Run 记录、会话历史与装配快照保存在本地文件中，将原生 LangGraph checkpoint 保存在本地 SQLite 中。默认资源根目录为 `~/.omnimind-ops`；桌面应用数据目录另存客户端设置、模型环境配置与浏览器数据。
- 前端工作区／会话导航目前是内存状态；后端保存运行记录不等于前端已支持刷新恢复，也不等于任务允许自动续跑。
- 模型服务、MCP 服务与业务系统是外部接入边界；本仓不实现它们的独立服务端，也不提供独立 Web 运维后端。

## 两类浏览器

- **Agent Chrome**：本机已安装的外部 Google Chrome，由 Node／Playwright 按需启动。使用应用数据目录下独立的 `chrome/` profile，各 thread 固定自己的页面，工具只能访问指定 target；不同会话共享该专用 profile 的登录态。普通会话切换读取状态，显式「显示 Chrome」创建或聚焦页面。
- **运维浏览器**：随包 CEF 的内嵌手动页面，固定身份 `__manual__`。Node 通过宿主提供的本地 CDP 连接维护状态，Rust 管理画面布局和输入。运维导航与 Agent 任务相互独立；Agent 工具不接入该页面。
- Node、Playwright 和 CEF 随应用交付；外部 Google Chrome 单独安装和更新。应用专用 profile 与用户日常浏览器数据隔离；不会复制日常 profile 或将 Cookie 写入运行快照。

## 对话与模型调用

下列术语描述业务语义，不要求同名 Rust 类型或另建统一协议层。实际模型调用与原生消息由 Node 侧 LangChain 集成承担，前端事件由聊天适配器转换。

**Provider**：模型服务的接入方及其地址、凭据配置；不等同于厂商品牌或协议。当前桌面启动入口从环境／本地模型配置创建模型客户端。

**Model**：一次模型调用选择的模型 ID，由 Node 侧模型客户端结合接入配置调用；不沿用旧 Rust 后端的 Model／Protocol 绑定 API。

**Protocol**：外部模型服务采用的 API 语义和消息格式，由接入库处理；SSE、NDJSON 等分帧方式不单独构成模型调用协议。桌面 IPC 的 JSON 行协议与模型协议分开。

**Generation**：一次模型调用；工具执行后的下一次模型调用属于新的 Generation。它是区分模型调用与整轮任务的语义，不代表本仓还要实现独立 Rust Generation API。
_Avoid_: 将完整工具循环称为一次 Generation

**Message**：对话历史中的一次用户输入、assistant 输出或工具结果；原生历史保存在 Node 侧，前端消息是用于展示和交互的投影。

**AssistantMessage**：模型产生的 assistant 历史单位，可包含文本、推理或工具调用；不要求与前端一轮结果一一对应。

**Part**：前端 assistant 展示中有确定位置的一块内容，例如文本、推理或工具调用。

**ToolCall**：模型要求执行的具名工具调用，具有关联身份和参数。

**ToolResult**：对应一个 ToolCall 的执行结果，包括执行失败。

**FinishReason**：模型停止本次输出的原因，区别于网络、协议或整个 Run 的失败。

**Completed／completed**：必须按所属层级理解。模型调用完成不表示工具循环结束；前端聊天适配器的 `completed` 事件结束本轮返回流，Run 记录的 `completed` 状态表示整轮图执行完成。

## Desktop 图执行

**Thread**：业务会话，可包含多轮显式发起的 Run；聊天适配器在会话内固定 Agent／Skill 装配快照，等待用户输入时不占用执行名额。

**Run**：用户明确发起的一轮图执行，可包含多次 Generation 和图内并行分支；失败、取消或重启中断后不自动续跑。
_Avoid_: 将单次 Generation 完成当作 Run 已完成

**Graph**：由代码定义并随 desktop 发版的 LangGraph 编排，拥有自己的输入、state 与结果，不强制包含 messages；Agent 配置只负责提示词、Skill 和工具选择。

**GraphThreadId**：一个 Run 独有的图执行标识，对应 LangGraph 的 `thread_id`；保留业务 `threadId` → `runId` → `graphThreadId` 映射及原生 `checkpoint_ns`。

**Checkpoint**：LangGraph 图状态、父关系与 pending writes 的保存证据，由本地 SQLite 持久化；聊天历史不能替代它，保存也不表示允许重启后续跑。
