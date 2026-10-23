## Context

状态：**用户已明确授权按本提案实施 A2AService，WSS 暂缓**。本文件保留提案设计依据；当前实现与验收状态以 [verification.md](verification.md) 为准。用户已确认使用官方 @a2a-js/sdk、先不 fork；SDK 适配设计以已核验的 1.3.0 发布包为基线。用户已确认本轮聚焦 A2AService与 runtime 边界、业务源码统一 TypeScript、首版不新增埋点，以及第 4 节的数据入口／返回结构、职责分工和预留对象的执行／停止／释放接口。用户进一步确认本轮不绑定具体业务 Agent，input/output 保持 JSON，并已确认采用 SDK Task 表＋一张项目扩展表。完整公开契约集中在 [contract.md](contract.md)，其中限额字段、构造取消、目录布局及关闭细化是评审稿，不因工件完整视为已逐项批准。OpenSpec 工件完整不代表用户已批准实施。

依据：需求串讲的[核心 A2A](../../../docs/requirements-walkthrough/核心-服务端通过WS调用客户端.md)、[07](../../../docs/requirements-walkthrough/07-任务执行与恢复.md)、[10](../../../docs/requirements-walkthrough/10-服务端API.md)，以及 [A2A 1.0.0](https://a2a-protocol.org/v1.0.0/specification/)。以下区分既定需求与新增建议。当前用户要求先由外部 Agent 经标准 A2A 完成任务，独立验收模块后作为黑盒；WSS 接入暂缓，已有 [wss-contract.md](wss-contract.md) 仅保留为后续草案，仍不实现。

现有实现的约束：

- `runtime.mjs` 的 `start()` 同时做聊天解析、容量检查、Provider 固定、浏览器绑定与聊天事件发布，不能把 A2A 请求伪装成 chat IPC。
- `execution/index.ts` 已提供泛型 `ExecuteRequest<I, O>`、`prepare(scope)`、排空、settle、Run 记录与 checkpoint；`graphThreadId` 在此生成。它没有全局数量限制，也没有向调用方公开“结果已固定”的取消边界。
- `assembly.ts` 当前 `prepareSession` 以 `agentId` 选择材料，尚不能作为确定官方 `agentId + contentId` 的完整加载契约；不能声称远端版本同步已具备。
- `json-store.mjs` 可原子替换一个 JSON 文件，但独立保存 Task 与 message 索引会形成双写缺口。checkpoint 不保存 A2A 的幂等或交付状态。

## Goals / Non-Goals

**Goals:** 给服务端协作者和客户端实现者一份可讨论的公开操作、依赖、输入输出、错误、取消及关闭契约；继承现有三层分工和执行生命周期；建立不依赖 WSS 的外部标准 A2A 验收门槛。

**Non-Goals:** 不实现 WSS、生产 HTTP 监听或外部服务端；不扩展前端界面、发布平台、通用调度器或遥测设施。后文“本轮不实现”等描述保留的是最初提案阶段约束，不覆盖本轮明确的实施指令。

## Decisions

### 1. 已确认的语言决定与三层职责

统一名称为 **A2AService**，对应需求串讲中的“A2A 协议与任务处理”。它在内部处理标准 Task 的持久受理、状态、查询、订阅、取消和结果交付；这些职责不另设一层服务。公开类型为 `A2AService`，创建入口为 `createA2AService`，配置类型为 `A2AServiceOptions`。它与 WSS 模块和 runtime 共处同一 Node 进程。

`desktop/runtime/` 业务源码统一为 TypeScript，目标入口为 `main.ts`、协调模块为 `runtime.ts`，聊天、资源、配置、浏览器和 A2A 等业务模块一起使用 `.ts`。保持 ESM、严格类型检查及现有 tsconfig 的 `erasableSyntaxOnly`／Node 直接加载约束，不用仅改扩展名、any 或关闭检查伪装迁移完成。导入路径、配套测试、打包及宿主启动入口须一起校验；本轮不迁移源文件，不修改 tsconfig 或 package.json。

| 调用方 → 边界 | 接口责任 | 不携带的内部数据 |
| --- | --- | --- |
| 可信协议入口 → A2AService | 已鉴权调用上下文、标准请求、返回 Task／流或安全协议错误 | socket 不进入图执行 |
| A2AService → runtime | 同进程直接函数调用：预留名额，传独立运行身份、确定 Agent 版本和业务输入，取得业务结果／执行错误 | 不传 JSON-RPC、Task、Message、graph、模型或准备回调 |
| runtime → execution | 复用 `ExecuteRequest<I, O>`、`GraphScope` 和 `ExecutionOutcome<O>` | A2A 状态不进入 LangGraph 生命周期 |

本阶段不接 WSS，也不新建产品常驻 HTTP listener 或第二套执行器。后续独立验收临时在 loopback 提供 SDK 标准 JSON-RPC-over-HTTP／SSE 入口，让独立进程的外部 Agent 使用 SDK client 调用；HTTP 宿主是验证工具，不是产品新增服务。WSS 仍按后续草案另验网络接入，不阻塞模块验证。

JSON-RPC 是外部 Agent 调用桌面 A2A 操作的外部报文格式（本阶段标准 HTTP，后续可为 WSS 自定义绑定）（jsonrpc、id、method、params）。adapter 解码后直接调用 A2AService；A2AService 再调用 runtime 的普通函数，两者之间没有 RPC、socket 或 JSON 序列化。RPC id 留在 adapter 关联响应，不传入 execution，也不成为 runId。现有 Rust ↔ Node 的本地 IPC 是另一条宿主通信边界，与此内部函数调用分开。

### 2. 公开契约：集中评审，直接复用 SDK 接口

[contract.md](contract.md) 是本 change 的完整公开契约评审入口，本文件保留 SDK 选型、运行边界和事务实现依据。公开声明不再散落两处；原始 RPC 留在 transport 入口。

#### 2.1 导出、构造与完整调用签名

契约第 1～3 节列出 createA2AService、A2AServiceOptions、A2AService 及相关类型的完整声明、输入校验、启动收敛、资源归属和 SDK 各方法的精确签名。项目 A2AService 只增加 protocolFor、confirmTaskDelivery、close 三个入口；11 个标准操作直接采用 SDK A2ARequestHandler。getAgentCard 是 SDK 本地卡片读取，不增加网络方法。

新增 limits 字段为明确且有限的请求／Task 字节、JSON 深度、等待／订阅额度；具体数值由入口及外部平台确定。构造可接受等待 signal，先完成自有数据库初始化与重启收敛才返回。SDK store、Kysely、内部执行桥接与事件写入口不向调用者暴露。ResolveEndpoint 只解析本地官方目录、权限及卡片，不装配版本材料，不能让材料已清理的历史结果无法查询。

#### 2.2 等待、取消、订阅与错误的归属

契约第 4～7 节集中规定 JSON Part、身份／准入、三个持久事务、SDK 标准错误、持久化故障及关闭。context.state 的受控等待信号只结束该次调用，实际运行／结算 Promise 由服务持有；网络断开不调用 requestStop。仅 CancelTask 与应用最终 close 可要求停止实际执行。

ListTasks 保留 SDK 编码和分页，不额外承诺签名游标／绑定筛选；授权仍逐请求重查，游标不作为身份。historyLength 和列表 Artifact 裁剪不改持久记录。标准 sendMessage 保持默认阻塞，需要受理后返回的调用显式 returnImmediately:true。不能把 SDK 不支持的游标增强、额外 facade 或调用级等待控制误写成标准协议字段。

#### 2.3 官方协议对应程度与明确差异

结论是“按 A2A 1.0 的标准操作和模型实现，叠加需求中明确的项目绑定／扩展”，不能写成“整个服务与官方原样完全相同”，更不能在未实施和联调前宣称协议验收完成。

| 层面 | 官方对应及本项目定位 |
| --- | --- |
| 标准操作 | 上述 11 个逐一对应官方 service；禁用可选能力用相应标准不支持错误，不能遗漏为未知方法 |
| 标准对象 | Message、Task、Part、Artifact、StreamResponse、AgentCard 和状态枚举沿用完整 1.0 类型与 ProtoJSON；不加私有状态或旧版 kind/final 判别字段 |
| 本地函数签名 | ServerCallContext 和本地等待控制不放入标准 params；sendMessageStream/resubscribe/getAuthenticatedExtendedAgentCard 等 SDK 名称到 wire 名称的映射直接复用 JsonRpcTransportHandler |
| 产品运行约束 | 只返回 Task、一次执行到终态、持久 messageId 去重、JSON 内容模式、忙时 REJECTED 属于本项目的能力与行为约束，不宣称是所有 A2A Server 都必须如此 |
| 后续 WSS 传输 | 暂缓实施；需求自定义绑定 urn:omniops:a2a:binding:wss-jsonrpc:v1，按官方自定义绑定机制声明；不是标准 JSON-RPC-over-HTTP。客户端须认识该绑定，不能承诺普通 HTTP SDK 无适配直连 |
| 交付确认 | omniops/ConfirmTaskDelivery 为唯一项目业务扩展，必须声明／协商；不是第 12 个官方操作 |
| 创建与关闭 | createA2AService／close 是客户端本地模块生命周期，官方协议没有这两个网络操作 |

完整绑定认证错误的 wire 表达、额度和互操作验收仍未冻结（接入草案见 wss-contract.md），因此当前是可对照的设计，不是已证明完全兼容的实现。按官方 [Custom Binding Guidelines](https://a2a-protocol.org/v1.0.0/specification/#12-custom-binding-guidelines) 补齐绑定并联调后，才能对所声明能力作兼容性结论。

#### 2.4 已确认：官方 SDK 加项目适配，不 fork

用户已确认采用官方 [@a2a-js/sdk](https://www.npmjs.com/package/@a2a-js/sdk)，先不 fork。接入基线为 1.3.0 发布包，协议基线仍是 A2A 1.0。2026-10-22 只读核验了 npm 元数据和 tarball：SHA-512 与 registry integrity 匹配，发布 gitHead 为 `29417a5bb4038f804f310ce4fffd267a9375aa90`；下列源码引用固定到该提交。没有安装或执行包代码、没有更改 package.json/lockfile，也没有把 tarball 留在仓库。正式依赖与 Node 26／两平台交付验收仍是后续实施项。

**方案选择：最大限度使用 SDK 的实际实现，不只借用类型。** 在授权／closing／输入边界检查之后，复用 DefaultRequestHandler 的公开方法；仅替换 `sendMessage`、`sendMessageStream`、`cancelTask` 三条与需求确有差异的路径。继承或委托均限公开方法，不复制默认处理器、不调用私有方法、不 monkey-patch，不另写通用 A2A 状态机。实施以行为检查验证这份分工，不能因为一个方法不适配就整套绕开 SDK。

| 部分 | 直接复用 | 项目必须补 |
| --- | --- | --- |
| 类型／序列化 | 根模块完整协议类型、fromJSON/toJSON、状态枚举与 oneof | 必填、枚举、JSON 大小／深度、权限等信任边界验证；转换函数不是完整验证器 |
| JSON-RPC | JsonRpcTransportHandler 的分发、封装、RPC id 与错误映射；独立验收优先用 SDK jsonRpcHandler／ClientFactory 的标准 HTTP/SSE 接入 | 可信 context、等待 signal、安全校验和唯一 receipt 分支；WSS 握手与网络队列延后 |
| 标准请求 | DefaultRequestHandler 的 getTask、listTasks、resubscribe、getAuthenticatedExtendedAgentCard，以及四个 push 配置方法；getAgentCard 也复用 | 共同授权／closing 检查；卡片禁用 push／扩展卡片，复用 SDK 的标准不支持响应。只替换发送两方法和取消，共 3 条路径，而非重写 11 个操作 |
| Task 事件与存储 | ResultManager.processEvent、AgentEvent、TaskStore；复用已有合并、克隆和按 task 串行写机制 | 优先验收 SDK DatabaseTaskStore 的 SQLite 接入；补消息身份原子受理、完整终态封存、receipt 和启动恢复，不预设手写文件 CRUD |
| 订阅 | DefaultExecutionEventBusManager、ExecutionEventQueue、DefaultRequestHandler.resubscribe 的先监听再读取／终态拒绝／解绑逻辑 | 总线只发布已提交事件；经 SDK ExecutionEventBusManager 公开接口为等待者提供可独立结束的 SDK bus，限制事件数、大小与活动流 |
| LangGraph 执行 | SDK AgentExecutor 两方法作为很薄的运行桥接契约；本仓 createDesktopRuntime/createExecution 仍实际执行 | execute 委托已受理的 RunReservation，cancelTask 委托真实 requestStop；不在 SDK 旁边再建图或模型执行器 |
| 错误与扩展 | SDK errors 与标准扩展声明 | 安全摘要、项目授权及交付确认；不新建协议错误类或数字码表 |

运行桥接属于 A2AService 内部适配，不新增业务服务层或公开执行 interface。AgentExecutor 收到的是 SDK RequestContext，提取的业务 JSON 仍按第 4 节已确认的 RemoteRunRequest 交给 runtime；SDK 对象不穿透该边界。默认处理器要求的 executor 就使用这同一个桥接对象，不创建永远不会执行的占位 executor。替换的发送路径使用 SDK RequestContext／AgentExecutor／ResultManager／事件队列；其自有部分限于“去重、预留、受理提交、后台归属及等待策略”。

SDK 默认发送路径不能仅靠 executor 补齐：新消息随机生成 taskId，且准入发生前没有项目的 messageId 原子受理接口；流消费循环负责持久化，消费者退出后不保证继续保存。默认 cancelTask 的返回和无总线分支也不同，详见下文。这三处明确差异才是替换理由；查询、订阅、可选能力响应不因此重写。

本首版只发任务级事件，不转发 token、工具轨迹或任意进度：每条流首帧读取当前 Task 快照，不在共享总线重复广播初始 Task；共享总线每 Task 至多一次停止提示、一个最终 Artifact、一个终态状态，重复停止／查询／确认不新增事件。SDK resubscribe 没有原生 AbortSignal 参数，直接对 next 做 Promise.race 不能解除内部监听。通过其公开 ExecutionEventBusManager 注入每调用的 SDK 总线，转发共享总线的已提交事件；signal／关闭时只 finished 该调用的总线，外层 finally 解除转发。复用 SDK 队列停止／解绑逻辑，不结束共享执行总线，不访问 SDK 私有队列，也不另外手写队列。

SDK ExecutionEventQueue 是无容量参数的数组队列，不能称为自带有界背压；在上述每条流一个初始快照及每 Task 最多 3 个后续事件、单事件大小和活动流数均有限的条件下可直接复用。各消费者队列不影响结算，WSS 另有有界输出；未来若增加无限进度事件，必须先重新设计容量策略，不能继续沿用该假设。

仅经公开入口的接入示例（context／tenant／request 已由可信接入边界校验；外部 Agent 验收另经标准 HTTP 入口，不以此进程内示例替代）：

```ts
import { JsonRpcTransportHandler } from '@a2a-js/sdk/server';

const handler = await a2a.protocolFor(context, tenant);
const transport = new JsonRpcTransportHandler(handler);
const response = await transport.handle(request, context);
```

SDK 会从 params 设置 context.tenant；用于这个调用的 context 初始不预设 tenant，避免 1.3.0 的 setTenant 只能设置一次而报错。protocolFor 用独立 tenant 参数先做授权／选卡，返回的处理器在实际方法入口核对 SDK 已设置的 tenant 与绑定入口相同。每次请求使用独立 context，不能通过共享可变 context 串号。SDK 方法没有额外 CallOptions 参数，请求等待信号通过本地 context.state 的受控 `omniops.waitSignal` 项携带；它只清理等待／订阅，runtime 使用自己的 signal。

#### 2.5 取消：默认行为与需求的具体差异

| 1.3.0 DefaultRequestHandler 的已核验行为 | 需求要求 | 本方案处理 |
| --- | --- | --- |
| 找到事件总线时，await AgentExecutor.cancelTask 后继续处理事件到终态，随后返回 Task | 可取消时先提出停止，排空期间返回 WORKING／正在停止 | 仅替换 DefaultRequestHandler 的公开 cancelTask：在 Task 的串行控制边界调用 reservation.requestStop；requested 后保存当前停止提示并返回快照，不等待整个 run |
| 找不到事件总线时可直接产生 CANCELED，无需证明实际执行已结束 | 真实排空和取消终态落盘后才能 CANCELED | 查项目的 Task → run／reservation 归属；缺失归属不能当取消成功，返回安全不可用错误；重启遗留先 FAILED/interrupted-unknown |
| 已持久 CANCELED 时返回原 Task；其他终态拒绝取消 | 需求第 10 章规定结果固定或已终态均 TaskNotCancelable | 遵守项目约定；重复停止仍只产生一次作用，终态查询使用 GetTask，不改变原状态 |
| 终态检查依据已保存 Task；没有本仓 execution 的 settle 前结果固定边界 | 结果固定后，即使 Task 终态尚未提交，也不能改成取消 | 以 requestStop 的 result-fixed 判定，返回 SDK TaskNotCancelableError；不根据 UI phase 或磁盘仍 WORKING 猜测 |

随后仍由原来的后台执行／结算 Promise 等待实际操作、cleanup 和 Run 记录完成，再提交一次 Task 终态、释放名额和广播。停止意图已生效但提示落盘／RPC 响应失败时不回滚停止，调用方查询原 Task；不把收到请求、没有总线、网络断开或超时当作已取消。已有更早失败和已固定结果不能被取消覆盖。

#### 2.6 持久化：复用 ResultManager 与 TaskStore，补项目事务

SDK TaskStore 定义按 taskId 的 save/load/list，默认 InMemoryTaskStore 重启丢数据；ResultManager 已有按 tenant／owner／taskId 的进程内串行写、克隆及合并。继续使用这些实现。它的保护并非完整的不可变终态：不同状态的迟到 statusUpdate 会被拦截，但同终态的 statusUpdate、artifactUpdate 和完整 Task 事件仍可改写数据，所以 TaskStore.save 的统一提交边界必须封存终态，不重复实现事件合并算法，也不能仅依赖 SDK 检查。

| 需求边界 | SDK 直接使用 | 最小项目补充 |
| --- | --- | --- |
| messageId 去重、先持久受理再运行 | 标准 Message／Task、TaskStore | 同键串行检查及一个事务同时保存调用摘要、Task 和 thread/run 关联；busy 同样留持久拒绝。SDK save/load/list 无消息受理事务，不能分别写独立索引文件 |
| 普通 Task 更新 | ResultManager.processEvent → 同一个 TaskStore.save | save 委托 SDK 存储提交，保留私有关联及 receipt；load/list 返回授权范围的独立快照。默认 getTask/listTasks 继续使用这份 store |
| 断线后的结算 | SDK AgentExecutor、ResultManager 和事件总线 | 受理后由服务跟踪后台 execute／持久化 Promise，消费者不拥有该 Promise；两种发送路径共用它，不靠消费者迭代来驱动保存 |
| 完整结果一次封存 | ResultManager.processEvent(AgentEvent.task(完整终态 Task)) | 终态一次携带全部 Artifact；同一次 TaskStore.save 计算并保存摘要、冻结结果。不能先写终态再补 Artifact；SDK 不重复消费广播事件再写一次 |
| 已提交后再通知 | SDK bus、queue 和 resubscribe | await 保存成功，再 release，然后发布 artifactUpdate／终态 statusUpdate；广播不负责保存，因此慢消费者或无人订阅不改变持久化 |
| 独立交付确认与重启策略 | SDK Task.toJSON 和协议读取方法 | receipt 单独更新同一记录，不改终态；开放请求前将遗留非终态持久转 FAILED/interrupted-unknown，不恢复图／模型／页面 |

全链路只使用同一个权威持久存储：SDK TaskStore 方法与项目受理／receipt 辅助操作共享记录和写入临界区，不各建状态仓库。ResultManager 是 Task 更新的现成处理器，不是另一份存储；项目不再平行写事件合并器或状态机。受理辅助操作是 SDK 没有的 messageId 原子操作，终态保存走 ResultManager → TaskStore.save；同一终态重复提交只能核对原结果，不能更新状态时间、Artifact 或摘要。Run 自身仍由 execution 单独保存，Task 与 Run 之间按第 4 节顺序结算，不宣称跨文件事务。

SDK 已提供 [DatabaseTaskStore 与 SQLite 支持](https://github.com/a2aproject/a2a-js/blob/29417a5bb4038f804f310ce4fffd267a9375aa90/docs/persistent-stores.md)。本轮进一步核验：其构造可接收 Kysely Transaction，能够与项目扩展表在同一事务提交，具体设计见第 5 节。因此方案优先采用 SDK 存储与一个项目扩展表，不手写 Task CRUD／分页，不复制 SDK 表的编解码或迁移；尚未安装或运行，不能称为已通过事务／打包验收。

仓库 lockfile 已有 better-sqlite3 12.11.1（checkpoint 的传递依赖），没有 Kysely；后续实际使用仍须显式声明直接依赖，并核对 Node 26／原生打包。SDK 1.3.0 的 peer 范围接受 Kysely ^0.28.17 或 ^0.29.0、better-sqlite3 ^12 或 ^13。本次固定核验 Kysely 0.29.5 源码，不把 registry 当前 latest 0.29.7 当作已验收版本；实际锁版留待实施。不复用 checkpoint 的句柄／表，不在本轮创建数据库或执行迁移。

SDK 运行时对象不一定等于 wire JSON：生成类型可有数字枚举和 oneof 包装。结果摘要必须先由 SDK Task.toJSON 得到标准 ProtoJSON，再取需求规定的 `{id, contextId, status, artifacts}` 投影，缺省 artifacts 规范为 []，按 RFC 8785 后做 SHA-256。不能 hash SDK 内部对象、裁剪过的 ListTasks 响应或包含交付状态的私有记录。

存储中只有一个权威 Task 结果，SDK ResultManager 和读接口都使用它；TaskStore 读取／列表与订阅首帧都来自该记录。原 Task 终态不能因为 SDK 事件重放、格式转换或重复确认而更新时间戳或覆盖 Artifact；执行失败、终态保存失败、receipt 保存失败继续按第 6 节分别处理。

核验来源固定至发布 gitHead：[请求处理与取消](https://github.com/a2aproject/a2a-js/blob/29417a5bb4038f804f310ce4fffd267a9375aa90/src/server/request_handler/default_request_handler.ts)、[TaskStore](https://github.com/a2aproject/a2a-js/blob/29417a5bb4038f804f310ce4fffd267a9375aa90/src/server/store.ts)、[ResultManager](https://github.com/a2aproject/a2a-js/blob/29417a5bb4038f804f310ce4fffd267a9375aa90/src/server/result_manager.ts)、[公开请求接口](https://github.com/a2aproject/a2a-js/blob/29417a5bb4038f804f310ce4fffd267a9375aa90/src/server/request_handler/a2a_request_handler.ts)、[ServerCallContext](https://github.com/a2aproject/a2a-js/blob/29417a5bb4038f804f310ce4fffd267a9375aa90/src/server/context.ts)。不调用库私有方法；公开接口确有无法满足的缺口时先回到提案说明，不擅自 fork 或安装其他框架。

#### 2.7 开源 A2A + LangGraph 的采用范围

见[源码调研](research-a2a-langgraph.md)。优先参考一手仓库中已核验的 LangGraph.js 桥接示例，沿用 DefaultRequestHandler／AgentExecutor／TaskStore 接法；旧协议示例只借鉴桥接方式，不复制已过期的 kind/final 结构。LangGraph 的 Agent Server A2A endpoint 是另一种服务部署形态，不能为本桌面接入引入额外服务器。现有 createExecution 继续拥有 graph、checkpoint、模型及资源生命周期；本轮不绑定示例的业务 Agent。

### 3. 既定需求与标准细化：外部 wire contract

- 本阶段外部 Agent 验证使用 SDK 标准 HTTP JSON-RPC，流为 SSE；卡片声明 JSONRPC／1.0／tenant，调用用 SDK 服务参数明确版本和必需扩展，不依赖缺省 0.3。绑定配对校验由 transport 调 SDK validateVersion，A2AService 只检查版本／卡片／扩展，不硬编码 WSS。
- 后续 `WSS /api/clients/connect` 与自定义 URN／Upgrade 见暂缓的 wss-contract.md，不作为当前验收条件。
- 标准请求使用 JSON-RPC 2.0 对象；`tenant` 放在标准 params。普通响应返回标准对象，流响应每帧的 `result` 是一个 `StreamResponse`，使用原 RPC id。无 batch 或额外 `type/payload` 封套。
- `SendMessage` 返回标准 `SendMessageResponse`，本产品选择其 `task` 分支；默认等待终态，显式 `configuration.returnImmediately: true` 才受理即返回。重投改变这一等待选项不改变 Task 身份。
- 需求第 10 章“受理提交后返回 Task”的调用路径使用上面的 returnImmediately: true；不能据此把标准默认值改为非阻塞。需要受理后马上知道 taskId 的服务端必须显式设置。
- 流首帧为 `{ task }`；后续仅任务级 `statusUpdate` 与最终 `artifactUpdate`。终态事件结束此流；首帧已终态则该流直接结束。HTTP/SSE 由 SDK 按标准结束响应；后续 WSS 只结束对应流。不得使用旧版 `kind` 判别字段。
- `SubscribeToTask` 的建立与快照读取须避免漏掉终态；已终态时返回标准不支持错误，调用方转 `GetTask`。断开、等待取消、迭代器 `return()` 只释放订阅或等待，不取消已受理 Task；停止执行只走 `CancelTask`。
- List 按标准过滤与分页，限制在已授权逻辑入口；`pageToken` 沿用 SDK 不透明编码，授权每次重验；不额外承诺签名或冻结全集。`historyLength` 遵循标准；历史仅为协议 Message，不包含模型、工具或 checkpoint。
- AgentCard 声明 streaming、必需交付扩展；首版建议 `pushNotifications: false`、`extendedAgentCard: false`，对应操作明确返回标准不支持错误。

仅经公开入口的网络调用示例（示例值均非真实身份）：

```json
{
  "jsonrpc": "2.0",
  "id": "rpc-1",
  "method": "SendMessage",
  "params": {
    "tenant": "selected-card-tenant",
    "message": {
      "messageId": "stable-message-1",
      "role": "ROLE_USER",
      "parts": [{ "data": {} }]
    },
    "configuration": { "returnImmediately": true }
  }
}
```

已确认本轮不绑定具体业务 Agent：input 保持 JsonObject、output 保持 JsonValue。官方 1.0 的 Part.data 使用 google.protobuf.Value，允许任意 JSON 值；不需要额外 result 包装。首版通用 JSON 映射建议为：一个 Data Part 的 data 对象整体作为 input；一个最终 Artifact 的 Part 直接使用 `{ "data": output }`，output 为数组、标量或 null 同样有效，不能用真假判断丢掉 0/false/null。input 顶层对象和单 Part 是已选本地数据入口／候选通用映射的项目约束，不是官方 Part 的限制；在 AgentCard 中声明 JSON 内容模式，不伪装为支持任意文本／文件业务。单 Part 与内容模式细化尚待确认，不引入必填业务字段或通用业务信封。

后续业务接入可以按官方入口进一步定义 schema，本轮不预建业务验证器，也不把业务字段契约作为通用接口讨论前提。任意业务 JSON 不得被解释为本地 Provider、模型、工具、文件路径或版本覆盖指令。首次消息不带 taskId；未知 taskId 返回 TaskNotFound，引用已有 Task 的新 Message 明确不支持继续运行，不通过该路径新增一次执行。

### 4. 已确认：只向 runtime 传业务数据，保留共享容量预留

公开调用采用 `execute(RemoteRunRequest)`；`ExecuteRequest<I, O>` 继续作为 **runtime → execution** 的内部调用契约，图和 prepare/settle 回调留在 runtime。用户已确认此数据边界、ExecutionOutcome 返回形状与 RunReservation 的 execute/requestStop/release 签名，以及先受理持久化再执行、终态持久化后释放的正常顺序；业务 input/output 保持 JSON，具体业务 schema 已移出本轮范围；下文另标为建议的错误分类和故障处置细节未据此自动确认。

#### 4.1 已确认的公开签名

`runtime.ts` 将公开现有 `createDesktopRuntime` 及增量类型 `RemoteRunAdmission`、`RunReservation`、`RemoteRunRequest`、`AgentVersionRef`、`JsonValue`、`JsonObject`；`ExecutionOutcome`、`RunIdentity`、`ExecutionError` 继续从 `execution/index.ts` 复用，不另建错误类。JSON 类型仅描述跨模块业务值，不要求原生图的内部 state/input/output 同形。这些新增入口尚未实现。

```ts
type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
type JsonObject = { [key: string]: JsonValue };
type AgentVersionRef = Readonly<{
  agentId: string;
  contentId: string;
}>;
type RemoteRunRequest = Readonly<{
  threadId: string;
  runId: string;
  agent: AgentVersionRef;
  input: JsonObject;
}>;
interface RunReservation {
  execute(request: RemoteRunRequest): Promise<ExecutionOutcome<JsonValue>>;
  requestStop(): 'requested' | 'result-fixed';
  release(): void;
}
interface RemoteRunAdmission {
  reserveRun(): RunReservation;
}
```

#### 4.2 A2AService 实际传什么

| 字段 | 谁确定／用途 | 约束 |
| --- | --- | --- |
| threadId | A2AService在成功预留后生成，绑定此 Task 的独立本地会话和 Chrome 页面 | 不使用 contextId，不接受远端指定的本地会话 |
| runId | A2AService生成并持久关联 Task，一次本地执行身份 | 唯一、不可重放；不是 messageId 或 RPC id |
| agent.agentId | 从已授权 tenant 解析的官方 Agent 身份 | 不接受 Message 临时覆盖 |
| agent.contentId | 同一入口对应的确定不可变版本 | 必须精确匹配，缺失不能取最新版／本地草稿 |
| input | A2AService解码标准 Part 后得到的显式业务 JSON 对象 | 含必要业务上下文；不是完整 Message 或聊天历史 |

runtime 收到请求后复制并校验边界数据；JsonValue 运行时只接受有限 number、普通 JSON 对象和有界嵌套／大小，不能包含函数、循环引用、类实例或本地对象。thread/run ID、contentId、保留会话名与已有运行冲突复用现有校验。本轮仅规定通用 JSON 与边界校验；具体业务 schema 留待对应业务接入，不因此免除已有执行图的必要输入校验。类型正确不能替代权限与运行时校验。

A2AService校验 A2A 对象、Part 类型及授权，提取通用 JSON input；runtime 内部按所选执行入口完成 JSON input → 原生图 input 的转换，调用资源装配模块加载固定版本，再准备本地 Provider、MCP、工作空间与按 thread 绑定的浏览器。图和 prepare/settle 回调均由 runtime 生成。这里不绑定某个业务 Agent，不增加通用插件注册器或一套图资产协议；实际运行入口映射随客户端发布，不把 JSON 任意执行为代码。

timeoutMs 使用 runtime 构造时的本机执行策略，不作为远端可覆盖字段；Provider／模型选择也由本机固定。业务 deadline 如确有需要，由该入口的显式 input schema 定义并在开始外部动作前检查，不等同于 socket 等待超时。材料加载使用 runtime 自己的执行 signal，不能绑定到某个 WSS 请求的 signal。

#### 4.3 runtime 实际返回什么

复用现有 `ExecutionOutcome<JsonValue>` 的完整形状：

```ts
type RunIdentity = Readonly<{
  threadId: string;
  runId: string;
  graphThreadId: string;
}>;
type ExecutionOutcome<O> =
  | { ok: true; run: RunIdentity; output: O }
  | { ok: false; run?: RunIdentity; error: ExecutionError };
```

- 成功：原 threadId/runId、execution 生成的 graphThreadId，以及满足通用 JsonValue 边界的 output。原生图可以有任意 state/output；runtime 内部将它映射为此 JSON，不要求本轮确定业务结果字段，不能把模型原始消息、工具轨迹或 checkpoint 当作 output 返回。
- 失败：已有 Run 时返回同一身份和 ExecutionError；在参数／重复调用等早期拒绝、尚未建立 Run 时 run 可缺省。预期的准备、模型、工具、超时、取消、存储等失败在 execute 的 Promise 中以 `ok: false` 返回；不是伪造成功业务结果。
- `ExecutionError` 沿用受控 kind 和安全 message，来源与 cleanupErrors 留在内部。为避免 A2AService解析来源链猜测业务原因，建议在已有 `ExecutionErrorKind` 中补入 `missing-input`、`login-required` 两个受控分类，保留现有其他分类；这是后续兼容增量，当前代码尚未具备。
- 该返回值是 **本地执行结束**，不是 A2A Task 已持久终态，也不是服务端已确认交付。A2AService随后将 output 包成标准 Artifact，或将错误映射为标准失败／取消状态并持久保存。

| runtime 结果 | A2AService 后续动作 |
| --- | --- |
| ok: true | 业务 output → Artifact；保存 COMPLETED |
| error.kind: cancelled | 保存 CANCELED，说明不回滚已发生操作 |
| error.kind: timed-out | 保存 FAILED/timed-out |
| error.kind: missing-input／login-required（候选新增） | 保存 FAILED 和对应业务原因 |
| 其他受控错误 | 保存 FAILED 和安全原因；不输出 cause／cleanupErrors |
| Run 或 Task 最终持久化失败 | 不报告成功；保留已有证据／候选结果，不重跑；Task 存储故障暂停新增远端受理 |

**只调用公开入口的示例**（假定已完成授权、预留与 Task 受理持久提交；此处不展示私有存储实现）：

```ts
const outcome = await reservation.execute({
  threadId: 'thread-demo-1',
  runId: 'run-demo-1',
  agent: { agentId: 'demo-agent', contentId: 'a'.repeat(64) },
  input: {},
});
```

成功结果示例为 `{ ok: true, run: { threadId, runId, graphThreadId }, output: {} }`，output 也可以是其他合法 JSON 值。A2AService 直接把 output 放入 Artifact 的 `parts[0].data`，不添加 result 包装；本地身份保存在私有关联记录／非敏感摘要中，不伪装成 A2A contextId。

#### 4.4 预留、执行、取消和释放的顺序

`reserveRun()` 无输入，同步检查 closing 与当前设置并返回一个尚未启动的 RunReservation；不准备模型、材料或页面。仅满额抛 `RuntimeError('busy', 安全说明)`，A2A 将该分类映射为持久 REJECTED/busy。应用关闭使用 unavailable、没有有效设置使用 storage 安全分类，不能靠比较错误文案判断 busy。本地、实验和远端最终必须走同一计数；降低上限不取消已有任务。

1. A2AService先授权、查 messageId，重复请求直接查原 Task，不调用 runtime。
2. 新请求 reserveRun 成功后才生成 threadId/runId，与 Task 和原调用摘要一起原子提交；保存失败只 release，不 execute。busy 分支只生成 Task 身份，不创建 thread/run/页面。
3. 受理提交后且仅调用一次 execute(request)，Task 可报告 WORKING（包括材料准备）；execute 立即返回本地工作 Promise，不要求服务端等到 Promise 完成才看到受理。此 Promise 与连接生命周期分开。
4. runtime 内部用现有 ExecuteRequest/GraphScope 执行，完成排空、settle 与最终 Run 记录后返回 outcome。A2AService据此持久提交唯一终态 Task/Artifact，再 release，最后发布终态；交付确认等待不占名额。
5. Task 终态存储失败不 release，A2AService暂停新增远端受理并保留候选结果供同进程重新持久化；不重跑图。重启后按第 5 节收敛。

`requestStop()` 无输入，同步、幂等且可在 execute 前锁存停止意图；返回 requested 仅表示停止意图已锁存或已发出 abort，不表示已排空。execution 在进入 settle 前固定结果后返回 result-fixed，不改变原结果；完成后同样返回 result-fixed。该判定要在 execution 真实边界暴露，不能根据 UI phase 猜测；保留 stop() 的已有本地行为。结果固定也不承诺随后磁盘写入一定成功，存储错误仍须报告。

CancelTask 将 requested 映射为当前 WORKING／正在停止，继续等待 execute 的 outcome 和 Task 持久提交后才能公开 CANCELED；result-fixed 对应 TaskNotCancelable。网络断开不会调用 requestStop。

`release()` 无输入、返回 void；未启动或已完全排空才允许释放名额，重复释放无效果，执行中释放属于 invalid-request。A2AService负责满足终态持久化前提，runtime 不读取 A2A 存储。已 release 后不得 execute；每个预留只允许一次 execute，错误调用以受控错误拒绝，不能开始第二次运行。所有预留由 runtime 跟踪，关闭期间会等待结算或按统一退出预算报告未完成，不能泄漏为不受管理的活动工作。

`CancelTask` 可取消时先记录正在停止、调用 requestStop，返回当前 WORKING；订阅／查询观察最终 CANCELED。结果已固定则 TaskNotCancelable；真正的存储／执行失败不能被取消覆盖。

### 5. SQLite 事务适配：复用 SDK Task 表，只加一个项目扩展表

**核验结论：源码支持公开事务组合，不存在 SDK 专用的 transaction／beforeSave 插件。** 外层使用 Kysely 的 `db.transaction().execute(callback)`；回调提供的 Transaction 继承 Kysely，可直接交给 SDK DatabaseTaskStore。SDK 的 dialectOf 通过公开 introspection 识别 SQLite，事务句柄仍保留原 SQLite dialect。成功离开回调后才 commit；抛错则尝试 rollback 并拒绝外层 Promise。以下只是文档中展示公开接入点，不是受理函数实现：

```ts
import { DatabaseTaskStore } from '@a2a-js/sdk/server/database';

await db.transaction().execute(async trx => {
  const tasks = new DatabaseTaskStore(trx, { tableName: 'a2a_tasks' });
  await tasks.save(task, context);
});
```

项目扩展表的读写也必须使用同一个 trx；不能复用绑定根 db 的 tasks 实例，不能把 trx 保存到回调之外或自行 commit／destroy。SDK save/load/list、JSON 编解码、过滤、排序和分页继续直接调用 SDK；不复制这些 SQL。实际方案用一个本地 A2A 数据单元保存两表，物理路径及本地持久化范围仍待确认，与现有 checkpoint 分开管理。

#### 5.1 两表分工与身份

| 存储 | 保存内容与约束 |
| --- | --- |
| SDK 管理的 a2a_tasks | 唯一标准 Task，包括 status、完整 Artifact、协议 history／metadata；使用 SDK 迁移与 DatabaseTaskStore，主键是 tenant／owner／id，不添加私有字段或复制一份 Task |
| 项目的 omniops_a2a_delivery | 主键 `(organizationId, callerId, installationId, messageId)`；保存不可变调用指纹、固定 agentId/contentId、tenant／owner／taskId、可空 threadId/runId、可空 resultSha256、可空 receivedAt。另以 `(tenant, owner, taskId)` 唯一约束关联 SDK Task；使用对应外键与受控校验 |

`resultSha256 IS NULL` 表示未封存，非空表示 Task 已终态且结果冻结；`receivedAt` 非空表示确认事务已提交。无需另建 delivered 标志、结果副本、消息索引文件或事件日志。忙时拒绝也保存两表和终态摘要，thread/run 为空。receipt 字段留在项目表，不能回写标准 Task。

SDK TaskStore 默认 owner 使用 userName，但 ResultManager 的锁也直接使用 userName，不读取自定义 ownerResolver。因此在可信上下文入口将组织／调用方／安装的确定编码派生为非空、限长的稳定 userName，原主体信息保留在受控 state；SDK 存储和 ResultManager 使用完全相同的 tenant／userName／taskId。不允许正文自报、unknown 回退，或 resolver 将多个不同 userName 合为同一个 owner。tenant 仍只是入口路由，不作为授权证明。

#### 5.2 消息去重与原子受理

1. 完成输入、可信身份、入口和版本检查，进入一个短 Kysely 事务，先按项目表主键查 messageId。相同指纹通过事务内 SDK load 取得原 Task；不同指纹返回冲突。跨 tenant 使用相同 messageId 仍比较同一受理身份，不能另建 Task。
2. 只有键不存在才同步 reserveRun；该调用只预留、不准备模型／材料／页面。保存初始 Task 时直接调用事务绑定的 SDK store.save，并插入对应项目行，二者一次提交。busy 则保存 REJECTED/busy 及封存摘要，不创建 thread/run。
3. 外层 transaction Promise 成功后才启动 execute，至多一次。回滚失败或提交结果不明时先核对原 messageId，不能当作未受理删除记录或启动模型重试；确认未提交才释放未运行预留，已提交但未开始的归属由服务安全结算／恢复，不重放。

指纹包括确定目标版本、规范业务输入、显式上下文和有效期，排除 RPC id、等待／订阅／分页参数；首次省略 contextId 时生成值不反写原调用指纹。指纹和唯一约束不能被客户端拿来替代鉴权。

同一 Kysely SQLite 连接已串行提供事务，不另造全局调度器或同键锁库；数据库唯一约束是持久兜底。事务内只允许短数据库操作及同步预留，不 await 图、模型、网络、磁盘材料加载或交付。Task 执行本身仍按 runtime 额度并发。SQLite BUSY／唯一冲突不能一律当重复成功：回滚后按原键核对，只有相同已提交指纹才返回原 Task；其他情况安全失败，不盲目重试事务或执行。

#### 5.3 终态冻结：一个受控 TaskStore 写入口

给 SDK ResultManager 注入遵循现有 TaskStore 契约的薄适配，公开面仍只有 save/load/list，不另建 repository 接口。load／list 委托 SDK，save 在一个短事务中完成下列检查与 SDK 写入：

- 以可信 tenant／owner／taskId 取得项目行和 SDK 当前 Task，确认唯一绑定；缺失关联不是允许 upsert 新任务的理由。终态与封存标记不一致是存储一致性错误：不能把“Task 已终态但 SHA 为空”当可写，也不能把“SHA 已有但 Task 非终态”当成功。
- 未封存时，继续调用同一 trx 上的 SDK save。终态候选必须一次带齐完整 Artifact；用 SDK Task.toJSON 的 `{id, contextId, status, artifacts}` 投影（缺省 artifacts 为 []）做 RFC 8785／SHA-256，同事务保存 Task 和项目行的 resultSha256。公布摘要的 Task metadata 在保存前确定；它不参与摘要，不形成自引用。
- 已封存时，仅完整标准 Task 的规范化内容相同才直接返回原记录且不再次 SDK save／广播；比较不能只看排除了 history／metadata 的交付摘要。内容不同明确拒绝，不能借同终态 status、迟到 Artifact、完整 Task 或“补 metadata”改写结果。receipt 不走这个写入口。

普通更新链固定为 **ResultManager.processEvent → TaskStore.save 薄适配 → Kysely 事务 → DatabaseTaskStore(trx).save**。保留 SDK 的事件合并与进程内锁，不自己重写状态机。初次受理在执行尚未开始时直接用事务 store.save；唯一初始化路径同时建项目行，busy 终态同时封存。启动恢复也使用同样的封存规则，遗留非终态转 FAILED/interrupted-unknown，原终态与摘要保留。

commit 成功后才释放容量、发布已提交的 artifactUpdate／终态 statusUpdate；ResultManager 保存的事件与对外广播分开，不将广播再次喂给另一个 ResultManager。若 Task 写入成功但封存更新失败，整个事务回滚；反向同理。Run 自身仍由 execution 单独保存，二者按既定顺序结算，不宣称 Run 文件、SQLite 和外部副作用之间有原子事务。

这是服务内所有写入经一个受控入口的冻结保证；原始 SDK store／db 不向其他模块公开，禁止恢复、取消或后台更新绕过。首版不另加触发器体系；若以后开放其他写入方，必须重新审查这个前提。

#### 5.4 交付回执：只提交项目行

ConfirmTaskDelivery 先鉴权，再在短事务中经 SDK load 取得完整原 Task，并读取相同 tenant／owner／taskId 的项目行：必须已终态、已封存，重新计算的公开摘要、封存 SHA 与请求 SHA 全部一致。未终态／错摘要拒绝；不因 caller 自报 taskId 或 tenant 跨范围访问。

第一次确认仅将 receivedAt 从 NULL 更新为校验过的 RFC 3339 值，带相同封存 SHA 与未确认条件；提交后才返回 `{taskId, resultSha256}`。重复匹配确认返回相同成功响应，保留第一次 receivedAt；后续传不同时间不覆写原确认。Task、状态时间、Artifact、摘要、运行和去重身份全部不变，不调用 SDK save。确认提交失败仍待确认，重试原 receipt 不触发执行。

#### 5.5 连接、锁和安全错误的必要限制

- **锁顺序：SDK ResultManager Task 锁 → 短数据库事务。** 不持事务再 await processEvent，也不在事务中嵌套调用自动开事务的 TaskStore.save 适配。受理／确认事务只调用事务绑定 SDK store 和项目表，不能 await 根 db／根 store；Kysely SQLite 连接互斥会使后者等待自己占用的连接。
- 固定核验的 Kysely SQLite driver 实际执行普通 BEGIN，即 DEFERRED；setIsolationLevel 不是 BEGIN IMMEDIATE。单连接事务串行不等于多进程准入保证；不共享第二个写连接，不通过 SDK／Kysely 私有成员改 BEGIN。BUSY、提交或回滚失败进入安全存储故障路径，不启动模型／图重试。
- better-sqlite3 的 SQL／锁等待同步执行，AbortSignal 或 Promise.race 不能保证打断；不能沿用默认 5 秒等待就声称满足关闭预算。建议首版将 A2A 连接的 busy timeout 显式设为 0，锁冲突立即作为存储故障返回，不新增同步等待或自动重试；不改变 checkpoint 的现有设置。SQLITE_BUSY 不等于运行额度 busy，不能伪造 REJECTED/busy Task。关闭前停新操作并跟踪正在提交的事务，仍需验证两平台行为；同步磁盘操作本身也不能仅靠 signal 硬中断。不为等待取消调用 trx.destroy，不能提前销毁结算所需连接。
- SDK list 对行解码错误会 console.error 原始异常并跳过，外层 catch 无法拦截。保留 SDK 分页，建议通过公开 KyselyPlugin.transformResult 在 SDK for-loop 前校验 Task 查询结果：使用公开 TaskRow 字段、JSON 解析及 SDK Task.fromJSON，识别列投影并只校验实际返回列，结果原样返回，不改查询。损坏或非法行先抛安全存储错误，阻止进入 SDK 的吞错／原始输出分支；不复制私有 fromTaskRow、不替换全局 console、不加每行补查或自写分页。该钩子只识别 SDK Task 行查询，不能误判 count、迁移或项目表结果；其覆盖完整性是运行验收项，未证明前不能宣称安全错误已接通。Kysely query log 保持关闭；写入也先按输入边界校验。

SDK Task 表与项目扩展表使用各自迁移，先检查本地文件归属、schema／格式、完整性与版本；迁移成功及重启收敛成功后才开放请求。不在每个请求里自动建表；具体升级步骤与应用生命周期另行确认，不修改 checkpoint 数据或已有项目规范。

证据：[SDK store](https://github.com/a2aproject/a2a-js/blob/29417a5bb4038f804f310ce4fffd267a9375aa90/src/server/database/task/store.ts)、[SDK dialect](https://github.com/a2aproject/a2a-js/blob/29417a5bb4038f804f310ce4fffd267a9375aa90/src/server/database/dialect.ts)、[Kysely Transaction](https://github.com/kysely-org/kysely/blob/f24018c789c3cf7ad03ccc672ada63a1ded87f88/src/kysely.ts)、[SQLite driver](https://github.com/kysely-org/kysely/blob/f24018c789c3cf7ad03ccc672ada63a1ded87f88/src/dialect/sqlite/sqlite-driver.ts)、[连接互斥](https://github.com/kysely-org/kysely/blob/f24018c789c3cf7ad03ccc672ada63a1ded87f88/src/driver/runtime-driver.ts)、[结果校验公开钩子](https://github.com/kysely-org/kysely/blob/f24018c789c3cf7ad03ccc672ada63a1ded87f88/src/plugin/kysely-plugin.ts)、[结果钩子执行位置](https://github.com/kysely-org/kysely/blob/f24018c789c3cf7ad03ccc672ada63a1ded87f88/src/query-executor/query-executor-base.ts)。以上是源码与 API 核验，事务回滚、去重竞争、冻结、回执、坏行输出、取消和关闭预算尚未运行验证；本轮不安装、不建表、不写运行实现。

### 6. 完整错误及关闭契约的唯一评审入口

见 [contract.md 第 6／7 节](contract.md)：构造／close 使用现有 RuntimeError，协议面转换 SDK 公开错误类并复用标准序列化；已受理运行错误结算原 Task，不能只抛 RPC 错误。受理、终态和回执三个持久化失败边界分别处理，SQLite BUSY 不是运行容量 busy。完整来源不进入对外错误、Task 正文或日志。

关闭预算采用同一进程绝对 deadline。服务先封闭入口、围住在途事务、对可取消归属运行发停止，再等待 Run／Task 结算、释放名额、清理消费者，确认事务结束后由 Kysely 关闭自有 SQLite。超时仍保留实际未完成归属，不能提前销毁连接或声称资源已释放。应用入口无论服务 close 成败都继续用同一 deadline 关闭 runtime、checkpoint 及宿主。

本轮额外建议：有固定候选终态时，close 在预算内最多重做一次原结果的存储收尾，不重跑图；持久故障后不自动恢复新受理。正常退出仍先检查运行任务并提示等待，断线或关视图不调用 close。以上细化仍待评审，当前运行代码未改。

### 7. 外部 Agent 验收与黑盒交付

先验证模块，后接 WSS。完整门槛见 [contract.md 第 10 节](contract.md)：模块行为用真实 SDK／SQLite 和小型 runtime fake 精确控竞争；runtime 集成用真实 LangGraph、固定物料与本地确定性模型 fixture；互操作必须由独立进程的 SDK client 经标准 HTTP/SSE 公开入口完成，不访问 service 私有对象。

验证宿主复用 SDK agentCardHandler／jsonRpcHandler 与自定义公开 contextBuilder，Express 仅为测试宿主可选 peer。其默认 body 额度、断开 signal、res.write 背压及原始 console 路径不视为已满足产品要求；外围限制 synthetic 数据并提供等待取消，错误在服务边界安全化，不能把临时 HTTP 宿主称作已上线服务。SDK 高层 client 会本地拒绝部分可选能力，验证 Server 拒绝路径时须经 SDK JsonRpcTransport 公开底层调用或受控标准请求真正到达服务，不能只断言 client 本地异常。

通过后冻结的是公开契约与回归场景，不是私有结构。后续 adapter 只注入可信 context、校验实际 binding 并转发协议，不直接操作 Task 表、执行预留或 runtime，不重写取消／去重／持久化。当前三层运行证据均未完成；文档与图形验证不代替它们。

### 8. 观测决定，用户已确认

本轮纯设计不改变执行路径，无需新增埋点。用户已确认实施首版沿用持久 Task/Run 记录和已有安全错误边界，**新增关键日志、span、指标均为零**：受理、开始、终态、取消和确认由持久记录判定，避免未接入 Node 遥测就引入新门面。若后续需要连接排障事件，再确认目的、级别、字段、标签、单位及统计边界；不直接记录协议正文、提示词、结果或凭据。

## Risks / Trade-offs

- [可信调用方来源尚未确定] → 这是生产接入阻塞项，网关认证与每次授权要一起定义，不能仅靠 tenant。
- [官方固定版本装配尚有缺口] → 接口评审先定材料提供边界；本轮 input/output 保持 JSON，fixture 不代表生产具备同步，也不预建某个业务 Agent。
- [SDK 持久化尚未运行验收] → 已核验事务句柄可用，按第 5 节复用 SDK Task 表与一个项目表；检查冻结、坏行安全钩子、锁与打包，不把源码可行当测试通过。
- [WSS Upgrade 头能力、流结束和背压尚需联调] → 先验证 Node 26 能力与已有依赖；确实不足才选择依赖，协议失败不能降级执行。
- [终态存储失败会占住容量] → A2AService暂停新增远端受理、保留结果，先恢复持久写入；允许恢复交付而不允许重新执行。
- [独立页面共享登录态] → 沿用专用 profile；不承诺账号隔离或外部副作用恰好一次。

## Migration Plan

先讨论并确认本文件的接口与待决参数，再单独明确实施。后续先完成 runtime 业务 TS 迁移及配套导入／测试／入口适配，保持本地行为；再锁定 SDK 发布版，用 fixture 验证 SDK 默认处理器复用、三个差异方法及共享准入，然后接入真实 runtime／LangGraph 和本地确定性模型 fixture；由独立外部 Agent 经 SDK 标准 HTTP/SSE 验收成功、失败、取消、真实持久化和重启。三层证据齐备后按黑盒交付，再单独恢复 WSS／网关的接入评审与联调；详见 contract.md 第 10 节。已有本地聊天 IPC 保持兼容，新增持久记录不删除 Run、历史或 checkpoint。停用远端连接只能停止新受理，已有 Task 仍须结算并保留查询和交付材料。

## Open Questions

1. **SDK 接入验收**：采用官方 SDK 且先不 fork 已确认；实施时验证 1.3.0 发布包在 Node 26、标准 HTTP/SSE 验证宿主、平台打包与错误边界下的行为；WSS 后验。项目取消／持久化适配方案见 2.5／2.6，不把 SDK 默认策略当作项目保证。
2. **通用 JSON 与材料提供**：input/output 保持 JSON 已确认；单 Data Part → input、output → Artifact.parts[].data 的通用映射细化尚待确认，不加 result 包装。固定版本材料提供契约仍需明确，不以选择具体业务 Agent 为前置条件。
3. **完整契约评审**：[contract.md](contract.md) 已统一其他公开操作、故障及关闭；limits 具体值、单 Part 映射、invalid-output 分类、构造等待取消和至多一次存储收尾等新增细化尚待评审，不把本文整理当作逐项批准。
4. **后续 WSS 鉴权联调（不阻塞模块验证）**：wss-contract.md 建议一连接一个可信主体、多个授权 tenant；需平台确认既有会话的主体／安装／有效期及网关委托映射。多主体转发不隐式支持，不能用 metadata 补身份。
5. **SDK 持久化运行验收**：源码确认 DatabaseTaskStore(trx) 可与一张项目表共用事务；仍须确认物理本地数据路径、迁移时机和实际锁版，运行验证三种原子边界、坏行校验、owner 隔离及关闭预算，不迁移 checkpoint。
6. **资源额度与有效期**：单帧字节、收发队列、活动流、分页、重连退避、最大重投窗口及过期规则仍待双方确定；实施前固定，无隐含无限值。
7. **后续 WSS 评审及库验收（暂缓）**：wss-contract.md 已规定首帧终态／终态状态／同 id 错误结束、非终态 done 转安全错误，不加退订或结束业务帧。Node 26 内置 headers 可用但公开 101 读取不足，建议 ws 公开接口；实际锁版及共享背压、断线 pending next、旧代际隔离与关闭预算仍须运行验收。
