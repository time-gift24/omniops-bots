# 核心 · A2A 任务执行与恢复

**客户端主动建立一条 WSS，服务端 Agent 通过 A2A 调用确定版本的客户端 Agent。WebSocket 负责网络传输，A2A 负责任务语义，现有 Node.js runtime 负责 Agent 执行。** 线上用户仍在 Console 发起业务、查看状态和结果；运维调试桌面用于编辑、实验和排障。

以下图示是本次确认的**目标设计**，不是已实现链路。远端 A2A、WSS 绑定、持久去重与交付确认仍待接入。协议以 [A2A 1.0.0](https://a2a-protocol.org/v1.0.0/specification/) 为基线，协商版本为 `1.0`；WebSocket 使用明确声明的自定义绑定，不宣称它是标准 HTTP JSON-RPC 绑定。

## 三层职责：网络、协议、执行

![网络、A2A 与 Agent 执行分开](./assets/a2a/layers.svg)

[打开职责图](./diagrams/a2a/layers.html)

| 职责 | 负责什么 | 关键边界 |
| --- | --- | --- |
| WSS 网络传输 | 客户端主动连接、身份认证、心跳、退避重连、有界收发、连接与流清理 | 不装配 Agent，不判断业务终态，不因断线取消运行；发送成功不表示结果已交付 |
| A2A 协议与任务处理 | 标准操作与对象校验、`tenant` 路由、`messageId` 持久去重、Task 状态、订阅与查询、结果交付 | 在受理前检查授权；执行前受理落盘；重投只返回原 Task；执行状态与交付状态分开 |
| Agent 执行 | 复用现有装配、并发准入、LangGraph、模型、MCP、Playwright、取消排空与执行证据 | 接收明确输入和固定版本；不接触 socket 或原始网络报文；不自建第二套调度器 |

这些是职责边界，共用一个 Node runtime，不要求新增独立服务、通用容器或每个 Agent 一条连接。Rust 继续承担原生宿主与系统能力。

服务端 Agent 是 **A2A Client**，桌面 Agent 是 **A2A Server**；这与桌面主动建立 WSS 的网络方向不同。每个官方 `agentId + contentId` 对应一个逻辑入口和标准 AgentCard，复用官方目录；多个入口共享同一 WSS。请求携带所选 AgentCard 接口的标准 `tenant` 路由值，由 A2A 适配层解析；真实组织、用户与安装权限来自已鉴权连接，不由 `tenant` 自行声明。

## 场景一：受理、执行、保存与交付

**前提：**连接已鉴权，目标版本与扩展已协商，新消息可以受理。用户从 Console 发起业务，服务端选择确定版本的 AgentCard，以标准消息的 Data Part 显式传入业务输入和所需上下文。

![A2A 任务从受理到持久交付的运行顺序](./assets/a2a/run.svg)

[打开完整运行顺序图](./diagrams/a2a/run.html)

图中使用标准 `SendStreamingMessage`：首条响应为已持久受理的 Task，之后发送任务级状态和最终 Artifact。也可 `SendMessage` 后 `SubscribeToTask`；执行不等待订阅，订阅消失也不停止执行。

**结果：**先保存终态 Task、最终 Artifact 和执行记录，完成本地结算并释放运行容量，再交付结果。服务端幂等持久保存结果与索引、确保后续编排不会重复推进后，通过已声明的交付确认扩展确认；桌面校验原 Task 与结果摘要并持久标记已交付。确认失败只影响交付，不重新启动执行。

连接可用、Task 已受理、执行已终止、结果已交付是四个不同边界。一次 Task 内可以有多次模型与工具调用，单次模型输出结束不代表 Task 完成。除交付确认这一项必要业务扩展外，沿用标准 A2A 操作、状态和数据对象；具体契约见[第 10 章](./10-服务端API.md#a2a-任务通道wss-只负责传输)。

## 场景二：重复投递同一任务消息

**前提：**服务端没有收到先前响应，使用原 `messageId` 和相同调用内容重投；新的 JSON-RPC `id` 仅用于关联本次往返。

![重复消息只取得原 Task](./assets/a2a/duplicate.svg)

[打开重复投递顺序图](./diagrams/a2a/duplicate.html)

**结果：**先查持久去重记录，再检查新任务容量。重投返回原 Task 的当前状态或原拒绝 Task，不再创建 thread、run 或页面；同 ID 不同内容返回协议冲突错误，不改变原记录。去重范围绑定已鉴权租户、调用方和目标安装，并比较包含目标入口与版本的不可变调用内容。显式再次执行必须使用新 `messageId`。

## 场景三：容量已满，持久保存拒绝 Task

**前提：**消息合法、通过鉴权且未重复，但本地、实验和远端共用的运行容量已满。

![忙时返回可查询的 REJECTED Task](./assets/a2a/busy.svg)

[打开忙时拒绝顺序图](./diagrams/a2a/busy.html)

**结果：**保存可查询的 `REJECTED` Task，通过标准状态 Message 的 Data Part 表达 `busy`。不创建 thread、run 或 Chrome 页面，不排队；重投原消息仍返回原拒绝 Task。格式或鉴权错误直接返回协议错误，不创建 Task。默认并发 4，可在本机设置为 1～64，详见[第 07 章](./07-任务执行与恢复.md#偏好设置并发任务上限)。

## 场景四：断线继续执行，重连恢复当前状态

**前提：**客户端进程仍在，网络断开；图中任务在重连前已完成。

![断线继续执行，重连查询原 Task](./assets/a2a/disconnect.svg)

[打开断线恢复顺序图](./diagrams/a2a/disconnect.html)

**结果：**当前 run 继续，本地结算与持久保存不等待网络。WSS 重新鉴权后，已终态使用 `GetTask` 取得最终结果；未终态使用 `SubscribeToTask`，首条为当前 Task 快照。订阅时若恰好已终态，转为 `GetTask`。不补播历史事件，不新增私有恢复消息或事件游标；未确认结果继续完成交付确认。

若首次受理响应丢失、服务端还不知道 `taskId`，先以原 `messageId` 重投取得原 Task；已知任务可通过标准 `ListTasks` 在授权入口内分页核对。跨端断线不改变 run 的终止原因，也不承诺外部 Chrome 操作的副作用恰好发生一次。

## 场景五：重启时已有终态，只恢复交付

**前提：**上次已持久保存终态 Task 和最终结果，服务端尚未确认。

![重启后交付原有终态结果](./assets/a2a/restart-complete.svg)

[打开已完成结果的重启顺序图](./diagrams/a2a/restart-complete.html)

**结果：**复用原 Task、Artifact 与结果摘要，只恢复查询和交付确认；不重新装配 Agent，不创建 run，不打开任务页面。重复读取、接收和确认不重复驱动服务端后续业务。

## 场景六：重启时未完成，报告结果未知

**前提：**上次强退或崩溃，持久记录仍为非终态。

![重启发现未完成任务，保存 FAILED 与结果未知原因](./assets/a2a/restart-unknown.svg)

[打开未完成任务的重启顺序图](./diagrams/a2a/restart-unknown.html)

**结果：**在恢复对外查询前，将遗留 Task 持久收敛为 `FAILED`，原因码为 `interrupted-unknown`，明确“外部操作可能已发生，结果未知”。不解释为从未执行，不自动重试。SQLite checkpoint 只保留诊断证据，不触发图或模型恢复；后续业务由服务端显式发送新消息、创建新 Task。

## 场景七：取消是一项请求，排空后才算取消

**前提：**Task 尚未固定执行结果，取消在可取消阶段生效。

![CancelTask 请求与排空后的 CANCELED 终态](./assets/a2a/cancel.svg)

[打开取消顺序图](./diagrams/a2a/cancel.html)

**结果：**标准 `CancelTask(taskId)` 请求停止该 run；排空期间仍为 `WORKING`，以标准 `TaskStatus.message` 提示正在停止，仍占运行容量。已启动操作和证据写入排空、唯一取消终态落盘并完成结算后，才报告 `CANCELED` 并释放容量；已发生的外部操作不回滚，其他任务继续执行。

如果结果已固定或 Task 已终态，返回标准 `TaskNotCancelableError`，用 `GetTask` 查看原结果，不改写终态。取消后的网络断开不撤销停止请求；重复取消只产生相同停止效果，不定义私有取消回执，也不将收到请求当成取消完成。

## 场景八：超时、缺输入或登录验证直接失败

**前提：**图中一次只发生一种业务失败，几种原因不表示依次执行。

![执行失败统一进入 FAILED](./assets/a2a/failure.svg)

[打开失败顺序图](./diagrams/a2a/failure.html)

| 情况 | 标准 Task 状态 | 状态 Message 的 Data Part |
| --- | --- | --- |
| 本轮超时 | `FAILED` | `timed-out` 与安全说明 |
| 缺少必要输入 | `FAILED` | `missing-input` 与待补信息说明 |
| 需要人工登录或验证 | `FAILED` | `login-required` 与必要操作指引 |
| 重启发现未完成任务 | `FAILED` | `interrupted-unknown`，外部操作可能已发生；单独见场景六 |

**结果：**停止后续步骤，排空并保存失败终态，再释放容量并交付。Task 一次执行到终态，不使用 `INPUT_REQUIRED`／`AUTH_REQUIRED` 挂起恢复。用户补齐输入或在专用 Chrome 完成验证后，经 Console 发起新 Task；标准终态均不可重新启动。

## 身份、上下文与过程数据

| 对象 | 本项目含义 |
| --- | --- |
| `messageId` | 首次任务消息的稳定身份与持久幂等键；替代原私有 `callId` |
| JSON-RPC `id` | 一次请求与响应／流的关联；可随重投变化，不决定是否重新执行 |
| `taskId` | 桌面 A2A Server 创建的 Task 身份，供查询、订阅、取消与交付确认使用 |
| `contextId` | 只关联业务中的多个 Task，不等同于本地 thread，不自动继承聊天、图状态或页面现场 |
| `threadId`／`runId`／`graphThreadId` | 本地会话、单次执行与图身份；每个已受理 Task 独立创建，拒绝 Task 没有这些执行资源 |
| `tenant` | 所选 AgentCard 接口提供的标准路由值，固定映射到一个官方 `agentId + contentId`；不是客户端自报权限 |

每个受理 Task 绑定独立的 Chrome 页面；多个页面共享专用 profile，因此可以复用登录态，但不隔离账号或站点资源。页面丢失不回退到别的页面。终态后保留页面供运维查看；重启恢复记录不重建页面，也不恢复旧任务。

线上订阅仅发送 Task 快照、标准任务状态事件与最终 Artifact；Artifact 承载业务结果和必要的非敏感运行摘要。完整模型输出、工具参数与过程、完整快照和 checkpoint 留在本地，不随普通任务流上传；排障沿用[第 09 章](./09-运维与诊断上传.md)的预览、授权和独立上传。AgentCard 的 `streaming` 表示支持这些任务事件，不表示开放模型 token 流。

## 继续阅读

- [07 · 任务执行与恢复](./07-任务执行与恢复.md)：本地运行约束、浏览器目标、并发偏好与结算边界。
- [10 · 服务端 API](./10-服务端API.md)：WSS 绑定、标准 A2A 操作、失败边界与唯一交付确认扩展。
- [核心 · Skill 模板与迭代](./核心-Skill模板与迭代.md)：核心章节的最后一章，讲解运维能力如何积累与发布。

本次只修订目标设计与串讲材料，沿用本地执行记录和既有观测边界，不新增日志、span 或指标。A2A 原始 Message、Artifact、提示词和完整错误来源链不作为遥测输出。
