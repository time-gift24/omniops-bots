## ADDED Requirements

### Requirement: Public exports and construction form one complete contract

拟公开模块 SHALL 仅导出 createA2AService、A2AService 与 contract.md 定义的配置／上下文／回执相关类型；协议方法 SHALL 直接使用 SDK A2ARequestHandler 完整签名。A2AService SHALL 仅增加 protocolFor、confirmTaskDelivery 和本地 close，不另暴露 store、数据库、执行桥接或手写逐方法 facade。构造 SHALL 验证 directory、runtime、resolveEndpoint 与必填有限 limits；可选构造 signal SHALL 只取消等待／后续步骤，不伪称已撤销同步 SQL。初始化、SDK／项目 schema 检查和重启收敛提交成功前 SHALL 不返回可用服务。

#### Scenario: Construction is canceled or fails after opening storage

- **WHEN** 构造已取得自有 SQLite 资源，但初始化失败或构造 signal 取消
- **THEN** 清理已取得的自有资源，不返回半初始化对象、不关闭借入 runtime、不删除已有数据或伪造升级回滚

#### Scenario: Required limits are missing

- **WHEN** 请求／Task 字节、JSON 深度或等待／订阅限额缺失、非正安全整数
- **THEN** 构造以安全 invalid-request 拒绝，不以无限缺省值开放服务

### Requirement: SDK call contexts preserve route and identity boundaries

每个 RPC SHALL 使用独立 ServerCallContext，显式版本 1.0、协商扩展及可信 principal；userName SHALL 使用 contract.md 固定的可信组织／caller／安装派生格式，与 SDK owner 及 ResultManager 锁一致。protocolFor SHALL 只返回固定入口绑定的 SDK handler，不创建 Task／预留。SDK transport 设置 tenant 时 SHALL 不预设 tenant，本地直接调用 SHALL 仅设置一次；params、context 与绑定入口 SHALL 一致。resolveEndpoint SHALL 只做目录／授权，不装配图或因材料缓存缺失阻断历史读取。

#### Scenario: SDK transport receives a fresh context

- **WHEN** adapter 取得 protocolFor 返回的 handler 并调用 SDK JsonRpcTransportHandler
- **THEN** 使用初始 tenant 未设置的本次 context，由 SDK 设置一次；不能复用上次 context 或用正文指定身份

#### Scenario: A previously returned handler is used after closing starts

- **WHEN** 应用已开始服务 close，调用者持有旧 handler
- **THEN** 仍拒绝新调用，包括 getTask、getAgentCard 和订阅，不因 handler 提前取得而绕过 closing

### Requirement: Error classes distinguish local lifecycle from accepted task outcomes

构造／close SHALL 复用 RuntimeError 的安全 kind/message，协议边界 SHALL 转成 SDK 公开错误类；通用 A2AError 的受控 metadata.category SHALL 限定为 authentication、forbidden、storage、resource-limit、unavailable、aborted、unknown。本地依赖错误与来源 SHALL 不直接序列化。运行已受理后的失败 SHALL 形成 Task 终态，结果非 JSON／超限 SHALL 以安全 FAILED/invalid-output 结算，不截断伪造业务结果。受理前 SHALL 确认能够在 Task 字节预算内保存安全失败终态。

#### Scenario: Completed runtime output cannot fit the task result contract

- **WHEN** 图已实际结束但 output 非合法 JSON、过深或无法放入终态预算
- **THEN** 保存原 Task 的 FAILED/invalid-output，不重新执行、不截断后报告 COMPLETED；仍遵守终态提交后释放容量

### Requirement: Official SDK implementations are reused before custom protocol code

A2AService SHALL 采用官方 @a2a-js/sdk，先不 fork；协议类型、ProtoJSON、标准错误、JSON-RPC 分发 SHALL 直接复用，不建立平行协议库。设计 SHALL 优先复用 DefaultRequestHandler 的 getTask/listTasks/resubscribe、扩展卡片及四个推送配置操作，另复用 getAgentCard；共同授权／closing／输入检查 SHALL 不被省略。只有发送两方法及 cancelTask 的已核验行为差异需要定制；SHALL 使用 SDK AgentExecutor、ResultManager、TaskStore 和事件总线／队列，不整套重写请求处理器、事件合并器或图执行器，不访问 SDK 私有成员。

#### Scenario: Optional capabilities are disabled through SDK behavior

- **WHEN** 首版 AgentCard 禁用 pushNotifications 与 extendedAgentCard，合法请求到达对应方法
- **THEN** 复用 SDK DefaultRequestHandler 的标准不支持响应，不另写方法分发表或成功占位结果

#### Scenario: Custom send preserves the SDK runtime boundary

- **WHEN** 新消息需要持久去重和容量预留
- **THEN** 差异发送路径先提交受理，再经 SDK AgentExecutor 薄桥接调用既有 RunReservation；业务图仍由现有 runtime/execution 执行

### Requirement: SDK result processing uses one durable TaskStore

Task 更新 SHALL 复用 ResultManager.processEvent，TaskStore.save/load/list SHALL 复用 SDK DatabaseTaskStore 的公开 Kysely 事务组合，保持一个权威本地存储，只新增一张项目表保存消息身份／运行关联、封存摘要和回执；SHALL 不手写 Task CRUD／分页或擅自迁移 checkpoint。SDK 的进程内串行合并 SHALL 不被宣称为 messageId 原子受理、完整终态封存或交付事务；项目 SHALL 只补这些缺口以及重启收敛。完整终态及 Artifact SHALL 一次经 ResultManager 的 Task 事件保存，TaskStore.save 同次计算摘要并封存；SHALL 不先提交终态再补 Artifact。SDK 允许的同终态更新、迟到 Artifact 或完整 Task 覆盖 SHALL 不能修改已封存结果。

#### Scenario: Late SDK event targets a sealed result

- **WHEN** 原终态已经持久封存，随后发生同状态更新、Artifact 更新或完整 Task 重投
- **THEN** 统一 TaskStore 写入口保留原状态时间、Artifact 和摘要，不以 SDK 允许事件合并为由更改结果

#### Scenario: There is no stream consumer

- **WHEN** 请求断开且没有活动订阅，已受理的运行完成
- **THEN** 服务拥有的后台 Promise 仍 await ResultManager 和 TaskStore 保存完整结果，再释放容量和广播；没有消费者不阻止结算，不新增第二个写入存储

### Requirement: SDK database operations share the actual Kysely transaction

系统 SHALL 在 db.transaction().execute 的回调中用 trx 构造 DatabaseTaskStore；该事务的项目表操作 SHALL 同样使用 trx，不使用根 db／根 store。ResultManager Task 锁 SHALL 先于数据库事务获取，不在事务中 await processEvent 或嵌套自动开事务的 TaskStore.save。可信 context.user.userName SHALL 与 SDK owner 及 ResultManager 锁作用域保持一致，不回退 unknown。

#### Scenario: Acceptance commits both identities atomically

- **WHEN** 新 messageId 通过事务内去重检查并预留容量，SDK Task 或项目身份行任一保存失败
- **THEN** 整个事务回滚，不启动执行；只有同指纹的已提交原记录可作为重试结果，SQLite BUSY 不映射运行容量 busy

#### Scenario: A transaction cannot wait on its root connection

- **WHEN** 受理、封存或确认事务需要读写标准 Task
- **THEN** 只调用绑定当前 trx 的 SDK store，不等待根句柄或在该事务内调用 ResultManager；运行、网络及交付等待均不占数据库事务

### Requirement: Message identity and terminal seal live in one project extension row

项目表 SHALL 以组织／调用方／安装／messageId 为主键，并以 tenant／owner／taskId 唯一关联 SDK Task；指纹 SHALL 包括不可变目标版本。同一事务 SHALL 在未占容量前查重，后续仅新消息预留。resultSha256 为空 SHALL 表示未封存，非空 SHALL 表示对应 Task 已终态且不可变；不一致 SHALL 安全拒绝，不能覆盖修复。SDK Task 是唯一结果，项目表 SHALL 不存另一份可变 Task。

#### Scenario: Terminal Task and seal cannot split

- **WHEN** 完整终态 Task 的 SDK save 已执行，但封存 SHA 更新失败
- **THEN** 回滚 Task 和项目行的整个事务，不发布终态或释放容量；不留下终态无摘要的成功记录

#### Scenario: A repeated seal proposes different metadata

- **WHEN** 已封存 Task 收到相同交付摘要但不同 history／metadata 的再次保存
- **THEN** 比较完整规范化 Task 后拒绝改变，不能仅凭排除了这些字段的交付摘要认定相同；完全相同则不写入不广播

### Requirement: Delivery confirmation updates only receipt fields

确认 SHALL 在短事务内核验可信归属、SDK 完整终态、封存摘要和请求 SHA。第一次确认 SHALL 仅保存项目表 receivedAt，提交后返回成功；匹配重试 SHALL 保留第一次 receivedAt 并返回相同结果，不调用 SDK save，不改变 Task、摘要、Run 或幂等身份。

#### Scenario: Confirmation is concurrent or retried with another timestamp

- **WHEN** 相同 Task 和 SHA 的确认并发到达或以另一 receivedAt 重试
- **THEN** 只有第一次确认时间持久生效，后续返回相同 taskId／SHA；错摘要拒绝，提交失败保持待确认，不执行图

### Requirement: SDK database corruption and lock waits remain safe

SDK list 的坏行吞错／原始 console 输出 SHALL 通过公开查询结果校验边界阻止，而非只依赖外层 catch。方案 SHALL 优先用 KyselyPlugin.transformResult、公开 TaskRow 与 Task.fromJSON，校验实际返回列后原样交回 SDK，不重写查询或分页；错误只报告安全存储分类。A2A SQLite 连接 SHALL 显式配置有限锁等待，首版建议 timeout=0；同步 SQL 不被宣称可由 signal 硬中断，不自动重试图或模型。

#### Scenario: A list page contains a corrupt JSON column

- **WHEN** SDK Task 查询结果中某个实际返回列不可解码
- **THEN** 在进入 SDK 逐行吞错分支前安全拒绝整个查询，不跳过坏行返回成功，不输出原始内容；count／投影缺列与其他表不能被误判为坏 Task

### Requirement: SDK subscriptions observe committed and bounded events

订阅 SHALL 复用 SDK 默认总线、队列与 resubscribe 的监听／快照流程，总线 SHALL 只发布已提交状态。每条流 SHALL 只有一个当前 Task 首帧，不在共享总线重复广播初始 Task；共享总线每 Task SHALL 最多产生一次停止提示、一个最终 Artifact 和一个终态状态，不流式转发 token／工具进度；事件字节与活动流数 SHALL 有界。SDK 队列无原生容量和 AbortSignal SHALL 明确说明；等待信号 SHALL 通过公开 ExecutionEventBusManager 注入的每调用 SDK 总线结束，外层 finally 清除转发，只释放该消费者，不结束共享执行总线，不以 Promise.race 冒充解绑。

#### Scenario: A waiting subscriber disconnects

- **WHEN** 某次订阅的 next 正在等待而连接断开或 signal 取消
- **THEN** 该调用总线结束并移除 SDK 队列与转发监听；原执行、持久化及其他订阅继续

### Requirement: Runtime business sources use TypeScript consistently

`desktop/runtime/` 业务源码 SHALL 统一使用 TypeScript 和 ESM，包括入口、runtime 协调、聊天、资源、配置、浏览器及 A2A 模块；SHALL 遵守严格类型检查、可擦除语法及随包 Node 直接加载约束。实施迁移时 SHALL 同步导入、配套测试、类型检查及打包／宿主入口，不通过 any 或关闭检查掩盖类型问题。本阶段 SHALL 同步完成业务源码、导入及随包入口迁移。

#### Scenario: Renamed runtime entry remains usable

- **WHEN** 后续获准迁移业务源码，入口由 main.mjs/runtime.mjs 改为 main.ts/runtime.ts
- **THEN** 运行、测试和交付包引用同一有效 TS 入口，现有本地业务保持行为，TS 检查覆盖迁移模块

### Requirement: A2AService exchanges business data with runtime

已确认的内部边界 SHALL 是同进程调用：A2AService 传 threadId、runId、确定官方 agentId/contentId 及显式业务 JSON input；runtime SHALL 在内部装配、映射并执行原生图，返回复用 ExecutionOutcome 的运行身份、JSON 业务 output 或受控 ExecutionError。A2AService SHALL 不传 RPC、Task/Message、graph、模型对象或 prepare/settle 回调，不覆盖本机模型及兜底超时。共享名额 SHALL 经 reserveRun 预留，使用 execute/requestStop/release 控制；先保存受理再执行，保存终态后释放。本轮不绑定具体业务 schema，新增错误分类仍待讨论，不视为已实施。

#### Scenario: Structured task reaches a non-chat graph

- **WHEN** A2AService 从合法 Part 提取显式业务 input 并调用预留对象的 execute
- **THEN** runtime 按通用 JSON 边界验证并映射图输入／输出，不要求图包含 messages，也不预设业务字段；A2AService 将 output 包成 Artifact 后持久保存终态

#### Scenario: Input failure and credential requirement stay distinguishable

- **WHEN** runtime 发现缺少业务输入或需要人工登录
- **THEN** 返回受控 missing-input 或 login-required 错误分类供 A2AService 保存 FAILED，不要求它解析异常来源链或读取模型正文

### Requirement: Public task operations remain separate from transport and graph execution

A2AService SHALL 与官方 1.0 service 的 11 个标准操作逐一对应，包括四个推送配置操作；禁用推送时 SHALL 明确返回 PushNotificationNotSupportedError，不忽略为未知方法或伪造成功。唯一交付确认 SHALL 标明项目扩展，close SHALL 只用于本地生命周期。原始 RPC、socket 和重连 SHALL 留在传输 adapter；图执行 SHALL 复用现有 execution，不将 A2A 消息伪装成聊天 IPC。默认 SendMessage SHALL 等待终态；需求中的受理即返回调用 SHALL 显式设置 returnImmediately。

#### Scenario: Nonblocking submission and disconnected waiter

- **WHEN** 已授权调用者使用 configuration.returnImmediately 为 true 的标准 Message，随后连接断开
- **THEN** 服务在受理落盘后返回 Task；断开只移除等待或订阅，已受理执行继续

#### Scenario: Blocking default

- **WHEN** 调用者省略 returnImmediately 且任务尚未终态
- **THEN** SendMessage 等待原 Task 终态；等待被取消不等同于 CancelTask

#### Scenario: Push capability is disabled

- **WHEN** 合法调用者请求四个标准推送配置操作中的任意一个，首版卡片声明 pushNotifications 为 false
- **THEN** 返回标准 PushNotificationNotSupportedError，不创建配置、不发送 webhook、不返回空列表成功

### Requirement: Generic JSON stays in the standard data part

待确认的通用单 Part 映射 SHALL 直接把 runtime JSON output 放入标准 Part.data；协议类型 SHALL 保留官方 google.protobuf.Value 的完整 JSON 能力，不增加强制 result 信封。input 顶层对象与 JSON 内容模式 SHALL 明确为本项目入口约束，不宣称官方只允许对象或单 Part。

#### Scenario: Output contains a false-like JSON value

- **WHEN** runtime 成功返回 0、false 或 null
- **THEN** 最终 Artifact 的 Part.data 保留该 JSON 值，不因真假判断省略，不额外包 result 字段

### Requirement: Authorized immutable endpoint and explicit business input

A2AService SHALL 基于可信上下文验证组织、调用方、安装及 tenant 对应的确定官方 agentId/contentId；消息正文 SHALL 不能声明身份、覆盖本地 Provider 或替换 Agent 版本。input/output SHALL 保持通用 JSON，经运行入口显式映射而不预设业务 schema；contextId 只作业务关联，不复用会话现场。

#### Scenario: Endpoint material missing

- **WHEN** 已受理的固定版本材料缺失、损坏或无法装配
- **THEN** 原 Task 保存 FAILED 与安全原因，不选择本地草稿或最新版，也不重跑

#### Scenario: Untrusted identity

- **WHEN** 请求只在正文声明调用主体或越权 tenant
- **THEN** 返回安全协议错误且不创建 Task 或执行资源

### Requirement: Durable message identity precedes execution

系统 SHALL 在组织、调用方与安装范围内，以 messageId 原子保存唯一受理决定及原调用摘要。去重 SHALL 先于新容量检查；摘要 SHALL 包括入口、版本及不可变业务输入，排除 RPC id 和等待／订阅参数。执行 SHALL 仅在受理持久提交后开始。

#### Scenario: Concurrent duplicate and conflicting input

- **WHEN** 同一 messageId 并发重投，RPC id 不同
- **THEN** 相同内容取得同一 Task；不同内容返回协议冲突，最多启动一次执行

#### Scenario: Acceptance write fails

- **WHEN** 已预留名额但受理记录保存失败
- **THEN** 释放未启动预留、返回安全存储错误，不装配 Agent、不启动图或页面

### Requirement: Local and remote work share admission and independent identities

本地、实验和远端 SHALL 共用当前 runtime 的并发设置，默认 4、允许 1～64；预留、准备、执行、取消排空与本地终态提交 SHALL 占用名额。忙时 SHALL 持久保存 REJECTED/busy，不排队。受理 Task SHALL 独立拥有 threadId/runId，由 execution 生成 graphThreadId 并绑定专用 Chrome 页面。

#### Scenario: Local work fills capacity

- **WHEN** 本地运行已占满当前额度，新的合法远端消息通过去重检查
- **THEN** 保存可查询且可确认的 REJECTED/busy，不创建 thread、run 或 Chrome 页面；原消息重投仍取得原拒绝

#### Scenario: Settings become unavailable

- **WHEN** runtime 没有可信有效的并发设置或正在关闭
- **THEN** 拒绝新增受理，不以 busy 或默认设置伪装配置故障

### Requirement: Cancellation respects the actual result fixation boundary

CancelTask SHALL 在仍可取消时同步发起停止意图，排空期间返回 WORKING 与正在停止说明；排空、唯一终态保存后才公开 CANCELED。结果在 execution 进入 settle 前固定后 SHALL 拒绝取消；取消 SHALL 不回滚外部操作，不以 UI 状态推断成功。

#### Scenario: Stop races with settlement

- **WHEN** 取消到达时执行结果已经固定但终态 Task 尚未提交
- **THEN** 返回 TaskNotCancelableError，保留原结算结果，不将其改成取消

#### Scenario: SDK cancellation defaults do not define product success

- **WHEN** Task 没有可证明的活跃运行归属，或 Task 已终态，包括已 CANCELED
- **THEN** 不进入 SDK 默认“没有总线直接写 CANCELED”的路径；缺失归属返回安全不可用，终态返回 TaskNotCancelableError，重启遗留则先按恢复策略收敛

#### Scenario: Accepted cancellation drains

- **WHEN** 可取消 Task 收到取消且外部操作尚未排空
- **THEN** 仍占名额并报告 WORKING；排空和取消终态落盘后只释放一次名额，其他 Task 继续

### Requirement: Terminal publication and receipt are separate durable boundaries

服务 SHALL 先完成 Run 结算，再持久提交不可变终态 Task/Artifact，释放运行容量后发布终态。交付等待 SHALL 不占运行容量。扩展 SHALL 使用 RFC 8785 规范化终态公开投影的 SHA-256，匹配的确认保存成功后才返回成功；确认 SHALL 不改写执行状态或终态投影。

#### Scenario: Receipt is retried or mismatched

- **WHEN** 同 Task 同摘要重复确认，或收到不同摘要
- **THEN** 匹配重试返回相同成功结果；不匹配返回安全协议错误，不覆盖结果或确认

#### Scenario: Final persistence fails

- **WHEN** 图已完成但 Task 终态保存失败
- **THEN** 不发布完成、不释放该预留，A2AService 暂停新增远端受理；保留候选结果供持久化恢复，不重跑图

### Requirement: Restart restores records without replaying work

服务构造 SHALL 在开放请求前恢复完整记录；原终态与摘要 SHALL 保持不变，遗留非终态 SHALL 持久收敛为 FAILED/interrupted-unknown。恢复 SHALL 不装配 Agent、创建页面、调用模型或恢复 checkpoint；去重身份 SHALL 不因确认或重启删除。

#### Scenario: Process ended after execution but before terminal commit

- **WHEN** 重启发现 Task 仍非终态，即使 Run 记录可能已完成
- **THEN** Task 保存 FAILED/interrupted-unknown，说明外部操作可能发生，不重建成功结果或执行

#### Scenario: Terminal task awaits receipt

- **WHEN** 重启恢复未确认终态
- **THEN** GetTask 返回原结果与原摘要，继续确认而不创建执行资源

### Requirement: Bounded subscriptions, safe errors and coordinated shutdown

订阅 SHALL 首先提供当前快照、保持该流顺序并在终态结束；已终态订阅 SHALL 返回标准不支持错误供调用者转 GetTask。队列、消息和活动流 SHALL 有明确上限；慢连接 SHALL 不阻塞执行结算。关闭 SHALL 停止新受理，排空现有执行与持久写入，再释放共享依赖；未知错误 SHALL 仅返回安全分类和摘要。

#### Scenario: Terminal transition races with subscription

- **WHEN** 建立订阅时任务恰好终态
- **THEN** 调用者取得终态快照或明确错误后 GetTask，不挂起等待不会再到达的事件

#### Scenario: Slow transport and shutdown

- **WHEN** 输出背压或连接故障期间关闭 runtime
- **THEN** 结算不等待网络容量，不通过 stdout 输出业务日志，不自动重试模型；在退出预算内保存可用证据并清理资源

### Requirement: Task persistence does not expand telemetry

首版 SHALL 沿用已确认的 Task/Run 持久记录和安全错误边界，不新增日志、span 或指标；协议正文、提示词、回复、凭据与完整来源链 SHALL 不进入遥测。

#### Scenario: Failure contains sensitive dependency data

- **WHEN** 模型、存储或协议依赖失败并包含原始内容
- **THEN** 对外只报告受控安全错误，内部来源不直接输出为日志或 Task 正文

### Requirement: Public reads and waits have explicit ownership

待确认的操作细化 SHALL 保持 GetTask/ListTasks 只读，返回授权范围内已提交的独立快照；流的第一次 next 才建立受理／订阅，SDK context.state 中的受控等待 signal 与 return 只取消该次等待；本地装配／确认另使用 CallOptions.signal。ListTasks SHALL 沿用标准过滤与分页，省略 Artifact 的列表投影 SHALL 不能用于计算完整交付摘要。已有 Task 的执行与结算 Promise SHALL 归 A2AService 跟踪，不依赖某次请求存活。

#### Scenario: Wait ends after acceptance

- **WHEN** sendMessage 已持久受理后，请求 signal 取消或 WSS 断开
- **THEN** 释放该次等待或流，原 Task 继续执行与结算；原 messageId 重投仍取得原 Task

#### Scenario: Listing omits artifacts

- **WHEN** ListTasks 未指定 includeArtifacts 为 true
- **THEN** 返回项省略 artifacts；需要计算交付摘要的调用者使用完整 GetTask，读取本身不标记已交付

### Requirement: Protocol failures do not replace accepted task settlement

待确认的错误细化 SHALL 在 Node 内复用 RuntimeError／ExecutionError，在 SDK handler 边界转成其公开标准错误类和安全摘要，由 SDK 统一序列化；受理后 ExecutionOutcome 的失败 SHALL 结算原 Task，不仅以请求错误结束。受理、终态、确认三个持久化边界 SHALL 各自报告真实提交结果；未知来源和完整错误链 SHALL 不直接发送调用者。

#### Scenario: Confirmation persistence fails

- **WHEN** 原终态及摘要已经提交，但本次交付确认保存失败
- **THEN** 原结果继续可查，保持待确认并拒绝本次调用；重试同 receipt 不触发执行

### Requirement: Service shutdown is distinct from disconnect and runtime shutdown

需求已有正常退出规则 SHALL 保持：有运行任务时先阻止并提示等待，网络断开／关闭调试视图不停止运行。待确认的 close 细化 SHALL 只用于最终退出流程，不新增独立停用服务功能或远端关闭方法；开始时封闭 A2AService 公开调用，停止并排空剩余归属远端 Task，保留已固定结果，SHALL 不自行关闭共享 runtime。close SHALL 接收入口提供的同一进程绝对 deadline，幂等复用第一次操作，不等待网络交付确认；失败或预算耗尽 SHALL 拒绝 Promise，不伪造清理成功。应用入口 SHALL 无论 A2AService 关闭成败都用同一截止时间继续关闭 runtime 及存储，汇总实际错误。

#### Scenario: Application enters final shutdown

- **WHEN** 入口已进入最终退出流程并调用 A2AService.close
- **THEN** A2AService 结算归属自己的远端运行，入口随后关闭 runtime 和共享资源；断开单个 WSS 不触发该流程

#### Scenario: Shutdown budget expires

- **WHEN** 关闭期间某项实际工作或持久写入未在共用 deadline 前完成
- **THEN** close 报告失败，保留真实记录与任务归属，不将停止等待当作已经撤销操作；后续阶段不重置预算，重启不重放遗留任务

### Requirement: Shutdown owns only the service database and uses one budget

close SHALL 校验本进程绝对 deadline 并复用首次有效关闭工作；无效参数 SHALL 不启动首次关闭，后续 deadline SHALL 不延长预算。开始 SHALL 围住在途受理／回执提交，未提交受理不启动，刚提交的任务纳入结算。清理消费者、实际运行、Run／Task 提交后 SHALL 由 Kysely 关闭自有 SQLite，不能在事务进行中销毁或重复关闭底层句柄。借入 runtime／checkpoint SHALL 留给应用入口关闭。固定候选终态的关闭收尾 SHALL 最多再尝试一次原结果存储，不重跑图；预算耗尽仍保留真实归属，不假报 closed。

#### Scenario: Submission commits as shutdown begins

- **WHEN** close 与受理事务提交竞争
- **THEN** 未提交则回滚并释放未执行预留；已提交则纳入 close 的停止／固定结果结算，不能遗漏该 Task 或重启执行

#### Scenario: A database transaction outlives the deadline

- **WHEN** 已开始的同步存储操作无法在同一 deadline 前结束
- **THEN** close 报告 timeout 并保持入口封闭和工作归属，不在进行中销毁连接；应用入口继续其他关闭阶段且不重置预算

### Requirement: Independent external A2A validation precedes WSS integration

模块验收 SHALL 先使用标准 JSONRPC／1.0 HTTP 入口和 SSE，不依赖 WSS／网关／Console。宿主 SHALL 优先复用 SDK agentCardHandler／jsonRpcHandler，临时 loopback 监听并使用可信测试身份和独立 context；A2AService SHALL 不依赖 Express 或硬编码 WSS binding。外部 Agent SHALL 在独立进程通过 SDK ClientFactory 和公开卡片完成标准操作；唯一 receipt 扩展单独声明／调用，不重写标准 client。

#### Scenario: External agent completes a task without WSS

- **WHEN** 独立外部 Agent 读取 JSONRPC／1.0 卡片并提交通用 JSON 输入
- **THEN** 经真实 service／runtime／LangGraph／SQLite 和本地模型 fixture 取得终态 Artifact，查询同一 Task，持久保存原结果后确认 receipt；不经 WSS 或内部对象访问

#### Scenario: Binding validation stays at the transport boundary

- **WHEN** 标准 HTTP 入口或后续 WSS 入口选择卡片的实际 binding
- **THEN** transport 调用 SDK validateVersion 对版本／binding 配对校验；service 只校验版本、卡片、扩展和身份，不将 WSS URN 固化到核心公开方法

### Requirement: Black-box acceptance requires three distinct evidence layers

验收 SHALL 分别记录真实 SDK／SQLite 加小型 runtime fake 的模块行为、真实 runtime／LangGraph 加本地模型 fixture 的执行集成、独立外部 client 经标准 HTTP/SSE 的协议互操作。SHALL 覆盖成功、持久去重／busy、隔离与错误、取消／断开、事务失败／冻结／receipt、进程重启及关闭预算；文档和图形检查 SHALL 不代替运行证据。后续 transport SHALL 仅通过公开 service／SDK handler 接入，不操作私有 Task 表或重写任务语义。

#### Scenario: Fake tests pass but real runtime has not been exercised

- **WHEN** 只有进程内 fake 或文档校验通过
- **THEN** 仅报告对应层证据，不宣布模块完整验收或外部兼容通过；WSS 联调延后也不取消真实 runtime 和独立外部调用要求

#### Scenario: External client rejects an unsupported capability locally

- **WHEN** SDK 高层 client 根据卡片在发送前拒绝 push 等可选操作
- **THEN** 该异常只证明 client 行为；Server 标准拒绝路径须通过 SDK 公开 transport 或受控标准请求真正到达服务另验
