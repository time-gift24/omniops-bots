# A2AService 公开契约

状态：**已按用户明确指令实施，WSS 暂缓**。实现入口为 `desktop/runtime/a2a/index.ts`。官方 SDK、统一 TS、通用 JSON 边界和 SDK Task 表＋一张项目扩展表均已落地；实际验证及平台限制见 [verification.md](verification.md)。以下接口和行为为本阶段公开契约，生产网络身份与 WSS 参数另行评审。

协议／SDK 基线为 A2A 1.0／SDK 1.3.0；Kysely 事务核验基于 0.29.5。SDK 行为依据固定[公开 handler](https://github.com/a2aproject/a2a-js/blob/29417a5bb4038f804f310ce4fffd267a9375aa90/src/server/request_handler/a2a_request_handler.ts)。当前优先级是外部 Agent 经标准 A2A 调用完成任务，独立验证模块后再接 WSS；WSS 接入草案暂缓，另见 [wss-contract.md](wss-contract.md)。实现依据见 [design.md](design.md)，源码核验见 [research-a2a-langgraph.md](research-a2a-langgraph.md)。下列 TS 对应实际公开入口；协议类型与方法直接来自 SDK。

## 1. 公开导出与创建

由 `desktop/runtime/a2a/index.ts` 导出 `createA2AService` 及以下项目类型。协议类型、请求、状态、错误直接使用 SDK；运行数据类型直接复用已约定的 runtime 导出，不建立第二套协议 facade、执行器或 TaskService。

```ts
import type { AgentCard } from '@a2a-js/sdk';
import type {
  A2ARequestHandler, ServerCallContext,
} from '@a2a-js/sdk/server';
import type { RemoteRunAdmission } from '../runtime.ts';

export type A2APrincipal = Readonly<{
  organizationId: string;
  callerId: string;
  installationId: string;
}>;
export type OfficialEndpoint = Readonly<{
  agentId: string;
  contentId: string;
  card: AgentCard;
}>;
export type ResolveEndpoint = (
  context: ServerCallContext,
  tenant: string,
  options: Readonly<{ signal: AbortSignal }>,
) => Promise<OfficialEndpoint>;
export type A2ALimits = Readonly<{
  maxRequestBytes: number;
  maxTaskBytes: number;
  maxJsonDepth: number;
  maxWaiters: number;
  maxSubscriptions: number;
}>;
export type A2AServiceOptions = Readonly<{
  directory: string;
  runtime: RemoteRunAdmission;
  resolveEndpoint: ResolveEndpoint;
  limits: A2ALimits;
}>;
export type CallOptions = Readonly<{ signal?: AbortSignal }>;
export type CloseOptions = Readonly<{ deadline: number }>;
export type DeliveryReceipt = Readonly<{
  tenant: string;
  taskId: string;
  resultSha256: string;
  receivedAt: string;
}>;
export type DeliveryConfirmation = Readonly<{
  taskId: string;
  resultSha256: string;
}>;
export interface A2AService {
  protocolFor(
    context: ServerCallContext,
    tenant: string,
    options?: CallOptions,
  ): Promise<A2ARequestHandler>;
  confirmTaskDelivery(
    request: DeliveryReceipt,
    context: ServerCallContext,
    options?: CallOptions,
  ): Promise<DeliveryConfirmation>;
  close(options: CloseOptions): Promise<void>;
}
export declare function createA2AService(
  options: A2AServiceOptions,
  callOptions?: CallOptions,
): Promise<A2AService>;
```

limits、构造等待 signal 和下述固定文件布局已按本阶段契约实现。限额没有隐含无限值或运行中热修改；模块限额由应用入口和独立验收用例固定，不等待 WSS 联调，构造时全部必填、为正的安全整数。WSS 的帧／收发队列限制由传输层另行管理，不混入本服务配置。

| 构造输入 | 校验与职责 |
| --- | --- |
| directory | 应用入口选择的专用绝对目录，归属当前安装；服务自有文件固定为 `<directory>/a2a.sqlite`，不接受远端路径，不与 checkpoint 共用文件／句柄 |
| runtime | 已有 runtime 的 RemoteRunAdmission；仅 reserveRun，预留对象提供 execute/requestStop/release，不传整套 dispatch 或 graph 准备回调 |
| resolveEndpoint | 本地官方目录与授权边界，同时核验组织、caller、安装和 tenant，返回固定 agentId/contentId 与标准卡片；预期失败用现有 RuntimeError 的 authentication／forbidden／storage／unavailable 分类拒绝，非法依赖返回值按不可用处理，不暴露原始异常；不装配图、不发起材料同步，不以材料丢失阻断已授权历史查询 |
| maxRequestBytes | 标准请求／扩展请求的完整规范 JSON 的 UTF-8 字节上限，含 Message、data 和 metadata；WSS 在 SDK 转换前先做原报文预检，直接调用也检查 |
| maxTaskBytes | 完整标准 Task 的 ProtoJSON 字节上限，包含原 Message、Artifact、history 和 metadata；受理前必须预留可持久保存安全失败终态的空间，不能接受无法结算的输入 |
| maxJsonDepth | 请求、业务 input/output 与标准 metadata 的 JSON 最大深度，标准 JSON 根层为 0，每进入一层对象／数组加 1，不计算 SDK 内部 oneof 包装；JSON 不允许循环、bigint、undefined、非有限数字或非 JSON 对象 |
| maxWaiters／maxSubscriptions | 本实例全局的阻塞 SendMessage 等待数、活动任务流数；重复请求同样计数，按需要等待／第一次 next 才占用，结束／失败／取消时归还 |

构造先验证参数和依赖，再打开自有 SQLite，核验并按已批准升级方案准备 SDK 表及项目表。完整性检查、两表关联检查及遗留非终态收敛提交成功后才返回；没有 ready/start 的二阶段公开入口。已终态结果保持原样，遗留非终态保存 FAILED/interrupted-unknown，不装配 Agent、不恢复图或页面。

目录必须为空，或仅包含本模块的 `a2a.sqlite` 及 SQLite sidecar；拒绝根目录、home、共享临时目录及其祖先、符号链接和 POSIX 下其他用户所有的目录。新建目录使用 0700，新数据库在打开前以 0600 排他创建；不改变既有目录权限，不修改未通过格式检查的既有数据库权限。Windows 不调用 POSIX chmod，仍校验目录用途和文件类型。

构造失败或构造等待取消时不返回半初始化对象，清理已经取得的自有资源；不关闭借入 runtime，不删除已有数据。signal 只阻止尚未开始的步骤，不能硬中断同步 SQLite 操作；已经提交的升级或恢复不能假装回滚。

## 2. 调用上下文、路由与资源归属

- 每个 RPC 使用新的 SDK ServerCallContext，显式指定 requestedVersion 为 `1.0`，从可信接入边界取得所请求的必需交付扩展；不依赖 SDK 缺省的旧版兼容行为，不存原始认证头。
- `context.user.isAuthenticated` 必须为 true。受控 state 的 `omniops.principal` 保存可信 A2APrincipal；`userName` 是该组织／caller／安装元组经确定规范编码派生的非空作用域键，与 SDK owner 及 ResultManager 锁一致，不能采用消息自报值或 unknown 回退。派生格式在本稿固定为 `omniops-v1:` 加 `SHA256(RFC8785([organizationId, callerId, installationId]))` 的小写十六进制，不由调用方各自拼接。
- `omniops.waitSignal` 可保存该次调用的 AbortSignal；本地 CallOptions.signal 与它任一取消均结束本次等待。信号不进入已受理任务的 runtime 生命周期，不因 caller 断线撤销任务。
- `protocolFor` 验证可信上下文、tenant、版本、扩展及逻辑入口；服务版本检查直接调用 SDK validateVersion(version, card)，不硬编码某种 transport；绑定与版本的配对检查由入口调用 SDK validateVersion(version, card, binding)。独立验证采用 JSONRPC，SDK jsonRpcHandler 已执行该绑定检查；仅使用 JsonRpcTransportHandler.handle 时入口必须自行补齐，不能假定它会校验。必需扩展检查并收窄 requested 集合后，实际启用 receipt 语义时调用 context.addActivatedExtension，不能把 requested 当 activated。返回绑定固定入口的 SDK A2ARequestHandler；不受理 Task、不预留运行名额。缓存仅绑定不可变入口，不绑定 caller 或某次 signal。
- 使用 SDK JsonRpcTransportHandler 时 context 初始不设置 tenant，由 SDK 从 params 设置一次；本地直接调 handler 时先显式 setTenant 一次。params、context 与绑定入口的 tenant 必须一致。不能把同一 context 用于第二个 RPC。
- resolveEndpoint 收到的 signal 由服务派生，关联关闭与本次等待；取消后停止解析／清理其自有操作，不与既有 Task 的运行信号共用。
- 所有带 context 的方法每次重验归属与权限。getAgentCard 没有 context，返回先前 protocolFor 选择的非敏感标准卡片快照；不据此增加远端发现方法。返回对象均为独立快照，修改它不改变内部状态。
- 服务拥有 SQLite／Kysely、SDK handler、总线、订阅、路由解析及远端执行／结算跟踪；runtime、Provider、浏览器宿主、checkpoint、WSS 和应用退出协调器属于借入／外部资源。服务只释放自己的资源。

## 3. 标准公开方法：直接采用 SDK 签名

下表是已选 SDK 的方法索引，不在仓库重声明另一份 A2ARequestHandler。`c` 的完整类型均为 ServerCallContext；请求、返回类型均来自 SDK 根入口；流返回类型统一为 `AsyncGenerator<StreamResponse, void, undefined>`。JSON-RPC 返回包装、字段转换与方法名映射交给 SDK。

| SDK 完整方法签名 | Wire 操作／本产品行为 |
| --- | --- |
| `getAgentCard(): Promise<AgentCard>` | 本地元数据读取；返回固定官方版本的卡片，closing 后拒绝 |
| `sendMessage(p: SendMessageRequest, c: ServerCallContext): Promise<Message \| Task>` | SendMessage；SDK 返回联合类型保留，本产品只返回 Task。省略／false 的 returnImmediately 等待持久终态，true 在受理提交后返回；已有终态重投直接返回 |
| `sendMessageStream(p: SendMessageRequest, c: ServerCallContext): AsyncGenerator<StreamResponse, void, undefined>` | SendStreamingMessage；首次 next 才校验、受理或查重；首帧为已持久 Task，随后只发任务级状态和最终 Artifact；已终态重投只发终态快照后结束。returnImmediately 不改变流行为 |
| `getTask(p: GetTaskRequest, c: ServerCallContext): Promise<Task>` | GetTask；tenant、id、可选 historyLength；只读已提交快照，包含完整最终 Artifact，不标记交付 |
| `listTasks(p: ListTasksRequest, c: ServerCallContext): Promise<ListTasksResponse>` | ListTasks；只查授权逻辑入口，保留 SDK 筛选、分页和投影，不触发执行／交付 |
| `resubscribe(p: SubscribeToTaskRequest, c: ServerCallContext): AsyncGenerator<StreamResponse, void, undefined>` | SubscribeToTask；tenant、id；先挂监听再读快照，已终态返回 UnsupportedOperationError，调用方用 GetTask |
| `cancelTask(p: CancelTaskRequest, c: ServerCallContext): Promise<Task>` | CancelTask；tenant、id、可选标准 metadata；以真实 requestStop 结果判断，只提出停止，不把接到请求当终态 |
| `getAuthenticatedExtendedAgentCard(p: GetExtendedAgentCardRequest, c: ServerCallContext): Promise<AgentCard>` | GetExtendedAgentCard；首版 extendedAgentCard=false，复用 SDK UnsupportedOperationError |
| `createTaskPushNotificationConfig(p: TaskPushNotificationConfig, c: ServerCallContext): Promise<TaskPushNotificationConfig>` | CreateTaskPushNotificationConfig；首版 pushNotifications=false，复用 SDK PushNotificationNotSupportedError |
| `getTaskPushNotificationConfig(p: GetTaskPushNotificationConfigRequest, c: ServerCallContext): Promise<TaskPushNotificationConfig>` | GetTaskPushNotificationConfig；同上，不伪造配置不存在 |
| `listTaskPushNotificationConfigs(p: ListTaskPushNotificationConfigsRequest, c: ServerCallContext): Promise<ListTaskPushNotificationConfigsResponse>` | ListTaskPushNotificationConfigs；同上，不返回空列表成功 |
| `deleteTaskPushNotificationConfig(p: DeleteTaskPushNotificationConfigRequest, c: ServerCallContext): Promise<void>` | DeleteTaskPushNotificationConfig；同上。若以后启用，标准删除响应包装仍由 SDK 处理 |

SDK DefaultRequestHandler 继续承担查询、订阅、扩展卡片与四个 push 操作，共 8 个标准操作；getAgentCard 也复用。仅发送两方法与取消做差异适配，保留共同授权、输入和 closing 检查。标准可选能力关闭也不跳过这些检查。

ListTasks 使用标准 contextId、status、statusTimestampAfter、pageSize、pageToken、includeArtifacts；pageSize 缺省 50、范围 1～100。includeArtifacts 缺省 false，列表投影不用于计算交付摘要。historyLength 为 0 不返回历史，正整数至多返回指定条数，省略返回有界协议历史。每 Task 仅保存本次输入及停止／终态等有限协议 Message，无模型或工具历史。分页游标只用于当前授权查询，不作为权限凭据；不改 SDK 游标编码，不额外承诺 SDK 没有的签名绑定或冻结全集。

## 4. 业务数据与持久化顺序

首版通用映射建议为：输入的 role 为 ROLE_USER，恰好一个 Data Part，mediaType 缺省或为 `application/json`（缺省按 JSON 解释），data 是 JSON 对象；runtime output 为任意 JSON 值，直接成为最终 Artifact 的 Part.data，保留 0／false／null，不加 result 信封。额外文本／文件业务 Part 不隐式转聊天输入。缺少必要输入、需登录／验证不挂起，保存 FAILED/missing-input 或 FAILED/login-required；处理后由新 messageId 发起新 Task。

configuration.acceptedOutputModes 缺省或包含 application/json 时可用；不接受 JSON 的请求返回 ContentTypeNotSupportedError，不临时转成文本。首版在 SendMessage／SendStreamingMessage 携带 taskPushNotificationConfig 也返回 PushNotificationNotSupportedError，不能静默忽略。

首次 Message 不指定 taskId；未知 taskId 为 TaskNotFound，向已存在 Task 发新业务 Message 明确不支持继续执行。contextId 只作业务关联，不复用 thread／图／页面；metadata 不得覆盖本机 Provider、版本或凭据。业务 output 非 JSON、过深或无法放入已预留的终态预算时，保存安全 FAILED/invalid-output，不截断伪造业务结果。该 reasonCode 是本轮补充的结果适配分类，不增加协议状态或数字码。

受理和结算固定按以下顺序进行：

1. 校验与授权，事务内以组织／caller／安装／messageId 查重并比对固定入口、版本和规范业务内容；RPC id、等待及分页不参与身份。
2. 仅新消息同步预留 runtime 名额，事务内用 SDK store.save 和一张项目表一起保存 Task／消息身份／thread/run 关联；额度满则持久 REJECTED/busy，无运行资源、不排队。
3. commit 成功后只调用一次 reservation.execute，传 `{threadId, runId, agent: {agentId, contentId}, input}`。runtime 在内部装配并复用 execution，返回既有 ExecutionOutcome，不接收 RPC、Task 或图准备回调。
4. 后台 Promise 等待实际执行排空、cleanup 和 Run 结算；经 ResultManager 与受控 TaskStore.save，在同一事务保存完整终态 Task／Artifact 和项目行的 resultSha256。
5. commit 成功后 release 名额，最后发布终态；发布／确认不占运行容量，网络背压不影响提交。原终态、摘要和幂等身份不会因确认或重启删除。

SDK Task 表保存唯一 Task；项目表只保存消息身份、固定版本／运行关联、封存 SHA 和首次 receivedAt。事务内用 new DatabaseTaskStore(trx)，不调用根 db/store，不在事务中 await ResultManager、图或网络。锁顺序为 ResultManager Task 锁 → 短事务。

终态冻结检查覆盖完整规范 Task；完全相同重复保存不写入、不再次广播，不同内容拒绝。交付摘要仍只取 SDK Task.toJSON 后的 `{id, contextId, status, artifacts}`，缺省 artifacts 为 []，按 RFC 8785／SHA-256；history、metadata 和确认字段不参与。摘要在标准 metadata 的交付扩展 URI 命名空间公布。

## 5. 交付确认与三种取消

`confirmTaskDelivery` 是唯一业务扩展，对应 `omniops/ConfirmTaskDelivery`，不是第 12 个 A2A 标准操作。tenant／taskId 必须属于可信 caller，resultSha256 为 64 位小写十六进制，receivedAt 为有效 RFC 3339 时间。事务内校验完整终态与封存／请求摘要后，仅更新项目行首次 receivedAt；提交成功才返回 DeliveryConfirmation。重复同摘要返回相同结果并保留第一次时间，不调用 SDK save、不改 Task、不触发执行。

| 操作 | 影响 |
| --- | --- |
| 等待 signal、断线、迭代器 return | 结束这次等待／订阅并清理监听、队列和名额；不调用 requestStop，后台执行和结算继续。next 正在等待时也须解除，不能仅 Promise.race 留下监听 |
| CancelTask | 可取消时 requestStop 锁存停止，保存／返回 WORKING 与正在停止提示；实际排空及取消终态提交后才 CANCELED。重复未完成停止不重复操作／发事件；结果固定或已终态均 TaskNotCancelableError |
| close | 应用最终退出阶段停止服务归属的剩余任务、排空并关闭自有资源，详见第 7 节；不作为远端方法 |

signal 在持久提交前已生效则不开始新副作用；提交竞争以数据库实际结果为准。已提交受理／回执或已发出的停止意图不会因响应丢失或等待取消撤销。调用方用原 messageId 查原 Task，确认用原 receipt 重试；不新建执行推断上一次结果。

服务跟踪后台执行／提交 Promise，不依赖消费者迭代来持久化。每条流只发送一个当前 Task 首帧；该快照由调用读取，不在共享总线重复广播初始 Task。共享总线每 Task 最多一次停止提示、一个最终 Artifact、一个终态状态，不转发 token／工具进度；利用这最多 3 个后续事件、maxTaskBytes 和活动订阅上限约束 SDK 队列。经公开 bus manager 为各等待者提供可单独 finished 的 SDK 总线，结束一个等待不结束共享总线。传输输出队列须独立有界；等待／流故障不停止 Task。后续 WSS 的共享写入器无法继续时可关闭整条连接，不能笼统承诺只关闭一个流。

## 6. 错误契约

构造／close 复用 RuntimeError 的安全 kind/message；协议方法及 protocolFor／confirmTaskDelivery 的业务失败转换为 SDK 公共错误类。异步方法通过 Promise 拒绝，流方法从 next 拒绝；不返回成功形状里的 error 字段。Node 内部保留 RuntimeError／ExecutionError 和来源，对外不发送 cause、cleanupErrors、原始 SQL／协议或依赖消息。

公开 SDK 错误对象本身也不挂原始 cause，避免 SDK 宿主打印整个 Error 时泄漏来源链；来源仅保留在模块私有弱引用中。运行或存储故障结束并移除共享事件总线，后续订阅读取已提交快照后以安全错误结束，不等待已经结束的总线再次发事件。

| 情况 | 调用者可见结果／后续行为 |
| --- | --- |
| 构造参数、limit、deadline 无效 | 本地 RuntimeError('invalid-request')；首次无效 close 不进入 closing |
| 构造等待取消 | 本地 RuntimeError('aborted')；先完成已开始步骤的资源清理，不声称同步 SQL 已撤销 |
| 构造、schema、记录关联或 SQLite 失败 | 本地 RuntimeError('storage')；不返回服务，不静默重建或覆盖旧数据 |
| 请求字段／JSON／大小无效、同消息不同内容、错摘要或未终态确认 | SDK RequestMalformedError，对应 Invalid params -32602；不改变原 Task |
| Task 不存在或不可访问 | SDK TaskNotFoundError -32001，相同安全摘要；不泄露另一主体记录 |
| 结果已固定或已终态取消 | SDK TaskNotCancelableError -32002，保留原结果 |
| 可选推送／扩展卡片关闭，或已终态订阅 | SDK PushNotificationNotSupportedError -32003／UnsupportedOperationError -32004 |
| 不支持的业务 Part | SDK ContentTypeNotSupportedError -32005 |
| 版本／必需扩展不满足 | SDK VersionNotSupportedError -32009／ExtensionSupportRequiredError -32008；不受理新 Task |
| 缺少可信身份／入口授权失败 | SDK A2AError，受控 category 为 authentication／forbidden；不受理 Task，接入级处理由可信 transport 承担 |
| 非法目录依赖返回值、资源限额、关闭或未知运行依赖故障 | SDK A2AError，受控 category 为 unavailable／resource-limit／unknown，安全 Internal error -32603；资源限额不会创建 REJECTED/busy |
| SQLite BUSY、事务／坏行／封存一致性失败 | 安全存储不可用，协议面 Internal error -32603；不是执行额度 busy，不重试图或模型 |
| 协议调用等待取消 | 释放等待；连接已断开无响应义务，仍需响应时用安全 SDK A2AError，不伪造 Task 取消 |
| close 工作失败／预算耗尽 | 本地 RuntimeError('storage'／'unavailable'／'timeout'／'unknown')；保留实际证据及未完成归属，后续资源关闭继续 |

通用 SDK A2AError 的 metadata.category 只允许 authentication、forbidden、storage、resource-limit、unavailable、aborted、unknown，复用 SDK ErrorInfo.metadata 序列化；不能从任意异常文本生成分类或细节。表中的本地 RuntimeError 安全 kind 由边界映射到这些受控值，不新建错误类。

认证与入口授权失败必须拒绝；trusted context 缺失不是接受匿名调用的理由。生产认证／权限的接入表达留在后续平台联调；独立验收用受控测试身份并覆盖拒绝路径，本文不自造认证数字码；不能把它们装成 Task 业务失败。JSON 解析／RPC 信封／未知方法错误由接入预检和 SDK JsonRpcTransportError／公开常量表达 -32700／-32600／-32601，不另写 A2A 错误类或数字码注册表。

受理后模型／准备／工具等 ExecutionOutcome 失败必须结算原 Task：COMPLETED、FAILED 或 CANCELED；失败原因使用标准 TaskStatus.message 的安全文本和 Data Part `{reasonCode, safeMessage}`，不是 RPC 错误替代终态。业务失败与 SQLite 失败分开：后者不能伪造结果已保存。

| 持久化失败位置 | 服务处理 |
| --- | --- |
| 受理提交前失败 | 确认事务未提交后释放未执行预留，不 execute；提交不明则核对原 messageId，不能删除未知提交或报告绝未受理 |
| Run 已结算、Task 终态提交失败 | 不发布终态、不 release，保留固定候选结果并暂停新远端受理；已有已提交结果仍可查询（以存储可用为前提），不把内存候选混进去 |
| 确认提交失败 | 原终态继续可查，仍待确认；调用方重复原 receipt，不执行 Task |

首版不新增修复 API或后台无限重试。关闭时若有明确的固定候选终态且预算允许，建议最多再做一次原结果的持久化收尾；不能重跑执行或重建成功结果。存储故障后不自动重新开放新受理，重新启动并通过检查后才恢复。

SDK list 内部的坏行吞错／原始 console 输出不能靠外层 catch 修复；通过公开 KyselyPlugin.transformResult 与 SDK Task.fromJSON 进行查询结果安全校验，保留 SDK SQL／分页。该路径必须验证后才能认定满足契约，不替换全局 console。新增日志、span、指标仍为零。

## 7. close 的完整流程

正常产品退出有运行任务时先阻止并提示等待；单个调用／传输断开、页面切换或关闭调试视图不调用 close。以下仅供应用已经进入最终退出流程时使用。

`deadline` 是同一 Node 进程 `performance.now()` 的绝对毫秒值，必须有限非负。首次有效 close 建立唯一关闭工作；后续有效调用共享同一工作与结果，新的 deadline 不延长预算（不要求 Promise 引用相等）。成功重复仍成功，失败重复仍报告原失败；不提供重新打开／reset 方法。

1. **封闭入口**：立即 open → closing，拒绝所有新公开调用，包括已返回 handler 的查询、订阅、卡片与确认；已有等待以 unavailable 结束，取消路由解析。已进入的事务仍受跟踪，不把结束等待当作事务回滚。
2. **圈定受理竞争**：未提交的受理在提交前再检查 closing，回滚并释放未执行预留；已经提交或正在提交的操作必须纳入关闭跟踪，不能漏掉刚受理的任务。回执已提交则保留，即使响应已丢失。
3. **发出停止**：对归属本服务且仍可取消的预留 requestStop；result-fixed 的保留原结果。停止请求只发一次，不改变其他本地／实验任务，也不等待远端确认。
4. **结算**：等待真实操作与 cleanup、Run 记录、Task／SHA 原子提交及 release；固定候选的至多一次存储收尾也消耗同一预算。一项失败仍处理其他项，汇总安全错误；不等待 socket 可写、结果送达或 receipt。
5. **释放自有资源**：清理所有监听、调用总线、队列和缓存，确认自有事务已结束后由 Kysely.destroy 关闭其 SQLite 连接；不再额外 close 同一个底层句柄，不关闭 runtime、checkpoint、Provider、浏览器宿主或 WSS。
6. **结算 close**：上述实际工作均完成才 resolve 并进入 closed。失败则拒绝，入口继续封闭；deadline 到达优先报告 timeout，未结束操作继续归属跟踪，不能标成已关闭／已取消。不得在事务仍进行时销毁连接制造“清理完成”。过期但格式有效的首次 deadline 也封闭入口、发必要停止意图并立即报告超时。

A2A SQLite 建议显式 timeout=0，遇锁立即安全失败；同步磁盘操作仍不承诺可被 deadline 硬中断。预算耗尽后不能再次无限等数据库或线程；应用退出协调器保留最终硬退出责任，下一次启动按 interrupted-unknown 收敛遗留任务。

应用入口使用一个 deadline，依次尝试：停止新入口请求并关闭验证宿主（后续为 adapter.close）→ a2a.close → runtime.close → checkpoint／其余宿主依赖 → 子进程退出。任一步失败也继续后续步骤，记录并汇总原错误，不重置预算。仍需排空工作的私有宿主回调在需要时保持可用。runtime.close 的 deadline 参数及 TS 入口已同步实现。

当前上述 A2AService 组装顺序由独立验收宿主验证；桌面 `main.ts` 尚未创建该服务，因此没有生产 `a2a.close` 调用。生产鉴权、transport 与桌面生命周期组装一并留到后续接入，不能将验收宿主视为桌面任务通道已经上线。

## 8. 仅经公开入口的调用示例

context 已由可信入口创建，带 user、principal、协商版本／扩展，初始 tenant 未设置；service 由应用入口创建并持有，不随每次 RPC 销毁。下例只展示直接 SDK 调用边界，不包含私有存储／运行桥接：

```ts
import { SendMessageRequest } from '@a2a-js/sdk';
import type { Message, Task } from '@a2a-js/sdk';
import type { ServerCallContext } from '@a2a-js/sdk/server';
import type { JsonObject } from '../runtime.ts';

async function submit(
  service: A2AService,
  context: ServerCallContext,
  tenant: string,
  messageId: string,
  input: JsonObject,
): Promise<Message | Task> {
  const handler = await service.protocolFor(context, tenant);
  context.setTenant(tenant);
  return handler.sendMessage(SendMessageRequest.fromJSON({
    tenant,
    message: { messageId, role: 'ROLE_USER', parts: [{ data: input, mediaType: 'application/json' }] },
    configuration: { returnImmediately: true },
  }), context);
}
```

使用 SDK JSON-RPC transport 时，将同一 handler 交给 JsonRpcTransportHandler.handle；SDK 自己设置 tenant，不能再执行示例中的 setTenant。回执是唯一的独立扩展分支，用新 context 显式 setTenant(receipt.tenant) 一次后调用 `service.confirmTaskDelivery(receipt, context)`，服务内部仍须执行同一版本／扩展与授权检查和激活；只有应用最终退出才调用 `service.close({deadline})`。SDK fromJSON 不替代前述信任边界校验。

## 9. 仍需填定与验证的接入项

完整函数签名与行为已在本文列出；剩余是可信调用方的实际证明／授权来源、固定官方目录提供方、limits 与消息有效期／最大重投窗口的具体数值、SDK／Kysely／驱动实际锁版和本地升级步骤；这些先用独立验收宿主和 fixture 固定可重复条件。[WSS 接入评审稿](wss-contract.md) 中的单主体委托、网络限额与生产认证另行评审，不是模块验收前置条件。本文不以选择具体业务 Agent 或 schema 为前置条件。

本阶段已执行模块、真实 runtime 和独立进程 HTTP/SSE 验收；完整命令和实际结果见 verification.md。Windows 实机、生产认证、WSS 及生产 HTTP 部署不在本阶段通过结论内。

## 10. 外部 Agent 独立验证与黑盒验收门槛

这是本阶段已实施的验收契约；实际通过记录与限制见 verification.md。先验证本模块，后接 WSS；不能通过内部 handler fake 调用替代外部 A2A 互操作。

### 10.1 公开接入与 SDK 复用

- 验证宿主临时监听 loopback 的随机空闲端口；每个受测固定版本入口提供标准 AgentCard，supportedInterfaces 声明真实 HTTP URL、JSONRPC、1.0 和 tenant。不复用 WSS URN 伪装为 HTTP，不改动官方物料的不可变内容身份。宿主生命周期只归验收进程，不作为桌面产品新增常驻服务。
- HTTP/SSE 接入优先直接使用 SDK `@a2a-js/sdk/server/express` 的 agentCardHandler／jsonRpcHandler，Express 只作为独立验证宿主的可选 peer；核心模块不 import Express，不复制 SDK HTTP 或 SSE 实现。验证宿主使用 devDependency，不进入核心 import。每个固定入口经公开 protocolFor 取得 handler 并挂载，不能从私有字段提取内部 handler；后续每个请求仍重验身份、tenant 和 closing。
- 外部 Agent 是独立进程，使用 SDK `ClientFactory.createFromUrl` 或 createFromAgentCard，选择标准 JSONRPC 接口；用 SDK `ServiceParameters`／withA2AVersion／withA2AExtensions 请求 1.0 和交付扩展。它不能 import 项目 A2AService、runtime、SQLite 或内部 fixture 控制入口。场景 Agent 按确定性步骤驱动即可，不需要再调用一个真实 LLM。
- 验证宿主的 userBuilder 将受控测试凭据映射为 principal；contextBuilder 每请求创建独立 context、派生规范 owner、加入 waitSignal，**不复制原始 headers**。可受理的请求必须有可信主体；缺失／错误主体、越权 tenant 走拒绝用例。不能将回环监听本身等同认证成功。
- SDK middleware 的版本、分发、ProtoJSON、SSE 和标准错误直接复用；其自带默认 body 限额、未等待 res.write 背压、未绑定请求断开 signal、错误 console 输出均不是模块保证。宿主须在公开外围控制小型 synthetic fixture、输入预算与等待／断开 signal；通过服务边界确保只向 SDK 抛安全错误。本阶段不接真实凭据或业务正文，不用全局 console 替换掩盖风险；HTTP 宿主通过不等于生产 HTTP 服务已验收。
- 唯一 receipt 扩展在相同鉴权／版本／扩展边界后调用 confirmTaskDelivery，响应复用 SDK JSON-RPC 类型与错误映射；SDK 标准 client 不提供该自定义方法，外部 Agent 只需补一条受控 JSON-RPC 请求，不另写标准客户端。标准操作不会因未调用 receipt 而无法执行，但产品交付闭环验收须完成 receipt。

### 10.2 三层证据，各自不可替代

| 验证层 | 真实部分／允许替代 | 通过边界 |
| --- | --- | --- |
| 模块行为 | 真实 service、SDK、临时 SQLite；仅 runtime 和目录用小型 fake | 精确控制重复、busy、停止与结果固定、存储失败和 close 竞争；只经公开创建／handler／确认／close 调用 |
| runtime 集成 | 真实 createDesktopRuntime／execution／LangGraph、版本装配和运行记录；模型使用本地确定性 fixture，物料为通用 JSON 测试入口 | JSON 输入真正进入执行，输出成为 Artifact；取消真实排空、共享名额、Run 结算与清理；涉及浏览器时使用受管理 Chrome 与本地站点 |
| 外部协议互操作 | 独立外部 Agent、SDK client、真实临时 HTTP/SSE 宿主、真实 service/runtime/SQLite | 从 AgentCard 发现到提交、查询／订阅、终态 Artifact、保存后 receipt 完整闭环；不直接访问内部对象或靠进程内 Promise 传结果 |

### 10.3 最小通过清单

1. 成功 JSON 闭环覆盖阻塞 SendMessage、显式 returnImmediately、SendStreamingMessage／SubscribeToTask；保留 0／false／null；GetTask 与最终 Artifact 一致。非终态提前 EOF 是调用失败，不作为任务完成。
2. 同主体同 messageId 并发／响应丢失重投只启动一次，内容冲突拒绝；不同主体隔离，跨 tenant／安装越权不泄漏；GetTask／ListTasks 只返回已提交的授权快照，列表投影和游标沿用 SDK。
3. 真实容量满时保存 REJECTED/busy，无执行资源；查重先于额度。受理落盘失败不 execute，事务内两表任何一步失败都回滚，未知提交先核对；不把 SQLite BUSY 当执行 busy。
4. CancelTask 先 WORKING 后真实 CANCELED；取消竞争 result-fixed 保留原结果，终态取消拒绝。外部客户端 signal／流断开只清理等待，后台仍结算，另一次调用可读取结果，无 pending next 或监听泄漏。
5. 真实 SQLite 覆盖完整终态与 SHA 同事务、同态／迟到 Artifact 冻结、首次及重复 receipt、错摘要与确认失败；确认只修改项目行。通过重启验收进程验证已终态原样可查、遗留非终态 FAILED/interrupted-unknown，不调用模型／图重跑。模块故障注入可用假 runtime，但“真实 runtime 成功执行”须另有证据。
6. 缺／错版本、缺必需扩展、非法 JSON／输入／超限、可选能力关闭、未知任务等输出标准安全错误；受理后的执行失败落原 Task，持久化失败不伪造成功。
7. 等待／订阅限额、旧 handler 关闭后拒绝、构造失败清理、实际取消排空、在途事务及同一总关闭预算均经公开入口验证；服务只关闭自己的资源，宿主随后关闭借入 runtime。

SDK 高层 client 会按卡片本地拦截部分不支持能力；验证 Server 的标准不支持响应时，须用 SDK JsonRpcTransport 公开方法或受控标准请求实际送达 Server，不能把 client 本地异常当作 Server 验收。

### 10.4 黑盒交付条件与后续接入

以上三层证据齐备后，按 SDK／Node／数据库实际锁版记录“本模块在所声明能力与运行条件下通过”。记录测试命令、场景、实际结果和未覆盖平台；不把源码调研、文档严格校验或 fake 用例算作完整验收，也不承诺所有 A2A 可选能力或平台都已兼容。

后续 transport 只依赖本契约公开入口，提供可信 context、实际 binding 的 SDK 校验、消息转交及等待清理；禁止直连内部存储、改 Task 或复制去重／执行状态机。接入 WSS 时沿用本组任务回归，只新增网络鉴权、协商、背压、连接关闭与重连互操作；不重新定义 input/output、Task 生命周期或扩展事务。生产会话／网关可达性是后续接入条件，不能反过来阻塞当前可重复的模块验证。

## 11. SDK 实测差异与本阶段边界

- SDK 1.3.0 的 Part.fromJSON 会把显式 data:null 当缺失。存储适配通过公开 Kysely 结果插件记录本次 SDK 查询的原始 null 位置，SDK 解码后恢复该字段；不增加查询、不改 SQL／分页、不新增结果副本或 monkey-patch。Task.toJSON 和线上标准报文继续输出 data:null。官方 TS 高层 client 的同一解码缺陷仍存在，外部 Agent 用公开 fetchImpl 核对原始 null 报文；0／false 直接走 SDK 类型结果。不能宣称该上游 client 缺陷已修好。
- SDK 迁移仅由公开 a2a-db CLI 暴露。初始化通过 SDK 包公开 bin 元数据定位 CLI，以随包 Node 执行 offline SQLite SQL 生成，再在唯一 timeout=0 连接的事务中应用；不导入私有迁移路径或复制 SDK Task DDL。安装版本和 SDK ledger 验证失败会安全拒绝。SDK 自身另有迁移 ledger，因此物理数据库为 Task 表、项目扩展表及 SDK ledger，而非三张业务表。
- 本阶段的标准 HTTP/SSE 宿主仅在测试进程临时监听 loopback。桌面 main.ts 不新增未经生产鉴权设计的网络入口；后续 transport 通过公开 service 入口组装同一模块。
