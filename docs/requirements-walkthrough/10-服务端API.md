# 10 · 服务端 API：客户端接入所需的最小契约

> 串讲重点：服务端提供身份与权限、官方物料、草稿与发布、远端任务通道、桌面更新和诊断接收；每项接口都明确何时才算成功，以及断线后怎样查询或重试。

**本章是拟定的接入契约，相关平台 API 和 WebSocket 通道尚未实现。** 路径名称可适配现有平台网关，输入输出与成功边界保持一致；不据此另建账号体系、审批平台或文件级发布服务。客户端已实现的本地能力见[第 08 章](./08-前端现状与缺口.md)。

## API 分组与边界

| 能力 | 服务端提供 | 客户端负责 |
| --- | --- | --- |
| 身份与权限 | 复用现有登录、Token、组织及设备身份，返回可执行操作 | 展示身份与权限，使用当前登录态请求 |
| 官方物料 | Agent／Skill 版本清单、确定装配、完整包下载 | 校验、按需缓存、固定会话快照 |
| 草稿与发布 | 保存完整修订，校验标签，原子发布关联资源 | 本地编辑与实验，提交明确修订和手填标签 |
| 远端任务 | WebSocket 下发调用／取消，持久接收结果并确认 | 专用 Chrome 执行互斥、过程展示、结果落盘与补传 |
| 桌面更新 | 静态 `latest.json` 和已签名整包 | 用户确认下载与安装，空闲时更新 |
| 故障诊断 | 接收指定 thread 的包、回执、只读检索及附件 | 从本地 SQLite 导出 checkpoint，预览脱敏材料后上传 |

HTTPS 传输物料、发布请求和诊断包；WebSocket 传输任务控制与结果，不传 Skill 文件包，也不持续上报每条模型输出。Playwright 与内置 Chrome／Chromium 运行在客户端，服务端不远程暴露浏览器 CDP 端口或接收浏览器 profile。

## 统一契约

业务 API 使用 HTTPS `/api/…`，JSON 使用 UTF-8，时间为带时区的 RFC 3339；业务 JSON 请求体、成功响应和 WebSocket 报文携带 `schemaVersion: 1`，不支持的版本明确拒绝。GET 请求无需 JSON 请求体；二进制上传在 manifest 声明版本，二进制下载与 Tauri 更新清单遵循各自格式，不套 JSON 业务响应。

- 复用现有 Bearer Token 或平台既有安全会话机制；服务端从已验证凭据确定用户、组织和权限，不相信请求正文自报的身份。下载 URL 与诊断附件同样需要授权，可使用短时有效的受限下载地址。
- 普通用户读取有权使用的官方版本、执行自己的任务并提交自己的诊断；运维人员维护官方草稿和发布。仅在前端隐藏按钮不能代替服务端权限检查。
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
| `contentId` | 完整 Skill 包或确定 Agent 装配的不可变内容摘要；文档中的“新 Agent ID”指新的装配内容身份，调用时同时传资源身份与内容摘要 |
| `draftRevisionId` | 一次已保存的完整草稿修订；不等于内容摘要或正式标签 |
| `releaseTag` | 运维手填的 `v.1.0.0` 形式标签，同一资源内不得重用、覆盖或改指向 |
| `callId` | 一次远端调用的去重与结果交付身份；服务端重新安排执行必须使用新 ID |
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

客户端只请求当前装配缺少的包；已缓存相同完整版本可复用。新会话核对版本，已有会话继续使用固定快照。清单、权限、下载或摘要任一失败都停止本次准备，不回退旧版或移除缺失能力后继续执行。

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

## WebSocket：调用、取消、结果和确认

客户端以现有身份连接 `WSS /api/clients/connect`。握手校验用户、组织及安装身份，连接归属不能由正文任意指定；凭据不放 URL 查询串。首帧协商 `schemaVersion`、`clientInstallationId`、桌面版本和支持的 builtinTool ID，服务端确认连接可用后再投递任务。

每条业务消息包含 `schemaVersion`、`type`、`messageId`、`callId`（连接级消息除外）与 `payload`。`messageId` 标识一次投递，`callId` 标识一次业务执行；重投可以有新消息 ID，但不能改变调用内容。每个 Agent 的业务 `input`／`result` schema 由该 Agent 对应的服务端业务单独定义。

| 消息 | 方向 | 最少业务字段与含义 |
| --- | --- | --- |
| `task.call` | 服务端 → 客户端 | `callId`、指定客户端、`agentId`、`agentContentId`、`input`、`context`、调用有效期；调用确定官方版本，不调用本地私有 Agent |
| `task.accepted` | 客户端 → 服务端 | `callId`、`threadId`、`runId`、接收时间；去重记录落盘且取得本轮执行名额后发送，只表示受理 |
| `task.status` | 客户端 → 服务端 | `callId`、单调递增 `sequence`、准备／执行／停止中状态；用于状态展示，不以它代替最终结果 |
| `task.cancel` | 服务端 → 客户端 | 原 `callId`、取消请求 ID；只针对这次调用，不取消其他任务 |
| `task.cancelled-receipt` | 客户端 → 服务端 | 取消请求 ID、`stopping`／`already-finished`／`not-found`；收到取消不等于工具已停止 |
| `task.result` | 客户端 → 服务端 | `callId`、稳定 `resultId`、结果摘要、终态、结果或安全错误类别、起止时间、运行快照；如未开始则说明无 run／快照 |
| `task.result-ack` | 服务端 → 客户端 | `callId`、`resultId`、同一结果摘要、服务端接收时间；结果与索引已持久提交才确认 |

### 调用去重与忙时处理

客户端在鉴权范围和安装身份内持久记录 `callId` 与不可变调用内容，**先检查重复，再争用执行名额**。重复投递同一调用时，只返回已知受理状态或原结果，不开始第二次模型、MCP 或 Chrome 操作；同 ID 不同内容明确拒绝为 `call-conflict`。

新调用只创建一个独立的客户端 thread／run。本地、实验与远端任务共用同一名额，准备和停止排空期间也占用；忙时保存并返回 `busy`，不进入客户端队列。服务端如决定重试执行，使用新 `callId`；重新发送已返回忙的旧 ID 仍得到原拒绝结果。

去重记录不能在服务端仍可能重投时提前清理；清理期限覆盖约定的最大重投窗口，过期调用明确拒绝，不能当成新任务。过期、权限不足、版本不匹配和准备失败均有明确结果，不用“收到消息”代替成功执行。

### 终态、结果补传与取消

执行终态区分 `completed`、`failed`、`cancelled`、`timed-out`、`interrupted-unknown`；未受理调用另返回 `busy` 等拒绝类别。终态和结果交付状态分别保存，运行结束先落盘，再发送结果。结果包含实际 Agent／Skill、启用工具／MCP、桌面版本及模型参数，排除凭据。

服务端按鉴权范围、安装身份、`callId` 和 `resultId` 幂等接收；相同结果重复发送返回同一 ACK，不重复驱动后续调度，同 ID 不同摘要返回冲突。客户端核对 ID 与摘要后才记为已交付，普通 WebSocket 发送成功或连接心跳不能充当结果 ACK。

- 网络断开但进程仍在：当前任务继续，客户端有界退避重连；重新鉴权完成后补传未 ACK 的原结果，不重新执行。
- 重启发现已完成结果：恢复交付，复用原 `resultId` 和摘要；不重新装配 Agent。
- 重启发现未完成任务：保存并回传 `interrupted-unknown`，不自动续跑或重试。SQLite checkpoint 仅提供诊断证据，不改变该规则。
- 收到取消或到达客户端兜底超时：停止后续步骤，等已发起操作排空后保存终态；取消回执与最终结果分开。任务已结束时返回原结果，不能改写终态。
- 遇到人工登录／验证：本轮失败，用户在专用浏览器处理后新发起调用。已执行的外部操作不回滚，也不承诺外部副作用恰好发生一次。

正常任务通道不发送逐条模型正文、完整工具过程、SQLite 数据库或 checkpoint。需要这些材料时使用第 09 章的显式诊断上传；结果 ACK 与诊断接收回执互不替代。

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

先上传并验证两个平台产物，再原子更新 `latest.json`；同版本产物、URL 和签名不变。签名私钥只在受控构建流程中，站点仅分发产物；客户端内置公钥。前端、Tauri、Node、CEF／内置浏览器和 Playwright 等随包运行时一起更新，不靠 Skill 同步安装浏览器工具。

无更高版本时客户端保持当前版；下载成功仍需用户确认并重新检查空闲才能安装。本期没有强制更新、静默安装、差分或自动回滚。实际 updater 接入、签名配置及两平台旧版升级验收仍待实施。

## 诊断上传、查询与附件

以下沿用[第 09 章](./09-运维与诊断上传.md)，不能用另外一套“文件上传成功”响应替代诊断接收回执。

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

1. 用普通用户、运维和越权身份验证清单读取、草稿写入、发布、任务连接及诊断下载；前端隐藏操作不影响服务端权限判断。
2. 同一完整 Skill 包在两端得到相同内容 ID，目录与原始字节不变；缺包、损坏、过期下载地址及半包均不进入运行。
3. 覆盖草稿重试、并发发布、标签冲突和 Skill／Agent 联动失败，确认无部分发布；超时后原幂等键得到同一结果。
4. 覆盖调用重复、同 ID 不同内容、忙时拒绝、取消竞争、丢失结果 ACK、断线和重启；不重复执行，不重复推进服务端后续调度。
5. 两个平台验证正确 updater 清单、真实签名产物与旧版升级；错误包不安装，任务期间不退出。
6. 上传真实的指定 thread 诊断包，验证持久接收、回执幂等、权限、材料缺失和附件下载；浏览诊断不产生执行副作用。

首版使用持久化的修订、发布结果、调用状态、交付确认和诊断回执完成排查，不新增日志平台、span 或指标。后续确需遥测时再确认字段与统计口径；用户正文、checkpoint 和浏览器凭据不作为遥测材料。
