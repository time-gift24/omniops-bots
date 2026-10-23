# A2A + LangGraph 开源集成核查

核查日期：2026-10-22。只读检查官方文档、固定提交的源码和依赖声明；没有安装依赖、运行模型或验证这些项目的运行时兼容性。

## 结论

有现成的 **TypeScript + LangGraph.js + 官方 A2A SDK** 接法。最贴近本仓的可读示例是 SAP 的 TypeScript 模板：`DefaultRequestHandler + TaskStore + AgentExecutor → LangGraph`。因此应先复用官方 SDK 的默认处理器、事件处理和存储扩展点，再针对本仓有明确差异的要求做最小适配；不能因为取消或幂等存在差异，就直接另写全部标准请求处理。该模板仍使用 SDK 0.3.10，适合参考组合方式，不能直接复制为 A2A 1.0 实现。[SAP TypeScript 模板](https://github.com/SAP-samples/joule-a2a-agent-toolkit/blob/7d284bd6d6e83f2ce9e3bf164689adc9db9ad4f1/skills/joule-a2a-agent/references/langgraph-a2a-agent-typescript.md)

在下列已检查的一手项目中，未找到一个同时满足 **SDK 1.3.0、可嵌入桌面 Node、WSS 自定义绑定、强 messageId 幂等、Run 排空后取消、重启不重跑、交付回执** 的即用集成。这个结论仅限此次核查范围，不代表整个开源生态都没有。

## 已核查的方案

| 方案 | 实际组成与版本 | 取消与持久化证据 | 本仓怎么用 |
|---|---|---|---|
| [SAP TypeScript LangGraph A2A 模板](https://github.com/SAP-samples/joule-a2a-agent-toolkit/blob/7d284bd6d6e83f2ce9e3bf164689adc9db9ad4f1/skills/joule-a2a-agent/references/langgraph-a2a-agent-typescript.md) | TS；官方 SDK **0.3.10**；Express；`DefaultRequestHandler`、`AgentExecutor`；LangGraph.js `createReactAgent`。AgentCard 明确 `protocolVersion: "0.3.0"`。 | `cancelTask` 只写内存 Set；消费到下一个 graph chunk 才发 canceled；没有把 AbortSignal 传给 graph。A2A 用 `InMemoryTaskStore`，graph 用 `MemorySaver`。 | 优先参考 SDK 扩展方式，不带入 SAP Provider、Express、聊天专用状态和旧 0.3 数据结构。它是模板而非已验证满足本仓生命周期的现成库。 |
| [官方 A2A LangGraph Python 示例](https://github.com/a2aproject/a2a-samples/blob/6603ba3f2c31a7ef33e70b9d8b5b5f8be42ac9a3/samples/python/agents/langgraph/app/agent_executor.py) | Python；A2A Python SDK；`DefaultRequestHandler → CurrencyAgentExecutor → CurrencyAgent.stream`，用 TaskUpdater 输出状态和 Artifact。 | executor 的 `cancel` 明确返回 `UnsupportedOperationError`。入口注入 `InMemoryTaskStore`；graph 用 `MemorySaver`，不是磁盘恢复方案。 | 官方框架桥接范例，可参考职责划分；不引入 Python 后端，也不能拿它证明取消已实现。 |
| [LangChain 自家 A2A-langgraph TS 示例](https://github.com/langchain-samples/A2A-langgraph/tree/379a7c0f632f45d3a413754b76bd41b0db2930f1/typescript) | TS graph；`@langchain/langgraph ^1.0.2`；**没有 `@a2a-js/sdk` 依赖**；通过 `langgraph-cli dev` 的 Agent Server 暴露 HTTP A2A。 | 示例只调用 `message/send`；不实现自己的 TaskStore、cancel 或恢复。实际能力来自另外运行的 Agent Server。 | 是部署/调用示例，不是可嵌入现有 runtime 的 TS A2A 桥接库。客户端示例仍是旧请求形状，应以当前 SDK 为准。 |
| [ctvs/a2a-langgraph-agent](https://github.com/ctvs/a2a-langgraph-agent/blob/9acb36027a213f744b26adbee30eeb537c7612f9/src/a2a/executor.ts) | 社区 TS 示例；官方 SDK **^0.2.2**，LangGraph **^0.3.5**；MCP、ReAct graph；`DefaultRequestHandler + AgentExecutor`。 | 同样是 Set + chunk 检查，没有 graph AbortSignal；Task、上下文历史、checkpoint 都在内存；测试脚本只是未配置占位。 | 可确认 TS 接法已经存在；版本和生命周期都不适合直接作为本仓依赖或 fork 起点。 |

版本证据分别见 [SAP 脚手架依赖](https://github.com/SAP-samples/joule-a2a-agent-toolkit/blob/7d284bd6d6e83f2ce9e3bf164689adc9db9ad4f1/skills/joule-a2a-agent/scripts/scaffold-ts.sh)、[Python 入口](https://github.com/a2aproject/a2a-samples/blob/6603ba3f2c31a7ef33e70b9d8b5b5f8be42ac9a3/samples/python/agents/langgraph/app/__main__.py)、[Python graph](https://github.com/a2aproject/a2a-samples/blob/6603ba3f2c31a7ef33e70b9d8b5b5f8be42ac9a3/samples/python/agents/langgraph/app/agent.py)、[LangChain TS package.json](https://github.com/langchain-samples/A2A-langgraph/blob/379a7c0f632f45d3a413754b76bd41b0db2930f1/typescript/package.json)、[社区 package.json](https://github.com/ctvs/a2a-langgraph-agent/blob/9acb36027a213f744b26adbee30eeb537c7612f9/package.json)。

### 容易误判的官方 JS coder 示例

`a2aproject/a2a-samples/samples/js/src/agents/coder` 是 **Genkit**，不是 LangGraph。它仍然正确展示了 SDK 的 `DefaultRequestHandler + TaskStore + AgentExecutor` 组合，但依赖是 `@a2a-js/sdk ^0.3.3`，存储是内存，取消也是 Set 标记；不能称为官方 A2A 1.0 + LangGraph.js 集成。[入口源码](https://github.com/a2aproject/a2a-samples/blob/6603ba3f2c31a7ef33e70b9d8b5b5f8be42ac9a3/samples/js/src/agents/coder/index.ts)、[Genkit 配置](https://github.com/a2aproject/a2a-samples/blob/6603ba3f2c31a7ef33e70b9d8b5b5f8be42ac9a3/samples/js/src/agents/coder/genkit.ts)、[依赖](https://github.com/a2aproject/a2a-samples/blob/6603ba3f2c31a7ef33e70b9d8b5b5f8be42ac9a3/samples/js/package.json)。

另外，直接检查 `a2aproject/a2a-js@29417a5bb4038f804f310ce4fffd267a9375aa90` 源码归档中 `src/samples/` 下全部 44 个 `.ts`、`.json`、`.md` 文件，未找到 `langgraph` 文本；samples 依赖含 Genkit，不含 LangGraph。这是对该固定提交的检索结果，不应扩写成“官方永远没有 LangGraph.js 示例”。[SDK samples 目录](https://github.com/a2aproject/a2a-js/tree/29417a5bb4038f804f310ce4fffd267a9375aa90/src/samples)、[samples 依赖](https://github.com/a2aproject/a2a-js/blob/29417a5bb4038f804f310ce4fffd267a9375aa90/src/samples/package.json)

## LangChain 官方 Agent Server 是否可以直接替代

最新官方文档声明 `/a2a/{assistant_id}` 支持 A2A 1.0 JSON-RPC，以及 SendMessage、SendStreamingMessage、GetTask、CancelTask、ListTasks 和 GetExtendedAgentCard；SubscribeToTask 尚未支持。它是 Agent Server 的 HTTP 能力，不是给本仓引入的 `@a2a-js/sdk` LangGraph adapter。文档还要求 A2A 文本/文件输入的 graph state 带 `messages`，与本仓先保留任意 JSON input/output 的方向不同。[固定版本官方文档](https://github.com/langchain-ai/docs/blob/0468ab1b1938455b336e1c7397afe5da589fb085/src/langsmith/server-a2a.mdx)

尤其不能只看“A2A 1.0”标签：该文档自己列出 TCK 已知差异，包括实际 Task/Part 和 SSE 事件仍用部分 0.3 形状、不读取 `A2A-Version`、SubscribeToTask 与 push 配置的错误码不符。文档没有给出可核验的服务端实现源码链接，因此这里不推断其取消排空和原子持久化语义，也不把它作为本仓的兼容性保证。[官方已知失败清单](https://docs.langchain.com/langsmith/server-a2a#what-agent-server-currently-fails)

## 当前 SDK 本身已有的能力，不应再造

本提案已核查的 SDK 1.3.0 发布源码为 `a2aproject/a2a-js@29417a5bb4038f804f310ce4fffd267a9375aa90`。它已经有协议类型、ProtoJSON、标准错误、JSON-RPC 分发、默认请求处理、事件总线、ResultManager、TaskStore 接口与数据库实现。

- **取消不是空白。** 官方 cancellable-agent 已用 `AgentExecutor.cancelTask` 与 execute 共同完成终态；本仓应把它接到现有 runtime 的取消/排空机制，而非另建图执行器。官方示例是有限步骤轮询，仍不能证明上游模型已撤销。[取消示例](https://github.com/a2aproject/a2a-js/blob/29417a5bb4038f804f310ce4fffd267a9375aa90/src/samples/agents/cancellable-agent/agent_executor.ts)
- **持久化不是只有内存。** SDK 的 `DatabaseTaskStore` 已支持 SQLite 等数据库，database-agent 展示实际组装；因此不应把“SDK 没有持久化”作为自建 Task 存储的理由。它需要 Kysely 与驱动，是否与本仓已有 SQLite/文件路径适配，应基于依赖和事务边界评估。[数据库实现](https://github.com/a2aproject/a2a-js/blob/29417a5bb4038f804f310ce4fffd267a9375aa90/src/server/database/task/store.ts)、[组装示例](https://github.com/a2aproject/a2a-js/blob/29417a5bb4038f804f310ce4fffd267a9375aa90/src/samples/agents/database-agent/index.ts)、[持久化指南](https://github.com/a2aproject/a2a-js/blob/29417a5bb4038f804f310ce4fffd267a9375aa90/docs/persistent-stores.md)
- **SDK 已有防止状态竞争的机制。** ResultManager 对同一作用域 Task 的写入串行化，在 statusUpdate 分支拦截终态被改成另一个状态；默认 EventBusManager 还有可注入的事件结算入口。它并非本仓要求的完整终态冻结：同态 status、artifact 和完整 Task 写入仍需在存储边界保证不可改写。优先利用既有串行化和事件处理，不能笼统写“SDK 没有状态机/锁，所以全部自写”。[ResultManager](https://github.com/a2aproject/a2a-js/blob/29417a5bb4038f804f310ce4fffd267a9375aa90/src/server/result_manager.ts)、[EventBusManager](https://github.com/a2aproject/a2a-js/blob/29417a5bb4038f804f310ce4fffd267a9375aa90/src/server/events/execution_event_bus_manager.ts)

## 必须区别对待的本仓要求

这些是接入政策，不能靠旧示例的 `cancelledTasks` 或 MemorySaver 自动满足：

1. **取消回包时机。** SDK 默认 cancel 路径会等待 executor/events 得到终态；本仓约定先返回 WORKING/stopping，Run 真正排空并持久化后才 CANCELED。默认处理器在没有活跃 event bus 时还可以直接记录 CANCELED；本仓必须有运行归属和停止证据。应仅在这条差异上评估公开包装/覆写，而非复制默认处理器。[默认 cancel 实现](https://github.com/a2aproject/a2a-js/blob/29417a5bb4038f804f310ce4fffd267a9375aa90/src/server/request_handler/default_request_handler.ts)
2. **持久化边界。** TaskStore 的 save/load/list、SDK 数据库 Task 快照和进程内锁，不能自动完成本仓的“messageId 强幂等 → 共享额度预留 → 接单落盘 → 执行”政策、Task/Run 关联、重启非终态收敛、独立交付回执。应把这些补在现有 store/事件结算扩展点周围；同一个 Task 必须只有一个权威写入路径。[TaskStore 契约](https://github.com/a2aproject/a2a-js/blob/29417a5bb4038f804f310ce4fffd267a9375aa90/src/server/store.ts)
3. **断线与执行分离。** 消费 SDK stream 的请求结束，不等于业务 Task 结束。需利用后台结算扩展点验证无人订阅时依然持久化；不能只把 `InMemoryTaskStore` 换成数据库便宣称完成。
4. **WSS 与回执。** SDK 标准 JSON-RPC 分发继续复用；本仓只补自定义 WSS 承载、可信身份/额度/路由、必需的 delivery-receipt 扩展，不实现另一份 A2A 协议。

本次不选择任何新业务 Agent，不迁移 runtime、不添加依赖、不 fork、不实施上述适配。提案已按“SDK 默认链路优先，逐项证明必须偏离的最小位置”收缩，SQLite 进一步核验如下。

## DatabaseTaskStore(SQLite) 事务核验补充

以下是 2026-10-22 的源码核验，不是运行验证。SDK 1.3.0 使用固定发布提交 `29417a5bb4038f804f310ce4fffd267a9375aa90`；Kysely 使用 0.29.5 的固定提交 `f24018c789c3cf7ad03ccc672ada63a1ded87f88`，在 SDK peer 允许的 ^0.29.0 范围内。npm 当前 latest 0.29.7 未据此被视为已验收；项目当前没有安装 SDK 或 Kysely。现有 lockfile 的 better-sqlite3 为 12.11.1，是 checkpoint 的传递依赖，后续直接使用仍应显式声明。

| 核验问题 | 源码结论 |
| --- | --- |
| SDK 有没有专用事务钩子？ | 没有 transaction/beforeSave API；它接受调用方的 Kysely。Kysely Transaction 继承 Kysely，因此 `db.transaction().execute(async trx => new DatabaseTaskStore(trx)...)` 可将 SDK 操作纳入调用方事务，不必自写 Task SQL。 |
| 事务对象会被 SDK 的方言检查拒绝吗？ | SDK dialectOf 读取公开 introspection；Transaction 保留 SQLite dialect，仍创建 SqliteIntrospector。读取 getter 不发查询。 |
| 受理需要多少自有存储？ | 设计只加一张项目表：全作用域 messageId 主键、唯一 SDK Task 关联、调用指纹／固定版本／thread/run、封存 SHA 与首次 receivedAt。SDK Task 表是唯一结果，不复制 Task。两表同事务提交。 |
| 终态为什么还要适配？ | DatabaseTaskStore.save 是全量 upsert，无终态 CAS／冻结。ResultManager 只对部分状态竞争有保护；须在受控 TaskStore.save 的短事务内查封存标记，委托 SDK save，再原子写 SHA。 |
| 如何避免锁死？ | Kysely SQLite 单连接互斥覆盖整个事务，回调内不能 await 根 db/store。ResultManager 的 Task 锁必须先于事务；不能持事务再 await processEvent。 |
| 是否能假定所有 caller scope 相同？ | 不能。SDK 默认 owner 与 ResultManager 锁都用 userName，但后者不读自定义 resolver。可信入口须规范化同一个非空 owner，避免 unknown 或多个锁对应同一行。 |
| SQLite 自动提供 IMMEDIATE／重试吗？ | 固定 driver 仅执行 BEGIN，是 DEFERRED；setIsolationLevel 不是 BEGIN IMMEDIATE。SDK／Kysely 不自动重试 BUSY。首版建议 A2A timeout=0，锁冲突作为存储失败，不映射运行额度 busy。 |
| SDK list 的吞错能用外层 catch 修好吗？ | 不能。解码坏行会在内部被 console.error 后跳过。公开 KyselyPlugin.transformResult 可在 SDK 收到查询结果、进入该循环前做定点安全校验；保留 SDK SQL／分页，使用公开 TaskRow 和 Task.fromJSON，不调用私有 fromTaskRow。钩子覆盖完整性仍须运行验证。 |

事务／锁证据：[SDK store](https://github.com/a2aproject/a2a-js/blob/29417a5bb4038f804f310ce4fffd267a9375aa90/src/server/database/task/store.ts)、[SDK dialect](https://github.com/a2aproject/a2a-js/blob/29417a5bb4038f804f310ce4fffd267a9375aa90/src/server/database/dialect.ts)、[Kysely Transaction 和 commit/rollback](https://github.com/kysely-org/kysely/blob/f24018c789c3cf7ad03ccc672ada63a1ded87f88/src/kysely.ts)、[SQLite adapter](https://github.com/kysely-org/kysely/blob/f24018c789c3cf7ad03ccc672ada63a1ded87f88/src/dialect/sqlite/sqlite-adapter.ts)、[RuntimeDriver 连接互斥](https://github.com/kysely-org/kysely/blob/f24018c789c3cf7ad03ccc672ada63a1ded87f88/src/driver/runtime-driver.ts)、[SQLite driver](https://github.com/kysely-org/kysely/blob/f24018c789c3cf7ad03ccc672ada63a1ded87f88/src/dialect/sqlite/sqlite-driver.ts)。

错误／scope 证据：[SDK 公共数据库导出](https://github.com/a2aproject/a2a-js/blob/29417a5bb4038f804f310ce4fffd267a9375aa90/src/server/database/index.ts)、[owner](https://github.com/a2aproject/a2a-js/blob/29417a5bb4038f804f310ce4fffd267a9375aa90/src/server/owner_resolver.ts)、[ResultManager 锁](https://github.com/a2aproject/a2a-js/blob/29417a5bb4038f804f310ce4fffd267a9375aa90/src/server/result_manager.ts)、[Kysely 插件契约](https://github.com/kysely-org/kysely/blob/f24018c789c3cf7ad03ccc672ada63a1ded87f88/src/plugin/kysely-plugin.ts)、[结果校验的执行位置](https://github.com/kysely-org/kysely/blob/f24018c789c3cf7ad03ccc672ada63a1ded87f88/src/query-executor/query-executor-base.ts)。

具体三个事务及冻结比较规则已写入 [design.md 第 5 节](design.md)。实际物理路径／迁移、Node 26 与两平台打包、回滚／提交不明、并发重复、owner 隔离、迟到事件、坏行输出和关闭预算尚未运行验收；不把源码可组合写成已验证成功。

## WSS 接入源码核验补充

2026-10-22 继续只读核对 SDK 1.3.0、随包 Node 26.11.1 及 ws 公开 API；未安装依赖或运行连接。完整接入评审稿见 [wss-contract.md](wss-contract.md)。

- SDK JsonRpcTransportHandler.handle 返回普通 JSONRPCResponse 或 AsyncGenerator。流异常直接向消费者抛出，正常 done 不补结束帧；adapter 必须捕获并复用公开 mapToJSONRPCError。handle 不做版本校验、背压或连接清理。[transport](https://github.com/a2aproject/a2a-js/blob/29417a5bb4038f804f310ce4fffd267a9375aa90/src/server/transports/jsonrpc/jsonrpc_transport_handler.ts)
- validateVersion 的第三参允许自定义 binding URN；Extensions.parseServiceParameter/toServiceParameter、头常量和 context.addActivatedExtension 已公开。requested 与 activated 不相同；默认发送检查不自动激活扩展，替换发送路径后不能漏检查。[version](https://github.com/a2aproject/a2a-js/blob/29417a5bb4038f804f310ce4fffd267a9375aa90/src/server/version.ts)、[根导出](https://github.com/a2aproject/a2a-js/blob/29417a5bb4038f804f310ce4fffd267a9375aa90/src/index.ts)、[context](https://github.com/a2aproject/a2a-js/blob/29417a5bb4038f804f310ce4fffd267a9375aa90/src/server/context.ts)
- 默认 resubscribe 没有活跃 bus 时可以在非终态快照后结束，故不能把 generator done 当 Task 终态；pending next 时仅 return 不保证解除等待。queue.stop 会唤醒并解绑，应通过公开队列／每调用 bus 接入点清理，不取消运行。[handler](https://github.com/a2aproject/a2a-js/blob/29417a5bb4038f804f310ce4fffd267a9375aa90/src/server/request_handler/default_request_handler.ts)、[queue](https://github.com/a2aproject/a2a-js/blob/29417a5bb4038f804f310ce4fffd267a9375aa90/src/server/events/execution_event_queue.ts)
- Node 26.11.1 固定提交 364593d0631def13e3043dd84f77ebca2c767ce5 的内置 WebSocket 第二参支持 Undici headers 扩展，能发送认证和 A2A 头。但实例无公开 101 响应头／upgrade／send callback，不能靠内部 diagnostics channel 实现业务协商。[随包文档](https://github.com/nodejs/node/blob/364593d0631def13e3043dd84f77ebca2c767ce5/deps/undici/src/docs/docs/api/WebSocket.md)、[实现](https://github.com/nodejs/node/blob/364593d0631def13e3043dd84f77ebca2c767ce5/deps/undici/src/lib/web/websocket/websocket.js)
- ws 提供 headers、upgrade、send callback、bufferedAmount、maxPayload、handshakeTimeout 和 close/terminate。upgrade 在其 RFC 握手验证结束前触发；send 无背压 boolean，WebSocket 对象无 drain；callback 不是业务交付，默认 payload／关闭等待不能充当项目限额。固定提交 dabbdec92f4c1f1777689733d477344e3c6c2e67 仅是核验依据，尚未选安装版，本仓 runtime lock 也无 node_modules/ws。[公开文档](https://github.com/websockets/ws/blob/dabbdec92f4c1f1777689733d477344e3c6c2e67/doc/ws.md)、[握手实现](https://github.com/websockets/ws/blob/dabbdec92f4c1f1777689733d477344e3c6c2e67/lib/websocket.js)

单主体委托、有效期来源和传输数值仍需外部平台确认；以上源码并不自动提供本仓的鉴权或互操作保证。不增加第二套认证协议，不把 Task 原始正文／凭据当遥测。

## 外部 Agent 独立验收：先标准 HTTP/SSE，WSS 后接

当前用户要求先完善模块契约及验证门槛，不实施。固定 SDK 提交的公开源码进一步确认：

- [ClientFactory](https://github.com/a2aproject/a2a-js/blob/29417a5bb4038f804f310ce4fffd267a9375aa90/src/client/factory.ts) 可从 URL／AgentCard 创建标准 client，按 supportedInterfaces 选择 JSONRPC，并按卡片 tenant 包装 transport；无需先实现 WSS client。
- [SDK Express JSON-RPC handler](https://github.com/a2aproject/a2a-js/blob/29417a5bb4038f804f310ce4fffd267a9375aa90/src/server/express/json_rpc_handler.ts) 公开 userBuilder/contextBuilder，内部复用 JsonRpcTransportHandler、validateVersion(...,'JSONRPC')、SSE 及 activatedExtensions 响应头。Express 是可选 peer，可仅用于 loopback 临时验收宿主，不进入 service 核心或新增产品服务。
- 该 middleware 的默认 express.json 上限、直接 res.write、没有绑定断开 AbortSignal，以及错误路径 console.error 都不能作为模块安全／背压保证。验收宿主用 synthetic 数据、可信测试身份、自定义不保留 headers 的 contextBuilder、请求预算与等待取消；服务边界只输出安全错误。这里不是生产 HTTP 宿主已满足全部要求的证据。
- [Client](https://github.com/a2aproject/a2a-js/blob/29417a5bb4038f804f310ce4fffd267a9375aa90/src/client/multitransport-client.ts) 默认阻塞；显式 request.configuration.returnImmediately 会保留。它会按卡片在本地拒绝部分 push 操作，所以 Server 不支持路径须用[公开 JsonRpcTransport](https://github.com/a2aproject/a2a-js/blob/29417a5bb4038f804f310ce4fffd267a9375aa90/src/client/transports/json_rpc_transport.ts) 或受控标准请求实际送达，不能以 client 本地异常替代。
- [ServiceParameters](https://github.com/a2aproject/a2a-js/blob/29417a5bb4038f804f310ce4fffd267a9375aa90/src/client/service-parameters.ts) 提供 withA2AVersion／withA2AExtensions；请求参数和版本／扩展处理继续使用公开 SDK。ConfirmTaskDelivery 没有 SDK 高层 client 方法，只补唯一扩展调用。

源码核验与契约可行性不等于运行通过。验收须分别提供：真实 SDK／SQLite 加 runtime fake 的模块证据、真实 runtime／LangGraph 加本地模型 fixture 的集成证据、独立外部 Agent 经 HTTP/SSE 的完整闭环证据。细节及黑盒交付条件见 [contract.md 第 10 节](contract.md)。不安装依赖、不创建 A2A 实现、不运行模型／数据库验收；WSS 草案暂缓。
