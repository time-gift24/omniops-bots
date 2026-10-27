## Why

需求串讲已覆盖客户端完整使用链路，但现有独立 A2A 验证尚未覆盖桌面进程的 WSS 接入、正式物料获取及维护交付，部分页面仍使用演示数据。需要一份以当前代码为起点的实施设计，并提供独立外部 WS 验证服务和统一验收入口，让每项需求都有可重复执行的成功与失败证据。

## What Changes

- 将需求串讲的核心章节、00–11 章和正式包布局逐项映射到代码、缺口、实现任务与验收用例；历史截图、文档检查、demo adapter 和 fixture 不能替代真实桌面链路验收。
- 在现有 Node 主后端组装已实现的 A2AService，完成客户端主动连接的 WSS binding、可信身份、精确官方版本解析、有限队列、断线查询和持久回执；保留原有并发准入、取消排空及不自动重跑语义。
- 补齐客户端依赖的正式物料缓存、草稿上传与原子联动发布、运行指纹、基础连接界面、更新和按 thread 诊断的接入设计。复用现有 Provider、Skill 编辑、LangGraph、Chrome 与手动 CEF。
- 提供独立进程运行的外部 WS 验证服务，兼有第 10 章所需 HTTPS 测试接口、本地模型／MCP／业务页面和确定性故障注入。它可部署到另一台机器，持久接收结果后才发送交付确认，是测试配套而非本仓生产服务端。
- 提供一次执行、汇总全部用例的验收设计：单测、独立 A2A、WSS 黑盒、Chrome、真实 Tauri／IPC 和分平台整包门槛分别留证；缺能力、缺环境和未执行必须阻止对应完整通过结论。

## Capabilities

### New Capabilities

- `desktop-platform-resources`: 平台身份、不可变 Agent／Skill 包、精确版本缓存、草稿与联动发布、固定运行快照及指纹。
- `desktop-wss-task-channel`: 桌面入口和现有 A2AService 的 WSS 接入、协商、授权、背压、恢复查询、回执及退出生命周期。
- `external-client-verification-service`: 可独立部署的 WS／HTTPS 验证对端、确定性物料与模型、持久交接及受控故障场景。
- `desktop-maintenance-delivery`: 线上基础状态、运维权限入口、签名整包更新及指定 thread 诊断导出／上传。
- `desktop-acceptance-suite`: 全需求追踪、一次执行入口、分层证据、平台验收和无伪成功的结果判定。

### Modified Capabilities

无。已发布的 `observability-runtime` 不变；沿用已确认的“不新增专门日志、span 或指标”，验收报告使用测试断言和现有安全状态。未归档的 `define-desktop-a2a-interface` 已实现模块继续作为依赖，其暂缓的 WSS 工作由本 change 细化承接，不重复实现 A2A 核心；`add-client-chat-interface` 保留既有聊天呈现契约。

## Impact

- 后续实现涉及 `desktop/runtime/main.ts`、`a2a/`、`resources.ts`、`assembly.ts`、`skill-library.ts` 和现有配置／执行边界；`web/` 的 interface／Tauri adapter 与对应维护界面；Tauri 宿主只增必需系统能力与生命周期组装。
- 验证配套拟放在 `desktop/verification/`，由 `desktop/runtime/package.json` 管理 Node 依赖，不增加业务后端 crate、账号体系、调度器或生产 PostgreSQL／Redis／NFS 服务。
- WSS 需要具备公开 Upgrade 响应校验及有限发送队列能力的标准 WebSocket 库；当前 runtime 未直接声明 `ws`，实施时增加直接锁定依赖，客户端和验证服务共用该依赖。归档、解包和 Tauri updater 同样先复用现有能力，确有缺口才补最小直接依赖。
- 正式 Agent 包的 `contentId` 与当前本地配置摘要不同，迁移必须区分本地资源与不可变正式版本；不改写历史 Run／快照，不以新摘要解释旧数据。
- 本次产出是 proposal、design、规格、实施任务和验收矩阵，并完成其一致性验证；所有产品实施与新验收命令在任务清单中保持未完成，不能据此宣称客户端全功能已经验收。
