# 核心 · A2A 任务执行与恢复

**先让外部 Agent 通过标准 A2A 接口调用桌面 Agent，独立验证 A2AService 的任务闭环，再接 WSS。** 外部 Agent 是 A2A Client，桌面 Agent 是 A2A Server；调用方只交业务 JSON、查询 Task、请求取消并接收最终 Artifact，不进入 runtime、LangGraph、数据库或浏览器内部。

**当前状态：A2AService 已实现，并通过独立外部 Agent 的标准 A2A 验收；WSS 尚未接入。** 本阶段已完成模块独立验证，WSS 连接、网关、心跳、重连和 Upgrade 协商均放到后续。标准协议基线为 [A2A 1.0.0](https://a2a-protocol.org/v1.0.0/specification/)，直接复用官方 `@a2a-js/sdk`，先不 fork；业务 input 为 JSON 对象，output 为任意 JSON 值，不绑定某个具体业务 Agent。

## 当前主线：外部 Agent 直接调用 A2A

本阶段独立验证使用 SDK 的标准 **JSON-RPC over HTTP，流响应为 SSE**；卡片声明 `protocolBinding: "JSONRPC"`、`protocolVersion: "1.0"` 和确定版本的 `tenant`。外部 Agent 在独立进程中使用 SDK `ClientFactory` 读取 AgentCard 并发起调用，不需要 Console、服务端 graph、WSS 或自定义 transport。这里的“直接”指调用公开 A2A 协议，不能用同进程调用内部函数代替外部验收。

验证宿主只在本机 loopback 临时启动，复用 SDK `agentCardHandler`／`jsonRpcHandler`，不自写 HTTP/SSE 协议栈，也不把临时宿主变成桌面常驻公网服务。SDK Express peer 仅为验证宿主按需采用；不进入 A2AService 核心依赖，仅宿主使用开发依赖。宿主提供测试身份与独立请求上下文，服务仍逐次授权；不使用匿名上下文冒充鉴权通过。生产认证与远端可达方式留给后续接入。

| 外部 Agent 做什么 | A2AService 保证什么 |
| --- | --- |
| 读取确定版本 AgentCard，发送带稳定 messageId 的 JSON Data Part | 授权、去重、共享容量准入；受理落盘后才执行，返回标准 Task |
| SendMessage 默认等待终态；要先取 taskId 时显式 returnImmediately=true；也可 SendStreamingMessage | 初始 Task、任务级状态和最终 Artifact；不转发模型 token 或工具轨迹 |
| GetTask／ListTasks／SubscribeToTask | 只读自己授权入口的已提交状态；中断等待不停止任务，重新查询不重跑 |
| CancelTask | 可取消时先请求停止，排空期间 WORKING；真实排空并保存后才 CANCELED；固定结果不可改写 |
| 保存原结果及索引，再调用 omniops/ConfirmTaskDelivery | 唯一项目业务扩展；校验结果摘要并持久确认，重复确认不执行任务 |

标准 A2A 操作不要求调用者安装项目 client 包。交付确认是单独声明的扩展，SDK 没有该自定义方法的高层 client；验证端只补这一条 JSON-RPC 调用，复用标准请求／错误对象，不另造整套客户端。

## 关键类图：公开边界与 SDK 复用

![A2AService 目标契约：SDK handler、共享执行预留与 SDK Task 存储](./assets/a2a/module-contract.svg)

[打开 A2AService 关键类图](./diagrams/a2a/module-contract/module-contract.html)

图中是**已实现模块的公开类型关系**，仅列关键成员；完整签名、构造校验、错误和关闭见 [A2AService 契约](../../openspec/changes/define-desktop-a2a-interface/contract.md)。`A2AService` 是一个 Node 模块，不是新进程；对标准操作返回 SDK `A2ARequestHandler`，只适配两条发送路径与取消，查询／订阅等继续复用 `DefaultRequestHandler`。图中的 TaskStore 是内部依赖，不向外导出；受控写入继续调用 SDK `DatabaseTaskStore(trx)`，只加一张项目扩展表，不手写 Task CRUD 或分页。

A2AService 与 runtime 之间是**同进程函数调用**：`reserveRun()` 后得到 `RunReservation`，`execute({threadId, runId, agent:{agentId, contentId}, input})` 返回现有 `ExecutionOutcome<JsonValue>`，`requestStop()` 报告 requested／result-fixed，`release()` 归还名额。图／模型／MCP／浏览器准备与实际清理由 runtime 负责；Message／Artifact 映射、终态和交付由 A2AService 负责。SDK `AgentExecutor` 只做内部薄桥接，不再创建执行服务。

## 验证通过后，才把模块当黑盒

下面是本阶段的验收门槛，模块、真实 runtime 和独立外部调用均已执行；完整命令、通过范围与限制见 [验收记录](../../openspec/changes/define-desktop-a2a-interface/verification.md)。先用小型 runtime fake 精确验证竞争与故障；再由独立外部 Agent 经过真实 SDK HTTP 入口，连到真实 runtime／LangGraph，以本地确定性模型 fixture 跑完任务。涉及浏览器的用例使用本地测试站点和受管理 Chrome，不用真实密钥或付费模型，也不预建某个业务 Agent。

| 必验行为 | 从公开入口观察的通过条件 |
| --- | --- |
| 成功闭环 | 外部 Agent 提交 JSON、取得唯一 Task、收到最终 Artifact；0／false／null 不丢失，随后 GetTask 返回同一结果 |
| 重投与容量 | 同 messageId 并发只执行一次；同 ID 不同内容报错；busy 保存可查询的 REJECTED，且不创建运行资源 |
| 查询、隔离与协议 | 另一个主体／安装／入口不能读取原 Task；分页、版本、扩展、不支持能力与错误形状符合所声明契约 |
| 取消与等待结束 | 取消先 WORKING 后 CANCELED；固定结果拒绝取消；外部调用者断开／放弃流后任务仍结算，可重新查询 |
| 持久化与进程重启 | 真实 SQLite 验证两表原子提交、终态冻结和回执；重启保留原终态，遗留未完成转 FAILED/interrupted-unknown，均不重跑 |
| 故障与关闭 | 受理写失败不执行、终态写失败不伪造完成、回执失败不改结果；有界等待／订阅、取消清理和同一预算关闭可验证 |

“黑盒”意味着后续 adapter 只使用 `createA2AService`、`protocolFor` 返回的 SDK handler、`confirmTaskDelivery` 与本地 `close`；外部 Agent 只使用 AgentCard、标准 A2A 操作和明确的回执扩展。换成 WSS 时只验传输、身份注入和兼容接入，沿用同一组任务契约回归，不能把去重、状态、取消或持久化搬到 adapter。

验收记录须分别标明模块／真实 runtime／外部协议互操作已通过什么；没有外部调用和真实持久化证据，不能仅凭 fake、文档校验或 SDK 示例宣称模块验证完毕。WSS 与生产平台认证仍另行验收。

## 后续部署：WSS 接入与现有运行场景

以下保留整体部署职责和既有场景图，说明模块后续如何接进服务端；**WSS 是后续传输方案，不是本阶段模块验证的前置条件**。外部标准 HTTP client 可以验证本模块，但不能直接连接自定义 WSS binding。

部署前提见[核心 · 服务端部署与持久化](./核心-服务端部署与持久化.md)：Console API、网关和图 worker 分开运行，多台 Compose 共享 PostgreSQL、Redis 与文件存储；当前单机 Nginx 仍是入口单点。本章只规定跨端任务行为，不把容器重启解释为桌面任务恢复。

## 三层职责：网络、协议、执行

![网络、A2A 与 Agent 执行分开](./assets/a2a/layers.svg)

[打开职责图](./diagrams/a2a/layers.html)

| 职责 | 负责什么 | 关键边界 |
| --- | --- | --- |
| WSS 网络传输 | 客户端主动连接、身份认证、心跳、退避重连、有界收发、连接与流清理 | 不装配 Agent，不判断业务终态，不因断线取消运行；发送成功不表示结果已交付 |
| A2A 协议与任务处理 | 标准操作与对象校验、`tenant` 路由、`messageId` 持久去重、Task 状态、订阅与查询、结果交付 | 在受理前检查授权；执行前受理落盘；重投只返回原 Task；执行状态与交付状态分开 |
| Agent 执行 | 复用现有装配、并发准入、LangGraph、模型、MCP、Playwright、取消排空与执行证据 | 接收明确输入和固定版本；不接触 socket 或原始网络报文；不自建第二套调度器 |

这些是职责边界，共用一个 Node runtime，不要求新增独立服务、通用容器或每个 Agent 一条连接。Rust 继续承担原生宿主与系统能力。

服务端 Agent 是 **A2A Client**，桌面 Agent 是 **A2A Server**；这与桌面主动建立 WSS 的网络方向不同。每个官方 `agentId + contentId` 对应一个逻辑入口和标准 AgentCard，复用官方目录；多个入口共享同一 WSS。请求携带所选 AgentCard 接口的标准 `tenant` 路由值，由 A2A 适配层解析；真实组织、用户与安装权限来自可信接入上下文（WSS 阶段由已鉴权连接提供），不由 `tenant` 自行声明。

## 完整链路：服务端 graph 节点调用确定版本的桌面 Agent

服务端复杂 graph 的远端调用节点通过 A2A Client 调用桌面能力，将节点输入与所需业务上下文映射为标准 Message 的 Data Part。节点绑定官方 `agentId + contentId` 和目标安装，从官方目录取得该确定版本的 AgentCard；若配置使用发布标签，先解析并固定为 `contentId`，后续发送、重投和结果处理均沿用原版本。不存在、未授权或不兼容时明确失败，不自动替换为最新版。

**前提：** 桌面已经主动建立并鉴权 WSS，双方完成协议、绑定与必需扩展协商。下图展示一次成功调用的目标完整链路；泳道表示职责，服务端 A2A 层和 WSS 网络模块可以共处网关进程。

![服务端 graph 节点选择确定版本、经 A2A 执行并持久交付结果](./assets/a2a/full-chain/invoke.svg)

[打开服务端 graph 到桌面 Agent 的完整顺序图](./diagrams/a2a/full-chain/invoke.html)

**调用先落盘。** 节点把服务端 run／步骤、目标安装、确定版本、稳定 `messageId` 和不可变输入关联到共享 PostgreSQL，再通知网关发送。桌面生成 `taskId`，服务端收到首条受理 Task 后保存映射。调用意图与结果都不依赖原 worker 中等待响应的 Promise；通知漏发由持久待处理记录对账补齐。换 worker 或网关仍使用原消息身份，不能把重投变成新一次执行。

**桌面独立装配和执行。** 桌面 A2A 层检查入口授权、持久去重与容量，受理落盘后才调用执行层。执行层为该 Task 创建独立 thread、run、graphThreadId 和 Chrome 页面，校验确定版本的 `agent.json`、`prompt.md` 及其引用的完整 Skill 包，再将准备好的 Agent 能力交给本地执行图节点。物料从已验缓存或既有版本同步取得，桌面不挂载服务端 NFS。服务端 graph 不包含业务 Prompt 副本，A2A 消息不传运行时对象、模型凭据或隐式会话现场；装配关系见[Agent 版本管理](./前置-Agent版本管理.md#装配关系版本物料在图外能力交给图节点)。

**结果落盘后交付，原图幂等推进。** 桌面先保存唯一终态、最终 Artifact 和执行记录，结算并释放容量，再发送结果。服务端校验协议对象与结果摘要；引用附件时先持久接收文件并建立授权索引，再在同一 PostgreSQL 事务中保存原 Task／结果索引与待推进记录，提交后调用唯一业务扩展 `omniops/ConfirmTaskDelivery`。桌面持久保存匹配原 Task 与摘要的确认后才响应成功。后续节点校验业务结果 schema、从已保存结果映射输入，复用原运行队列、运行互斥与幂等推进；交付确认和后续推进各自重试，不要求确认往返成功后才能消费已持久结果，也不依赖最初 worker 仍存活。

复杂 graph 的代码仍由应用发布管理，不进入 Agent 资产内容版本。上图以 `COMPLETED` 为正常路径；`REJECTED`、`FAILED`、`CANCELED` 同样保存并交付原终态，由服务端图走既有业务分支。业务结果 schema 校验失败也由服务端节点处理，不改写桌面终态或自动重跑 Task。缺输入或登录失败后的显式再次执行使用新 `messageId`；断线恢复沿用原 Task 的查询／订阅与交付确认，详细边界见下列场景。

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

本阶段已实现并验证模块，沿用本地执行记录和既有观测边界，不新增日志、span 或指标。A2A 原始 Message、Artifact、提示词和完整错误来源链不作为遥测输出。

官方 TS SDK 1.3.0 的高层 client 会把 data:null 解码为缺失，本阶段没有 fork 或 monkey-patch。存储适配在 SDK 公开读取边界保留 null，外部验收另以标准线上报文核对 null；0／false 可直接经高层 client 读取。此上游限制、临时 HTTP 宿主与未覆盖平台均在验收记录中单独列明，不宣称生产 WSS 或所有 client 已兼容。
