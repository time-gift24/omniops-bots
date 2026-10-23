# WSS adapter ↔ A2AService 接入契约（评审稿）

> **后续接入草案，当前暂缓。** 先按 [A2AService 契约](contract.md) 的外部标准 A2A／真实 runtime／SQLite 验收门槛验证模块；WSS 的连接、网关身份映射、Upgrade、背压和重连不阻塞本阶段。本文不作为已冻结实现要求，后续恢复评审时须与已验收的模块边界对齐。绑定检查属于 transport，A2AService 不硬编码 WSS URN。


状态：**仅设计，不实现**。承接已确认的官方 SDK／不 fork、SDK Task 表＋一张项目表及 [A2AService 契约](contract.md)。本稿开始细化此前单独保留的 WSS 接入；单主体连接、参数和关闭策略仍供评审，不代表已获准实施或已完成平台联调。

依据：需求[核心 A2A](../../../docs/requirements-walkthrough/核心-服务端通过WS调用客户端.md)、[第 10 章](../../../docs/requirements-walkthrough/10-服务端API.md)，SDK 1.3.0 固定提交 `29417a5bb4038f804f310ce4fffd267a9375aa90`。源码核验见 [research-a2a-langgraph.md](research-a2a-langgraph.md)。本稿所有 TS 都在 Markdown 中，不创建运行代码、依赖或网关实现。

## 1. 分工与优先复用

桌面主动连接 WSS，但在 A2A 协议上仍是 Server；服务端 Agent 是 A2A Client。网络连接方向不决定授权主体，也不把 SDK 的 HTTP server 搬进桌面。

| 部分 | 使用现成实现 | 本项目只补 |
| --- | --- | --- |
| WebSocket 帧、TLS 握手、Ping/Pong、消息重组／UTF-8 | 建议使用 ws 的公开 client API，不手写 RFC 6455，不启动 Express／HTTP listener | 既有会话凭据、项目头协商、限额、重连和 socket 生命周期 |
| 标准 RPC／ProtoJSON／错误 | JsonRpcTransportHandler.handle、SDK 请求／响应类型、公开错误及 mapToJSONRPCError | 原报文预检、逐请求 context、流异常捕获；唯一 ConfirmTaskDelivery 分支 |
| 版本／扩展 | SDK validateVersion、Extensions.parseServiceParameter/toServiceParameter、A2A_VERSION_HEADER／HTTP_EXTENSION_HEADER 常量、ServerCallContext | 与自定义 WSS binding 对应的协商结果、必需扩展检查与实际激活 |
| Task 状态与执行 | A2AService、SDK 默认处理器／存储及现有 runtime | adapter 不创建 Task、维护状态机、决定去重、执行重试或写结果 |

Node **26.11.1 内置 WebSocket 支持 headers**，可以发送 Authorization／A2A 头；但未提供实例级公开的 101 响应头接口、upgrade 事件或 send callback。本绑定需要核验 101 协商，故优先建议 ws，不能靠内部 diagnostics channel 读取业务协商，也不能声称内置实现完全不能设置头。ws 的公开 headers／upgrade／send callback／bufferedAmount／maxPayload 能覆盖所需接入点。[Node 固定文档](https://github.com/nodejs/node/blob/364593d0631def13e3043dd84f77ebca2c767ce5/deps/undici/src/docs/docs/api/WebSocket.md)、[ws 固定公开 API](https://github.com/websockets/ws/blob/dabbdec92f4c1f1777689733d477344e3c6c2e67/doc/ws.md)

当前 runtime 没有声明或锁定 ws；后续采用时须加入直接生产依赖并验收两平台，不因 SDK peer／开发工具间接提到 ws 就当作已安装。具体锁版未定，不 fork SDK 或 ws。

## 2. adapter 的拟公开入口

建议模块为 `desktop/runtime/a2a/wss.ts`，不扩大 A2AService。只接收服务、既有认证来源和传输限制，不定义通用 socket／认证服务框架。

```ts
import type {
  A2APrincipal, A2AService, CallOptions, CloseOptions,
} from './index.ts';

export type WssCredentials = Readonly<{
  authorization: string;
  principal: A2APrincipal;
  expiresAt: string;
}>;
export type GetWssCredentials = (options: Readonly<{
  origin: string;
  signal: AbortSignal;
}>) => Promise<WssCredentials>;
export type WssLimits = Readonly<{
  maxMessageBytes: number;
  maxHeaderBytes: number;
  maxInFlightRequests: number;
  maxStreams: number;
  maxOutboundMessages: number;
  maxOutboundBytes: number;
  connectTimeoutMs: number;
  callTimeoutMs: number;
  heartbeatIntervalMs: number;
  pongTimeoutMs: number;
  reconnectMinMs: number;
  reconnectMaxMs: number;
  closeTimeoutMs: number;
}>;
export type WssStatus = Readonly<{
  state: 'connected' | 'reconnecting' | 'blocked' | 'closing' | 'closed';
  reason?: 'network' | 'authentication' | 'forbidden' |
    'protocol' | 'backpressure' | 'unknown';
}>;
export interface A2AWssAdapter {
  getStatus(): WssStatus;
  close(options: CloseOptions): Promise<void>;
}
export type A2AWssOptions = Readonly<{
  url: string;
  service: A2AService;
  getCredentials: GetWssCredentials;
  limits: WssLimits;
}>;
export declare function connectA2AWss(
  options: A2AWssOptions,
  callOptions?: CallOptions,
): Promise<A2AWssAdapter>;
```

构造校验 wss URL 为配置中的网关 origin 和 `/api/clients/connect`，不含 userinfo、凭据查询串或 fragment；连接不跟随重定向，不关闭 TLS 证书校验。getCredentials 的 origin 是该 WSS URL 对应的 HTTPS origin（wss→https，保留 host／port）；使用现有登录／续期及 GET /api/session 的可信身份，不新增 Token 签发或解析框架。本稿凭据签名按平台可提供既有 Authorization 机制拟定；若实际仅支持 Cookie 等其它会话，须确认接入字段，不另造 Token。返回身份必须属于当前安装，authorization 是经既有会话来源产生的受控头值，expiresAt 为未来的有效 RFC 3339 时间。缺少主体／有效期、无权限或无法确认归属时不建可用连接。

getCredentials 必须响应 signal，并将既有会话失败归为安全 RuntimeError；不能把原始认证响应体或错误来源转交协议。

所有限额为必填正安全整数，reconnectMinMs ≤ reconnectMaxMs，maxStreams < maxInFlightRequests，为短请求留容量；不能无限排队。maxMessageBytes 限制整个重组后的文本消息，不是单个网络 fragment。maxOutboundMessages／Bytes 包含应用发送队列及在途项，至少容纳一个最大合法响应；ws.bufferedAmount 也必须受同一有限预算检查，留出标准帧开销。

组装入口须校验 WSS 消息上限能容纳 A2AService 允许的完整 Task 加 RPC 封套，不能让合法 Task 无法交付；adapter 不读取 service 私有配置。ListTasks 等多 Task 响应也受单消息限制，超限返回安全错误，由调用者缩小分页／投影，不截断成功结果。具体数值由两端联调填定。

connectTimeoutMs 覆盖取得凭据、TLS 和项目协商的首次尝试，总预算不在每阶段重置。仅完整就绪才返回 adapter；首次失败／signal 取消清理本次凭据请求、socket、监听及定时器后拒绝 RuntimeError，不关闭 service、不在这个构造 Promise 中无限重试。返回后构造 signal 不变成整条连接的生命周期开关。

getStatus 返回独立安全快照，无原始 URL／认证头／协议正文或依赖错误。连接失败分类与 close 继续复用 RuntimeError；正常重连中的状态保留在该快照，不新增日志／span／指标。

## 3. 鉴权：先固定一个主体，再转发 RPC

**首版建议一条连接固定一个 A2APrincipal，但可访问多个授权 tenant。** 服务端 Agent 是调用软件角色，principal.callerId 是既有身份系统确定的用户／获授权主体；不能从 Agent 名字、Task、messageId 或 tenant 推导权限。

1. 客户端先从既有安全会话取得 authorization、组织、主体、已验证安装及有效期。getCredentials 必须先完成真实身份核验，不能把磁盘配置或未经核验的请求正文直接包装成 principal。
2. 网关在 Upgrade 核验同一凭据、组织与安装，并承诺此连接只转发代表该主体的调用；客户端通过校验 TLS 的固定网关和已核验会话建立这项信任。**TLS 只认证网关，不能单独证明任意服务端 Agent 的 caller 身份。** 若平台现有会话无法给出该委托映射，就接入失败并补平台契约，不从 RPC 补取身份，不自行发明 JWT／签名或新认证头。
3. 握手通过后复制并固定 principal、协商版本／扩展和到期边界。每 RPC 只从该连接绑定创建 context；Message／metadata 中的身份字段没有认证作用。每次服务调用仍由 A2AService 检查 tenant、归属和权限。
4. 会话失效通知、过期或权限撤销已被既有会话层确认时，封闭连接并取消等待；已有执行继续。没有平台即时撤销机制时，不宣称支持即时远程撤销；仍按租约有效期和逐请求授权约束访问。
5. 换用户、组织、安装、caller、版本或扩展必须重新鉴权建连。当前绑定不支持同连接多 caller、RPC 自带 credential、热切换 principal 或新增认证业务帧；这些需求出现时另行评审。

principal 和 authorization 只保留在必要生命周期，禁止放进 ServerCallContext.state 的原始 headers、Task、Artifact、错误正文或日志。断线后新建连接可取得新凭据，旧连接的闭包／响应不得写入新连接。

## 4. 版本与扩展协商

连接绑定为 `urn:omniops:a2a:binding:wss-jsonrpc:v1`，必需扩展为 `urn:omniops:a2a:extension:delivery-receipt:v1`。绑定由 endpoint 和 AgentCard 声明；不把含冒号的 URN 塞进 Sec-WebSocket-Protocol，也不新增 type/payload 协商帧。A2A-Extensions 与 WebSocket 压缩扩展 Sec-WebSocket-Extensions 是不同机制。

| 阶段 | 必须行为 |
| --- | --- |
| Upgrade 请求 | 通过 headers 发送既有 Authorization、`A2A-Version: 1.0` 和包含 receipt URI 的 `A2A-Extensions` |
| HTTP／WS 验证 | 网关验证身份后返回 101；客户端让 ws 完成 RFC 握手／TLS 校验，再进入可用态。upgrade 事件发生在 ws 完成全部验证之前，不能仅收到该事件就接 RPC |
| 项目头检查 | 名称按 HTTP 不区分大小写，值有总字节上限且只接受允许的可打印 ASCII。重复／冲突的单值版本头拒绝；版本必须明确为 1.0，缺省不回退 0.3。扩展列表解析／去重复用 SDK Extensions，要求包含 receipt，确认集合只能来自本次提出且支持的集合 |
| 成为 connected | open 与项目头检查均成功、凭据仍有效后才处理消息。协商头检查同步完成，身份核验在建连前完成，open 回调不等待另一轮平台 API；不设无界预就绪队列。101 缺头／错版／少必需扩展即终止连接，不执行收到的提前数据 |
| 每个 Agent 入口 | adapter 经 protocolFor 取得 handler／公开卡片后，用 SDK `validateVersion(version, card, WSS_BINDING_URN)` 校验该卡片支持此 binding／版本；服务检查必需扩展并收窄 requested 集合，不硬编码 WSS URN |

自定义 URN 可以直接传 validateVersion 的公开第三参数，不冒充标准 JSONRPC；JsonRpcTransportHandler.handle **不会替 adapter/service 做这项校验**。Extensions.parseServiceParameter/toServiceParameter 也只处理集合表示，不替代 ASCII／大小和必需能力检查。

requestedExtensions 表示对方声明支持，activatedExtensions 表示本服务实际启用。使用 receipt 语义的 A2AService 在共同入口／确认操作经检查后调用公开 `context.addActivatedExtension(RECEIPT_URI)`，不能把 requested 原样当作 activated，也不能因替换默认发送方法而漏掉检查。当前连接协商固定这一必需能力，不逐 RPC 再造响应头或业务确认帧；卡片不满足时返回标准错误，不动态换扩展。激活扩展不等于收到交付确认。

## 5. 一条 RPC 如何进入 SDK 和服务

1. 仅处理就绪连接上的完整文本消息。ws 负责重组／UTF-8 和 maxPayload，应用再限制字节、JSON 深度和并发。每消息一个 JSON-RPC 2.0 对象；不支持 batch、二进制业务、notifications 或 peer 发送的 result/error 对象。
2. RPC id 必须存在且非 null，可为沿用 identifier 约束的字符串（1～256 字符、非纯空白、无控制字符）或安全整数；数字 1 与字符串 "1" 不混同。它只关联本连接调用，不能变成 messageId／runId。同连接活跃 id 不得重复；重复会使响应不可区分，按策略关闭连接，而非发送第二个同 id 错误。完成帧写出并清理旧调用后才释放 id；新连接有独立 id 空间。
3. 原 JSON 预检检查信封、受控请求字段和 params 对象／tenant；SDK fromJSON 可能默认化字段，不能用转换后的值证明原类型合法。语法错误用 SDK Parse error、信封错误用 Invalid Request（这些错误的 id 为 null），有效 id 的参数／业务错误回显原 id，参数错误用 RequestMalformedError；摘要固定安全，不回显 SyntaxError、原值或凭据。
4. 接入新请求前同步检查 maxInFlightRequests，不为每个 message 先创建无界 async 任务／输入队列。流对象返回后、首次 next 前再取得 maxStreams 槽位；超限不启动该新 Task。短请求不能被等待一条完整长流的串行读循环阻塞，CancelTask／GetTask 可以与流并行。
5. 创建新的 ServerCallContext：受信 user／principal、明确 requestedVersion、协商 extensions 的独立副本和本 RPC 的 waitSignal；初始 tenant 未设置，无原始认证头。调用 `service.protocolFor(context, tenant)` 得到 SDK handler，再交给 `new JsonRpcTransportHandler(handler).handle(request, context)`；标准 params、转换、返回封装及分发复用 SDK，由 SDK setTenant 一次。
6. 只有 `omniops/ConfirmTaskDelivery` 在 SDK 标准分发前单独识别。它走相同身份／版本／扩展预检，显式 setTenant 一次后调用 service.confirmTaskDelivery；使用 SDK JSONRPCResponse 类型构造普通成功封套，并复用 SDK 错误映射。未知方法不扩充自建标准方法表，交给 SDK 返回 Method not found。
7. 普通响应入有界发送器；SDK 返回 AsyncGenerator 时建立本 RPC 的消费器。SDK handle 返回的 Internal error 也用公开 SDK A2AError／映射统一替换为固定安全摘要及受控详情，不原样转发未知 message/data；标准业务错误由服务边界安全化，不重写标准数字码注册表。所有流异常先确保是安全 SDK 错误，再调用公开 mapToJSONRPCError 组成同 id 的 error 封套，不发送 SSE event/data、私有 kind/final 或 end 信封。

每请求 waitSignal 关联连接关闭、会话到期、adapter close 和 callTimeoutMs。这里只取消等待：SendMessage 的等待超时、网络断开、停止消费不等于 Task FAILED/timed-out，不撤销已提交受理／回执或已锁存停止意图。SDK 没有原生 WSS Task 取消协议，执行停止仍只经标准 CancelTask 或应用最终 A2AService.close。

仅经公开入口的标准派发示意（request 和 binding 已通过以上预检；不是完整 socket 实现）：

```ts
import { JsonRpcTransportHandler, ServerCallContext } from '@a2a-js/sdk/server';

const context = new ServerCallContext({
  user: trustedUser,
  requestedVersion: '1.0',
  requestedExtensions: [...negotiatedExtensions],
  state: new Map<string, unknown>([
    ['omniops.principal', principal],
    ['omniops.waitSignal', requestSignal],
  ]),
});
const handler = await service.protocolFor(context, tenant);
const response = await new JsonRpcTransportHandler(handler).handle(request, context);
```

## 6. 背压：有界发送，不拖住结算

- 每连接一个有界 FIFO 发送器，只经 ws.send(text, callback) 写完整 JSON 文本消息，最多一个实际在途 send；不碰 `_socket`、`_sender` 或依赖 WebSocket 对象没有的 drain／send boolean。
- 每个流最多保留一个待发送项，等该项 callback 后才 next；其它请求可同时进入共享 FIFO。应用队列的条数／字节连在途项一起计，检查 ws.bufferedAmount 的有限预算。A2AService 的 SDK 消费队列另外由每 Task 最多 3 个后续事件、Task 大小和订阅数约束，不增加无限 token 进度。
- 达到全局发送预算、socket 不再可写或 in-flight 上限时不等待无界容量、不静默丢某一帧后继续流；优先停止消费，若无法可靠排入同 id 的结束错误就关闭整条连接（1013）。整个共享发送路径已阻塞时，不能承诺只结束一条流而仍可靠通知对端。
- 一条调用自身超时／安全业务错误且发送器可用时，只结束该 RPC：取消等待、移除它尚未发送的帧，按顺序排入唯一结束错误。不能撤回在途帧，也不能再追加该流后续结果；在途 callback 必须受调用／连接有效期和关闭预算约束。若错误无法入队或无法有界写出则关闭连接，不能只排入错误后无限等待。
- 单响应序列化后超过 maxMessageBytes 时改发有界资源错误，不截断 JSON／Artifact，不改持久 Task。正常完整 GetTask 应由组装预算保证能发送；ListTasks 可用更小 pageSize／不含 Artifact 重试。
- send callback 仅代表本地发送路径完成，不表示平台已收到或持久保存。Task 终态在入发送队列前已提交并释放运行容量；真实交付仅由 ConfirmTaskDelivery 提交确认。adapter 不 await 网络来驱动 SDK ResultManager 或 runtime 结算。

## 7. 一条流怎样结束

| 场景 | Wire 与本地清理 |
| --- | --- |
| 首帧 Task 已终态 | 发送该快照作为唯一结果帧，结束该 RPC，共享连接保持开放 |
| 正常运行终态 | 依次发送最终 Artifact（如有）和终态 statusUpdate，最后一帧结束该 RPC，无额外 done 帧 |
| 标准协议／等待错误 | 发送相同 id 的 JSON-RPC error 作为最后一帧，结束该 RPC；其它请求保持运行 |
| generator done 但未见终态／结束错误 | 视为流异常，发送安全 Internal error／unavailable 后结束；不能让对端以为 Task 已结束或无限等待。尤其 SDK resubscribe 无活跃 bus 时可能在非终态快照后直接 done |
| 已发送终态后清理失败 | 不再追加同 id 错误或第二终态；清理失败按安全连接错误处理，必要时关闭连接，不改 Task |
| 连接关闭／不可写 | 无法保证结束错误送达；取消所有本连接等待并清理，Task 继续。重连后 caller 查原 Task／重投原 messageId |

首帧必须为 Task，后续只接受本产品声明的 statusUpdate／artifactUpdate；SDK 的 message-only 分支不属于本产品入口，不能先发出再追加结束错误。终态只用 SDK StreamResponse.fromJSON 和 TaskState 的四个终态枚举识别；这是调用级结束判定，不在 adapter 建另一套 Task 状态机。gateway 也必须按“终态快照／状态或 error”结束该 id；不能把一次 WSS send、半条流或迭代器消失当交付成功。

**清理顺序：先 abort 本 RPC 的 waitSignal，唤醒该调用的 SDK queue/bus，再 return 迭代器并解除监听／定时器／发送项／额度。** 有 pending next 时仅 return 或 Promise.race 不能保证清理。A2AService 经公开 bus manager 提供每调用可单独 finished 的 SDK 总线，不能 finish 共享 Task bus，不能在断线清理时调用 reservation.requestStop。

当前绑定没有远端“仅退订某条流”方法：JSON-RPC id 不是取消消息，WebSocket Close 是整条连接的控制帧。远端可停止本地消费，但协议没有通知桌面退订的独立信号；不得挪用 CancelTask 或私加 unsubscribe／stream-end RPC。必要时由调用等待上限或整连接关闭回收，新增需求另行评审。

## 8. 连接关闭、心跳与重连

| 原因 | 处理建议 |
| --- | --- |
| 正常最终关闭 | Close 1000，受调用方 deadline／closeTimeoutMs 限制，超时 terminate |
| 身份失效、协商／策略失败、重复活跃 RPC id、收到错误方向的响应 | 已 open 时 Close 1008；未就绪则终止握手，不处理 RPC |
| 二进制业务／非法 UTF-8／超大消息 | 1003／1007／1009，优先复用 ws 标准检查；不尝试解析半包 |
| 输入并发或共享发送背压超限 | 1013，结束连接等待，保留全部已提交 Task |
| 内部传输故障 | 1011 或直接 terminate；关闭原因只用有界安全常量 |

1006 仅表示观察到异常断开，不能发到 wire；Close reason 按 RFC 6455 的 UTF-8 字节限制，不能塞入异常或协议正文。ws 默认的约 30 秒关闭等待不作为本项目预算，按 deadline 显式 terminate。注册 unexpected-response 后必须结束失败握手／释放响应，不能读完 401 就留下 socket。

心跳使用标准 Ping/Pong，不加业务 JSON 心跳信封；每连接只跟踪一个心跳等待，使用本次连接的匹配值，pong 超时清理旧连接再重连。心跳不更新 Task、不确认结果。压缩首版关闭，maxPayload 与 UTF-8 检查显式保持启用，不以大默认 payload 当上限方案。

首次就绪后网络／暂时不可用可有界指数退避并加抖动重连，延迟始终在 reconnectMinMs～reconnectMaxMs，只允许一个重连计时器和一个连接尝试。每次重新取凭据、校验 TLS／协商、创建新连接代际和新 context；稳定完成心跳后才重置退避，避免握手后立即断开的热循环。认证／权限／协议不兼容，以及确定的证书／固定目标配置不匹配转 blocked，等既有会话／配置修复后由宿主关闭旧 adapter 并重新 connect，不无限自动认证重试。

同一代际的 error／close 幂等处理，每调用只清理并归还额度一次，不重复安排重连；始终安装 error 处理，不让事件或 Promise 拒绝成为未处理异常／原始日志。旧连接的 send callback、next、close/error 事件和清理只作用于原代际；即使 RPC id 相同也不能向新 socket 发送旧响应或撤销新请求。重连不自动重放 RPC、不重新执行 Task、不恢复旧流；平台以持久 messageId／taskId 发起查询／订阅／确认。

adapter.close 幂等复用第一次有效关闭工作与绝对 deadline：先禁止重连／新派发，取消凭据尝试和计时器，abort 本连接全部调用，清理 SDK 迭代器及发送队列，再有界关闭／terminate socket。成功后 closed；清理失败／预算耗尽拒绝 RuntimeError，入口保持封闭，不伪造已清理。**不调用 service.close、runtime.close 或关闭数据库。**

应用最终退出用同一个 deadline 依次尝试 adapter.close → service.close → runtime.close → checkpoint／宿主，其间保留实际排空需要的私有回调；前项失败也继续后项，不重置预算。普通断线只做 adapter 的连接清理／重连，不进入服务关闭流程。

## 9. 接入验收与未决项

须与平台确认：单连接主体／委托映射及既有 session 的有效期来源、401／403／版本扩展拒绝的 HTTP 表达、全部传输限额和时间参数、RPC id 复用及流结束规则、实际 ws 锁版和两平台 TLS／打包。平台不能承诺单主体转发时，本方案不能原样接入；不自行信任 metadata 或扩大多主体协议。

未来验证至少覆盖：伪造身份、错误安装、缺协商头／错版／缺扩展、upgrade 后未 open 的消息、重复 id、SDK 流异常与非终态 done、pending next 断线、发送队列满／callback 失败、RPC 等待超时不停止执行、到期／撤销、旧连接晚到回调和关闭预算。检查 SDK 对象／原始错误不泄露、stdout 不混日志，Task／Run 仍真实持久。此轮仅做文档和源码核验，不运行网络集成或修改依赖。
