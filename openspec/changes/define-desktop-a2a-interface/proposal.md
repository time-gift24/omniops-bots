## Why

`docs/requirements-walkthrough/` 已描述 A2A 的目标行为，但尚无可评审的 Node 模块调用契约；当前 runtime 启动入口绑定聊天输入，也没有远端 Task 的持久身份和交付状态。先确定协议、执行及持久化边界，避免接入时重复建设调度器或破坏现有取消与并发语义。

## 本阶段实施状态

用户已明确要求按本提案实现 A2AService，先不接 WSS；以下保留提案阶段的范围与选择依据，涉及“本轮不实现／不安装”的限制已由本次实施指令在模块范围内替代。实际实现、SDK 实测差异和通过范围见 [verification.md](verification.md)。

## What Changes

- 本轮只产出接口讨论稿、需求场景与后续任务，不创建实现、空模块或依赖，不修改已有项目规范。
- 名称统一为 A2AService，对应需求串讲“A2A 协议与任务处理”；Task 的管理属于其内部职责，不新增独立的任务服务层。
- 已确认本轮先讨论 A2AService与 runtime 边界；提议服务公开标准操作与唯一交付确认扩展。当前先让外部 Agent 通过标准 A2A 接口完成任务，独立验证模块后作为黑盒接入；WSS 连接设计暂缓，不作为本阶段前置条件。
- 已确认 `desktop/runtime/` 的业务源码统一使用 TypeScript，包括入口、runtime、聊天、资源、浏览器及新 A2A 模块；使用 ESM 和随包 Node 可直接加载的可擦除类型语法。迁移及导入、测试和打包入口调整均属于后续实现，本轮只记录决定。
- 已确认在现有 runtime 内开放共享容量预留与非聊天图执行入口，继续复用 `createExecution` 的生命周期；通过预留对象 execute/requestStop/release 执行、请求停止及释放名额。
- 已确认数据边界：A2AService向 runtime 传独立 threadId/runId、官方 agentId/contentId 和结构化业务输入；runtime 返回现有 ExecutionOutcome 形状的运行身份、业务输出或受控执行错误。图、模型、MCP、浏览器与 prepare 回调留在 runtime 内；A2AService负责 Message/Artifact 转换和终态持久化。
- 已确认本轮不绑定具体业务 Agent，保持 input 为 JSON 对象、output 为 JSON 值；不把业务 schema 作为讨论通用接口的前置条件，也不默认转成聊天输入。
- 补充待确认的公开操作行为、统一请求等待取消、协议错误／执行失败／存储失败分层，以及带同一退出截止时间的关闭契约；最终应用退出阶段建议停止并排空归属远端 Task；正常退出先阻止并提示等待，连接断开则继续运行。
- 已核对官方 A2AService 的 11 个标准操作，补齐首版禁用的四个推送配置操作的标准不支持返回；标准对象直接复用 Part.data 的 JSON 能力，不另加 result 包装。WSS、交付确认扩展和本地 close 分别标明，不声称整个模块与官方接口原样相同或已完成兼容验收。
- 已确认采用官方 @a2a-js/sdk，先不 fork；本提案以核验过的 1.3.0 发布包为接入基线，声明 A2A 协议版本仍为 1.0。直接复用协议类型、ProtoJSON、标准错误模型和 JsonRpcTransportHandler，A2AService 的协议实现遵循 SDK A2ARequestHandler，不维护平行的逐方法协议接口。
- 最大限度复用 SDK 实现：DefaultRequestHandler 保留 8 个标准操作，只替换发送两方法和取消；继续用 AgentExecutor、ResultManager、TaskStore、默认事件总线及队列，项目只补强去重／准入、后台持久化归属、终态封存、授权、交付确认和关闭。三个替换方法均有已核验行为差异，不整套重写处理器，不复制私有实现或 fork。参考开源 A2A + LangGraph 接法，不引入第二套图执行器或独立 TaskService。
- 用户已确认 SDK Task 表＋一张项目扩展表；已核验 DatabaseTaskStore 可接 Kysely Transaction，项目表承载消息身份／运行关联、封存摘要和回执。受理、完整终态、回执分别用短事务提交；不手写 Task CRUD／分页或修改 SDK 私有实现，锁顺序与坏行安全检查须在后续运行验收。
- 定义固定官方版本、持久去重、忙时拒绝、取消竞争、重启收敛、不可变结果及交付确认契约。
- 明确 `SendMessage` 的标准阻塞默认值，受理即返回使用 `configuration.returnImmediately: true`。
- 已确认项按上述范围记录；其他公开操作与故障／关闭细节仍待讨论，具体业务 schema 留给后续业务接入。没有后续明确实施指令，不进入实现。

- 保留 [wss-contract.md](wss-contract.md) 作为后续接入草案；本阶段不确定连接实现、ws 依赖或网关联调参数。A2AService 不硬编码 WSS binding，协议绑定配对校验属于 transport。
- 补齐外部 Agent 独立验收方案：复用 SDK ClientFactory 和标准 HTTP JSON-RPC／SSE 临时宿主，分开模块 fake、真实 runtime／本地模型 fixture、独立进程协议调用三层证据；覆盖成功、去重、busy、取消、持久化、重启与关闭后才交付黑盒。当前仅文档，不运行实现或宣称通过。
- 完善串讲 A2A 正文与阅读页，补一张目标契约关键类图；既有 WSS 和服务端完整链路图标为后续部署场景。
- 新增 [contract.md](contract.md) 作为完整公开契约评审入口：统一导出／构造、SDK 完整签名、上下文、JSON 输入输出、错误、等待／停止、SQLite 所有权及有总预算的关闭流程。限额取值和外部平台认证仍需填定，不创建 TS 源码。

## Capabilities

### New Capabilities

- `desktop-a2a-task-channel`: 桌面 Node 的 A2A 操作、共享执行准入和持久交付边界；先独立验证标准 A2A 公开调用闭环，WSS 自定义绑定及 adapter 接入延后。

### Modified Capabilities

无。现有 `observability-runtime` 的要求不变；用户已确认首版沿用执行记录和安全错误边界，不新增日志、span 或指标。

## Impact

- 需求依据：[核心 A2A](../../../docs/requirements-walkthrough/核心-服务端通过WS调用客户端.md)、[第 07 章](../../../docs/requirements-walkthrough/07-任务执行与恢复.md)、[第 10 章](../../../docs/requirements-walkthrough/10-服务端API.md)。本轮更新核心 A2A 串讲、README／阅读页与第 10 章范围提示，保留已有章节身份；不改项目规范。
- 后续涉及 runtime 业务 `.mjs` → `.ts` 迁移、导入与类型检查，配套测试、Node 启动、打包脚本及原生壳的入口路径同步；不新增 TS 构建框架。当前 `runtime.mjs`／`main.mjs` 对应目标为 `runtime.ts`／`main.ts`。
- A2A Task 存储独立于聊天历史和 checkpoint；runtime 内继续复用 `execution/index.ts` 与现有资源装配，具体拆文件留到实施时。
- 服务端是外部接入方；本仓不实现 Console、网关或 worker。生产认证身份来源、官方版本材料提供方和 WSS 参数留到后续接入确认；模块验证使用受控测试身份与固定 fixture。
- 本轮不新增 npm 依赖或改 lockfile。后续实施按方案锁定官方 SDK 发布版，使用其核心／server／errors 公开入口；不因接 SDK 新建产品 HTTP／gRPC 服务；独立验证宿主可直接使用 SDK Express peer，仅用于 loopback 临时验收，不让 service 依赖 Express。持久化使用 SDK DatabaseTaskStore(SQLite) 的公开事务组合设计；实际 Kysely／驱动锁版、本地路径／迁移及运行验收仍待确认，不预设自写文件 CRUD、不擅自迁移 checkpoint。已核对 Node 内置与 ws 的 Upgrade 公开能力，实际 ws 锁版／平台行为和 RFC 8785 规范化实现仍须验收，SDK 本身不等于项目 WSS 绑定或交付确认保证。
