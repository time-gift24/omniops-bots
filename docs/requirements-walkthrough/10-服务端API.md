# 10 · 服务端 API：客户端接入所需的最小契约

> 串讲重点：线上用户在服务端 Console 发起业务、查看任务状态与结果；服务端 Agent 以任务调用客户端 Agent，客户端作为后台进程执行并回传结果。服务端提供身份与权限、官方物料、草稿与发布、任务通道、桌面更新和诊断接收，明确成功边界及断线后的查询与重试。

**本章是拟定的接入契约，相关平台 API、WSS 传输绑定和远端 A2A 任务通道尚未实现。** 路径名称可适配现有平台网关，输入输出与成功边界保持一致；不据此另建账号体系、审批平台或文件级发布服务。客户端已实现的本地能力见[第 08 章](./08-前端现状与缺口.md)。

## API 分组与边界

线上客户端只向用户展示连接状态等基础信息；资源编辑、实验、本地会话、逐条过程和 Provider 管理属于运维调试入口。下列客户端职责同时包含后台执行与运维操作，不将完整调试桌面作为线上业务入口；Console 按既有任务状态与最终结果契约展示业务。

| 能力 | 服务端提供 | 客户端负责 |
| --- | --- | --- |
| 身份与权限 | 复用现有登录、Token、组织及设备身份，返回可执行操作 | 维护登录与连接等基础状态，按身份和权限请求 |
| 官方物料 | Agent／Skill 版本清单、确定装配、完整包下载 | 后台校验、按需缓存、固定运行快照；运维按权限查看 |
| 草稿与发布 | 保存完整修订，校验标签，原子发布关联资源 | 运维在调试桌面编辑与实验，提交明确修订和手填标签 |
| 远端任务 | 服务端 Agent 经 A2A 调用／取消，WSS 仅传输，持久接收结果并确认，供 Console 展示 | 后台并发执行，按 thread 固定浏览器页面，结果落盘与补传；完整过程仅供运维调试 |
| 桌面更新 | 静态 `latest.json` 和已签名整包 | 用户确认下载与安装，空闲时更新 |
| 故障诊断 | 接收指定 thread 的包、回执、只读检索及附件 | 在运维诊断入口从本地 SQLite 导出 checkpoint，经有权用户预览同意后上传 |

HTTPS 传输物料、发布请求和诊断包；WSS 承载标准 A2A 任务操作与结果，不传 Skill 文件包，也不持续上报每条模型输出。Playwright 与外部 Google Chrome 运行在客户端，服务端不远程暴露浏览器 CDP 端口或接收浏览器 profile。

[11 · Provider](./11-Provider.md) 的配置由运维在客户端本地预配置，线上任务复用本机配置并固定运行快照，仅支持 OpenAI Chat Completions 兼容接口及自定义 base URL，本期不新增平台 Provider 管理、配置下发或 Key 同步 API。Key 可选，有值时使用 Bearer，无值时不发送认证头；Key 存操作系统凭据库，普通配置只保存引用。运行快照与诊断材料均不包含 Key 或原始认证头，Provider／模型选择也不进入 Agent 发布内容 ID。手动连接测试由运维在客户端向选定模型发送固定最小请求，不使用任务通道、不读取会话或执行工具。

## 统一契约

以下约定只适用于 HTTPS 业务 API。A2A 任务通道遵循其标准对象、分页、错误和版本协商，不套此处的业务响应或 `schemaVersion` 信封。

HTTPS 业务 API 使用 `/api/…`，JSON 使用 UTF-8，时间为带时区的 RFC 3339；业务 JSON 请求体和成功响应携带 `schemaVersion: 1`，不支持的版本明确拒绝。GET 请求无需 JSON 请求体；二进制上传在 manifest 声明版本，二进制下载与 Tauri 更新清单遵循各自格式，不套 JSON 业务响应。

- 复用现有 Bearer Token 或平台既有安全会话机制；服务端从已验证凭据确定用户、组织和权限，不相信请求正文自报的身份。下载 URL 与诊断附件同样需要授权，可使用短时有效的受限下载地址。
- 普通用户通过服务端 Console 使用有权访问的官方能力、发起自己的任务并查看状态结果，也可知情提交自己有权访问的诊断；运维人员通过调试入口维护官方草稿和发布。仅在前端隐藏按钮不能代替服务端权限检查。
- 列表请求使用 `cursor`、`limit`，服务端限制最大页长；返回 `items`、`nextCursor`。游标包含固定列表修订，列表变化使旧游标失效时明确要求重新读取，不能静默漏项。详情与单次发布不分页。
- 创建草稿修订、正式发布等写请求携带 `Idempotency-Key`。同一鉴权范围、操作和键绑定请求内容：相同内容返回原结果，内容不同返回 `409 idempotency-conflict`。超时后用同一键重试；不能换键猜测上次是否成功。
- 修改草稿头、提交发布时携带读取到的 `expectedRevision`／`expectedContentId`；服务端发现基线变化返回冲突，客户端重新展示差异。已经保存的修订、正式包和发布标签不原地覆盖。
- 失败返回安全的 `{ error: { code, message, requestId, details? } }`；`details` 仅给出可处理的字段或资源标识，不含 Token、原始请求头或内部错误来源链。网络超时不等于服务端未写入。

| HTTP 状态 | 稳定错误类别示例 | 客户端处理 |
| --- | --- | --- |
| `400`／`422` | `invalid-request`、`unsupported-schema`、`invalid-tag`、`invalid-package` | 修正内容，不原样无限重试 |
| `401`／`403` | `unauthenticated`、`forbidden` | 恢复登录或显示权限不足，不宣称已保存 |
| `404` | `not-found` | 明确指定资源不可取得，不换成其他版本 |
| `409` | `revision-conflict`、`tag-conflict`、`idempotency-conflict` | 保留本地内容，重新核对 |
| `413`／`429` | `payload-too-large`、`rate-limited` | 展示限制；限流遵循 `Retry-After` |
| `5xx` | `temporarily-unavailable` | 保留请求身份与本地材料，有界退避重试或主动重试 |

### 身份字段不要混用

| 字段 | 含义 |
| --- | --- |
| `skillId`／`agentId` | 官方目录中的稳定资源身份；本地私有资源 ID 不自动成为官方身份 |
| `contentId` | 完整 Skill 包或确定 Agent 装配的不可变内容摘要；文档中的“新 Agent ID”指新的装配内容身份，A2A 调用由所选 AgentCard 逻辑入口绑定资源身份与内容摘要 |
| `draftRevisionId` | 一次已保存的完整草稿修订；不等于内容摘要或正式标签 |
| `releaseTag` | 运维手填的 `v.1.0.0` 形式标签，同一资源内不得重用、覆盖或改指向 |
| `messageId`／`taskId` | 首次 A2A 任务消息的持久幂等身份／桌面创建的 Task 身份；显式重新执行使用新消息 ID |
| `threadId`／`runId` | 客户端业务会话与一次执行的身份；与图 `thread_id` 的映射见第 09 章 |

本表是服务端接入时统一的命名约定，不表示当前本地 runtime 已具备远端版本注册表。模型和推理参数属于运行条件，不进入 Agent 发布内容 ID；凭据值不进入内容摘要、发布清单或运行快照。

## 身份与权限

| 接口 | 输入 | 输出与成功边界 |
| --- | --- | --- |
| `GET /api/session` | 当前有效登录凭据；设备标识使用现有绑定机制 | 用户／组织标识、官方资源读取与维护权限、诊断读取范围、已验证的设备身份；只有身份核验成功才返回 |

现有平台负责登录、续期和退出；本章不新增另一套密码或 Token 签发接口。客户端按返回权限显示操作，所有写入和下载请求仍单独鉴权。MCP 凭据通过既有运行时凭据来源解析，不能借此接口返回所有 MCP 密钥。

## 官方清单与完整包下载

| 接口 | 输入 | 输出与成功边界 |
| --- | --- | --- |
| `GET /api/agents` | 分页参数，可按名称筛选 | 官方 Agent 目录，含资源 ID、名称、可选版本摘要与标签；返回可读取的确定版本 |
| `GET /api/agents/{agentId}/versions` | 分页参数 | 已发布版本及标签，不包含客户端私有 Agent 或未授权草稿 |
| `GET /api/agents/{agentId}/versions/{contentId}` | 精确的官方装配身份 | Agent 完整包的两项文件清单、内容摘要及受限下载地址，关联所需 Skill 清单；不存在即失败，不解析为“最新版” |
| `GET /api/skills` | 分页参数，可按名称筛选 | 官方 Skill 目录与摘要 |
| `GET /api/skills/{skillId}/versions` | 分页参数 | 已发布 `contentId`、标签与发布日期；不要求下载全部历史 |
| `GET /api/skills/{skillId}/versions/{contentId}` | 精确包身份 | 包清单、内容摘要、传输包大小／SHA-256、受权下载地址及必要的到期时间 |
| `GET /api/skills/{skillId}/versions/{contentId}/package` | 精确包身份及读取权限 | 完整文件包的原始字节与目录结构；等效的受限下载地址可替代此路由 |

Agent 完整包严格由 `prompt.md` 与 `agent.json` 组成：前者保存系统提示词；后者保存 `schemaVersion`、名称与描述、`promptFile`、`skills[{skillId, contentId, mountPath}]`、`toolIds` 和完整非敏感 `mcpServers`（包含可选凭据引用）。MCP 不再通过可变全局 ID 解析连接配置；服务实现和实时工具行为不因此冻结，也不另设本项目 MCP 发布版本。展示用发布标签在包外版本清单中返回。

服务端与客户端均保存为 `agents/releases/<agentId>/<contentId>/`，人工标签映射位于上一级 `tags.json`。Agent 文件清单同样列出相对路径、`kind`、字节数与 SHA-256；下载地址可以分别返回两个文件，也可以返回完整传输包。必须交付原始字节，不能只返回一个 JSON 对象让客户端重新序列化。完整目录、示例、摘要算法与运行模型见 [Agent 版本文件布局](../agent-version-layout.md)。这里的包摘要是待接入的正式发布契约，不是当前本地配置文件摘要。

Skill 清单逐项列出 POSIX 相对 `path`、`kind`，文件另有 `bytes` 与 `sha256`，空目录也保留。完整包内容摘要严格采用[Skill 版本文件布局](../skill-version-layout.md)的规范化算法；传输 ZIP 的 SHA-256 与包 `contentId` 是两个值，不能混用。服务端提供跨语言摘要用例供客户端对照。

正式内容保持 `skills/releases/<skillId>/<contentId>/` 的包内结构；人工标签和上传者等元数据在包外。下载在临时目录完成，拒绝路径穿越、符号链接、重复路径、大小写冲突及超限内容，客户端重算摘要后原子提交缓存。失效 URL 可重新取得，但同一内容 ID 对应的内容不能改变。

客户端只请求当前装配缺少的包；已缓存相同完整版本可复用。服务端调用指定官方内容版本，后台准备时核对版本并固定快照；运维已有调试会话继续使用其固定快照。清单、权限、下载或摘要任一失败都停止本次准备，不回退旧版或移除缺失能力后继续执行。

## 官方草稿修订

| 接口 | 输入 | 输出与成功边界 |
| --- | --- | --- |
| `POST /api/skills`、`POST /api/agents` | 运维权限、目录名称等元数据、幂等键 | 新的官方资源身份，尚无正式版本；本地新建不调用它 |
| `POST /api/skills/{skillId}/drafts` | 完整文件包、包摘要、`expectedRevision`（首次为空）、幂等键 | `draftRevisionId`、`contentId`、保存时间与新的草稿头；完整包持久保存后才成功 |
| `POST /api/agents/{agentId}/drafts` | 完整 Agent 包的原始文件字节、包摘要、`expectedRevision`（首次为空）、幂等键 | 新 `draftRevisionId`、包 `contentId` 及新的草稿头；校验引用、配置及包摘要后保存 |
| `GET /api/{skills\|agents}/{resourceId}/drafts` | 运维权限、分页参数 | 已保存修订的 ID、摘要、保存时间与当前草稿头；这里表示两组同形路由 |
| `GET /api/{skills\|agents}/{resourceId}/drafts/{draftRevisionId}` | 运维权限、确定修订 | Agent 或 Skill 完整包的文件清单、摘要与受限下载地址，保留原始字节 |

Skill 服务端修订存于 `skills/drafts/<skillId>/revisions/<draftRevisionId>/`；Agent 修订存于 `agents/drafts/<agentId>/revisions/<draftRevisionId>/`，包含完整 `agent.json` 和 `prompt.md` 原始字节。客户端下载修订采用相同相对目录，未同步工作副本在对应资源的 `working/`，上传前固定完整内容。客户端上传期间继续编辑，不改变已经提交的修订；服务端失败时保留本地副本。

**保存草稿不发布、不联动 Agent，也不要求实验通过。** 文件级添加、重命名和删除发生在客户端，服务端不为每个文件另建发布 API。Agent 草稿允许表达待发布装配；正式发布时所引用的 Skill 必须是可取得的正式版本，联动发布中的新 Skill 包除外。

## 正式发布与 Skill／Agent 联动

| 接口 | 输入 | 输出与成功边界 |
| --- | --- | --- |
| `POST /api/skills/{skillId}/publish-preview` | 确定的 `draftRevisionId` | Skill 摘要、受影响官方 Agent 身份及其当前内容 ID、可提交的基线；只读预览，不创建发布 |
| `POST /api/skills/{skillId}/releases` | 修订 ID、Skill 新标签、完整受影响 Agent 的 `{agentId, expectedContentId, releaseTag}`、预览基线、幂等键 | 发布编号、Skill 内容 ID／标签、全部新 Agent 内容 ID／标签；全部提交且可读取才成功 |
| `POST /api/agents/{agentId}/releases` | 确定草稿修订、手填新标签、`expectedContentId`、幂等键 | 单独发布的 Agent 内容 ID、标签与发布编号；用于提示词等装配变化 |

受影响 Agent 由服务端依据当前官方引用关系计算，客户端不能自行省略。提交时重新校验引用关系、草稿修订、所有基线与标签；预览后有并发发布或缺少任一标签，整个请求返回冲突，客户端重新取得清单并确认输入。

联动发布先校验和暂存所有完整物料，再一次提交 Skill 正式标签、受影响 Agent 的固定引用、新内容 ID 与人工标签。只有所有版本都已可取得，才对列表公布本次发布；不能先显示 Skill 成功，再补写 Agent。失败保留旧版本及草稿，暂存内容不作为正式版本出现。

发布请求提交即表示运维确认，不加审批或强制实验门槛。旧标签和历史装配保持不可变；仅修改模型参数不发布 Agent。发布超时使用原幂等键重试获取同一发布结果，不能因重试再生成一轮标签或新发布。

## A2A 任务通道：WSS 只负责传输

线上运行顺序和异常场景集中见[核心 · A2A 任务执行与恢复](./核心-服务端通过WS调用客户端.md)。本节规定客户端依赖的协议契约，**仍待实现**。使用 [A2A 1.0.0](https://a2a-protocol.org/v1.0.0/specification/)，协商版本为 `1.0`，不沿用原私有任务消息体系。

### WSS 传输绑定

后台客户端以现有身份主动连接 `WSS /api/clients/connect`。握手核验用户、组织与安装身份，凭据不放 URL 查询串；版本与扩展按绑定明确协商。业务上的 A2A Client 是服务端 Agent，A2A Server 是桌面 Agent。断线仅清理连接与订阅，不取消或重启 Task。

WSS 使用项目明确声明的自定义绑定 `urn:omniops:a2a:binding:wss-jsonrpc:v1`，不是标准 JSON-RPC-over-HTTP 接口。绑定沿用 JSON-RPC 2.0 请求／响应以及 A2A 1.0 的方法名、ProtoJSON 字段和枚举；每个文本消息承载一个 JSON-RPC 对象。流响应使用原请求 `id` 关联标准 `StreamResponse`，按生成顺序发送，终态结束对应任务流，不关闭共享连接。并发请求使用不同 RPC id；收发队列、消息大小和活动流数有界，具体额度在客户端与网关联调时固定。

本绑定在 HTTP Upgrade 请求及 `101` 响应头交换 `A2A-Version: 1.0` 与 `A2A-Extensions` 的扩展 URI 列表：桌面提出，平台确认后才开放 A2A 请求。参数名按 HTTP 规则不区分大小写，扩展 URI 以逗号分隔；只接受受支持的可打印 ASCII 值，长度受双方的 HTTP 头上限约束，非法或超限则拒绝升级。同一连接的每个 RPC 继承该服务上下文，变更版本或扩展须重新建立连接，不增加协商业务帧。认证采用已鉴权连接上下文，不通过 Task 正文传递凭据。协议版本、绑定或必需扩展不兼容时返回明确协议错误，不静默降级执行。WSS 层不定义额外 `schemaVersion/type/payload` 业务信封，不维护业务 Task 状态。

每个官方 `agentId + contentId` 对应逻辑 A2A 入口和标准 AgentCard，复用官方目录，不新增发现平台或每个 Agent 一条连接。AgentCard 的 `supportedInterfaces` 声明绑定 URI、`protocolVersion: "1.0"` 及 `tenant`；请求使用所选接口提供的同一 `tenant` 值，由 A2A 适配层映射确定版本。权限校验同时检查已鉴权组织、调用方、安装和该逻辑入口，不能把正文 `tenant` 当作身份或权限。

### 标准操作与返回

| A2A 操作 | 本项目行为 |
| --- | --- |
| `SendMessage` | 以标准 Message 发起一次任务，受理提交后返回 Task；需要实时事件时再订阅 |
| `SendStreamingMessage` | 发起任务并取得事件流，首条为当前 Task；后续只提供任务级状态及最终 Artifact |
| `GetTask` | 返回已授权 Task 当前状态与最终 Artifact；包括拒绝、失败、取消和重启后的记录 |
| `SubscribeToTask` | 订阅非终态 Task，首条为当前快照；任务已终态或订阅时发生终态竞争则改用 `GetTask` |
| `ListTasks` | 在所选逻辑入口与授权范围内按标准过滤、游标分页查询；用于核对已知任务，不触发运行 |
| `CancelTask` | 尝试停止指定 Task；返回更新后的 Task，不将收到请求当成已经取消 |
| `GetExtendedAgentCard` | 仅在 AgentCard 声明支持时提供；不借此下发密钥或完整运行材料 |

AgentCard 声明 `streaming: true`，普通任务流不包含逐条模型 token、完整工具过程或 checkpoint。首版不启用 webhook 推送，`pushNotifications: false`；相关标准操作返回标准不支持错误，不另做一套推送系统。官方目录提供标准 AgentCard，卡片中的能力描述不等于仓库 Skill 文件包。

每个 Agent 的输入／结果 schema 由对应业务定义，通过标准 Part 的结构化 `data` 表达输入、显式上下文和必要有效期约束；不强迫所有图包含 messages。Agent 与版本来自已选择的逻辑入口，不能由消息临时覆盖成本地私有 Agent；任务正文也不能覆盖本机 Provider／模型选择或携带密钥。

### 稳定身份、持久去重与准入

首次任务 Message 的 `messageId` 是本项目**必须持久实现**的幂等键；A2A 允许按该字段去重，本项目将其约束为强制行为。JSON-RPC `id` 只关联一次往返或一条流，重投时可以变化，不能作为执行身份。桌面为新 Task 生成 `taskId`，不由服务端预填一个不存在的 Task ID。

在已鉴权租户、调用方和目标安装范围内，先查询 `messageId`，并比较目标逻辑入口、确定版本和不可变调用内容；再检查新任务容量。相同消息返回原 Task 当前状态；同 ID 不同内容返回协议冲突，不覆盖原映射。比较使用规范化的业务调用内容，排除随往返改变的 RPC id 与服务参数；首次 `contextId` 的服务端生成结果不反写成新的调用内容。

新请求先原子预留容量，持久提交 Task 与去重映射后才启动执行并返回受理；保存失败释放预留并返回安全的存储错误，不创建第二次执行。去重记录覆盖约定的最大重投窗口；不能因为已交付或进程重启就清掉消息身份，过期消息明确拒绝，不能当成新任务。本次不新增自动清理策略，具体保留窗口在服务端接入时确定。

每个受理 Task 独立创建 thread、run、graphThreadId 与 Chrome 页面；`contextId` 只关联业务，不自动复用执行状态。Task 一次执行到终态，不进入等待输入／鉴权的挂起状态。准备、执行和停止排空期间占用容量，本地、实验和远端共用默认 4、可配置 1～64 的上限，详见第 07 章。

| 情况 | 协议结果 | 执行资源 |
| --- | --- | --- |
| 合法但容量已满 | 持久 `REJECTED` Task，状态 Message 的 Data Part 包含 `busy` | 不创建 thread、run、页面，不排队 |
| 同一 `messageId` 重投 | 原 Task，包括原拒绝 Task | 不创建第二套资源 |
| 格式或鉴权错误 | 标准协议错误 | 不创建 Task |
| 同 ID 不同内容 | 协议错误，说明消息内容冲突 | 不改写原 Task |
| 材料／模型／工具准备失败 | 已受理 Task 进入 `FAILED`，附安全业务原因 | 清理本轮已占资源，不静默降级 |

服务端决定再次执行时使用新 `messageId`，不能通过重投原拒绝或终态消息重新运行。相同消息并发到达时也只能形成一个持久受理决定。

### 标准终态与失败原因

| 结果 | A2A 状态（JSON 中使用完整枚举名） | 业务说明 |
| --- | --- | --- |
| 完成 | `TASK_STATE_COMPLETED` | 最终 Artifact 提供业务结果与必要的非敏感运行摘要 |
| 已取消 | `TASK_STATE_CANCELED` | 已停止后续步骤、排空并落盘，不回滚外部操作 |
| 忙时拒绝 | `TASK_STATE_REJECTED` | 原因 `busy`，没有执行资源 |
| 超时 | `TASK_STATE_FAILED` | `timed-out` |
| 缺输入 | `TASK_STATE_FAILED` | `missing-input` |
| 需要登录或验证 | `TASK_STATE_FAILED` | `login-required` |
| 重启时未完成 | `TASK_STATE_FAILED` | `interrupted-unknown`，明确外部操作可能已经发生，结果未知 |

失败原因使用标准 `TaskStatus.message` 的结构化 Data Part（业务字段 `reasonCode`、`safeMessage`），同时提供安全文本说明；这些是业务结果 schema，不新增 A2A 方法、状态或错误码体系。协议格式、认证、权限、未找到任务和不可取消等问题使用标准协议错误，不能冒充业务 Task 已失败。

`CancelTask` 在可取消阶段提出停止，排空期间仍为 `WORKING`，使用标准 `TaskStatus.message` 提示正在停止。取消终态持久提交并完成结算后才报告 `CANCELED`、释放运行容量。结果已固定或已终态时返回标准 `TaskNotCancelableError`，由 `GetTask` 查询原结果。取消请求的 RPC 响应或超时不代替最终 Task；丢失响应后查询，不推定取消成功，也不重新发起业务执行。

### 恢复查询，不重放执行

- 网络断开但进程仍在：当前 Task 继续，WSS 有界退避重连并重新鉴权；非终态订阅当前快照，终态查询原结果，不回放历史事件。
- 首次受理响应丢失：原 `messageId` 重投取得原 Task，再查询或订阅；不是新一次执行。
- 重启已有终态：恢复对原 Task 的查询和交付确认，复用原结果，不装配或启动 run。
- 重启未完成：先持久转为 `FAILED`／`interrupted-unknown`，再开放查询；checkpoint 只作诊断，不恢复图或模型。
- 缺输入或人工登录：本次直接失败；处理后以新消息发起新 Task，不恢复原 Task。

### 唯一业务扩展：持久交付确认

标准查询／订阅和 WSS 发送成功不保证服务端业务已持久保存结果。本项目因此只增加一个明确声明的扩展：`urn:omniops:a2a:extension:delivery-receipt:v1`。AgentCard 的 `capabilities.extensions` 将它标记为 `required: true`，双方按标准扩展机制协商；未满足扩展要求就不受理新任务，不静默丢掉交付保证。

该扩展定义一个幂等 JSON-RPC 方法 **`omniops/ConfirmTaskDelivery`**，它是本项目扩展，**不是 A2A 标准方法**。服务端作为 A2A Client 在持久提交原结果和索引后发送，桌面 A2A 任务层处理，WSS 只转交。

| 项目 | 契约 |
| --- | --- |
| 输入 | 所选接口的标准 `tenant`、`taskId`、`resultSha256`、服务端 `receivedAt` |
| 确认对象 | 原终态 Task 的公开结果投影 `{id, contextId, status, artifacts}`；缺省 `artifacts` 规范为 `[]`，运行摘要在 Artifact 内 |
| 摘要 | 投影按 RFC 8785 规范化后计算 SHA-256；不包含 history、交付状态或摘要字段自身。终态内容先落盘再计算／发送，后续不重写时间戳或结果 |
| 摘要公布 | 终态 Task 和终态状态事件的标准 `metadata` 均在扩展 URI 命名空间内提供 `resultSha256`；查询同一终态得到相同摘要 |
| 成功输出 | 匹配的 `taskId` 与 `resultSha256`；桌面已持久保存交付确认后才响应成功 |
| 重复确认 | 同 Task 同摘要返回相同成功结果；不同摘要或未终态返回安全协议错误，不改写原执行结果 |
| 服务端义务 | 原结果与索引持久提交后才确认；重复收到结果不重复推进后续编排，具体服务端内部实现不在本仓交付范围 |
| 桌面义务 | 确认前保留终态结果；断线、重启或确认响应丢失后继续交付／确认，不重新执行 Task |

扩展只处理交付，不占运行容量，不改写 TaskState，不另增 `callId`、`resultId` 或新的恢复消息。拒绝、失败和取消 Task 同样通过其不可变终态投影完成确认。确认持久化失败必须返回错误并保留待确认状态，不能伪造已交付。

正常任务通道不发送完整提示词、逐条模型与工具过程、完整快照、SQLite 数据库或 checkpoint；这些材料仍走第 09 章的显式诊断上传。诊断接收回执与 Task 交付确认互不替代。

## 桌面更新：静态站点即可

沿用[第 05 章](./05-桌面端更新.md)，内网 HTTPS 静态站点提供 `GET /updates/stable/latest.json` 和不可变版本下载地址，不要求业务登录。它使用 Tauri updater 的原生格式，不包裹业务响应：

```json
{
  "version": "0.2.0",
  "notes": "本版更新说明",
  "pub_date": "2026-10-19T08:00:00Z",
  "platforms": {
    "darwin-aarch64": {
      "url": "https://updates.example.invalid/0.2.0/omniops-bots.app.tar.gz",
      "signature": "构建产物 .sig 文件的完整内容"
    },
    "windows-x86_64": {
      "url": "https://updates.example.invalid/0.2.0/omniops-bots-setup.exe",
      "signature": "构建产物 .sig 文件的完整内容"
    }
  }
}
```

示例域名和签名需由交付配置替换。`version` 使用有效 SemVer，不能使用资产标签 `v.1.0.0`；`signature` 是签名正文，不是签名下载 URL。macOS 使用更新专用 `.app.tar.gz`，Windows 使用选定的已签名 NSIS EXE 或 MSI；签名与 URL 必须对应同一份产物。[Tauri 官方 updater 契约](https://v2.tauri.app/plugin/updater/)规定了这些字段与平台键。

先上传并验证两个平台产物，再原子更新 `latest.json`；同版本产物、URL 和签名不变。签名私钥只在受控构建流程中，站点仅分发产物；客户端内置公钥。前端、Tauri、Node、运维 CEF 和 Playwright 等随包运行时一起更新；Agent 使用的外部 Google Chrome 单独安装和更新，不靠 Skill 同步安装浏览器工具。

无更高版本时客户端保持当前版；下载成功仍需用户确认并重新检查空闲才能安装。本期没有强制更新、静默安装、差分或自动回滚。实际 updater 接入、签名配置及两平台旧版升级验收仍待实施。

## 诊断上传、查询与附件

以下沿用[第 09 章](./09-运维与诊断上传.md)。指定 thread 的材料选择与导出由运维诊断入口承载，有权用户上传前可预览并同意；主调试桌面无法打开时仍可独立导出。它是按需故障流程，不能用另外一套“文件上传成功”响应替代诊断接收回执。

| 接口 | 输入 | 输出与成功边界 |
| --- | --- | --- |
| `GET /api/diagnostics/limits` | 当前有效身份 | 允许的格式版本、压缩包字节数、展开字节数与文件数上限；客户端准备材料前读取，提交时服务端再次校验 |
| `PUT /api/diagnostics/thread-uploads/{uploadId}` | 已鉴权请求、单个 thread 诊断 ZIP、包 SHA-256；包内含 manifest | 包校验完成、持久保存且索引提交后返回回执；`202` 只表示处理中 |
| `GET /api/diagnostics/thread-uploads/{uploadId}` | 同一授权范围的上传 ID | 未接收、处理中、失败或已接收回执；请求超时后据此核对 |
| `GET /api/diagnostics` | 有权限的来源设备／thread／run／状态筛选及分页参数 | 可访问的诊断摘要列表，失败或未完成暂存不伪装成已接收 |
| `GET /api/diagnostics/{diagnosticId}` | 有权限的诊断 ID | 只读摘要、run／checkpoint 时间线、完整性与缺失项、附件索引 |
| `GET /api/diagnostics/{diagnosticId}/attachments/{attachmentId}` | 有权限的附件 ID，不能传任意磁盘路径 | 校验归属后返回附件字节或短时受限下载地址；浏览器下载不执行附件代码 |

幂等身份沿用 `uploadId`，绑定来源安装、thread 与包摘要；同 ID 同包返回同一回执，不同包返回冲突。回执至少有 `uploadId`、`diagnosticId`、`threadId`、`bundleSha256`、`receivedAt`、完整性和缺失清单。没有包及可查询索引的持久提交，不能返回“已接收”。

客户端 SQLite 只导出所选 thread 关联的 run、全部 namespace、checkpoint 依赖和 pending writes；服务端接收逻辑归档，**不接收全库、WAL／SHM 或浏览器登录态**。校验归属、摘要、格式版本、路径及压缩／解压上限，保留可理解的缺失和脱敏说明。

诊断存储与生产可执行 checkpointer 隔离，查看或下载不触发模型、MCP、Playwright，也不 `invoke`／`stream`／`resume` 原任务。附件权限、保留期限与删除按现有服务端策略执行。

## 联调验收与交付边界

1. 验证线上业务从 Console 发起，经服务端 Agent 调用后台客户端，状态与结果回到 Console；本地只需基础连接状态。用普通用户、运维和越权身份验证清单读取、草稿写入、发布、任务连接及诊断下载；前端隐藏操作不影响服务端权限判断。
2. 同一完整 Skill 包在两端得到相同内容 ID，目录与原始字节不变；缺包、损坏、过期下载地址及半包均不进入运行。
3. 覆盖草稿重试、并发发布、标签冲突和 Skill／Agent 联动失败，确认无部分发布；超时后原幂等键得到同一结果。
4. 覆盖 messageId 重复／内容冲突、并发受理、REJECTED 查询、取消与结算竞争、交付确认丢失、断线和重启；验证 Task 状态、标准操作和唯一扩展，不重复执行或推进服务端后续调度。
5. 两个平台验证正确 updater 清单、真实签名产物与旧版升级；错误包不安装，任务期间不退出。
6. 上传真实的指定 thread 诊断包，验证持久接收、回执幂等、权限、材料缺失和附件下载；浏览诊断不产生执行副作用。

首版使用持久化的修订、发布结果、调用状态、交付确认和诊断回执完成排查，不新增日志平台、span 或指标。后续确需遥测时再确认字段与统计口径；用户正文、checkpoint 和浏览器凭据不作为遥测材料。
