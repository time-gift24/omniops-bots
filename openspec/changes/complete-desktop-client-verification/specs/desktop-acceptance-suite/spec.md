## ADDED Requirements

### Requirement: Complete and honest requirement traceability

验收清单 SHALL 覆盖需求串讲 README、全部核心章节、00–11 章及正式 Agent／Skill 包布局，并为每项声明来源、场景 ID、前置条件、刺激、可观察断言、证据层级与实施状态。历史截图、文档验证、演示 adapter、独立模块 fixture 和产品整链路证据 SHALL 分开。未实施或本次未执行的能力 SHALL NOT 标为产品验收通过。

#### Scenario: Existing module tests pass before WSS integration
- **WHEN** 现有 A2A 模块测试通过而桌面入口没有 WSS binding
- **THEN** 报告仅确认独立模块证据，WSS 整链路标为未执行或失败，不能给出客户端全功能通过结论

### Requirement: One-shot acceptance profiles

实施后 SHALL 提供 `node desktop/verification/verify.mjs --profile full --config <absolute-path>`，一次执行当前目标平台的全部必需阶段并生成报告；`--profile contract` SHALL 仅给出声明范围内的契约结论，不能替代完整平台验收。配置、依赖、fixture、Chrome、原生宿主、旧版更新包或必需权限缺失 SHALL 显式阻止所需完整通过；不得静默跳过。

#### Scenario: A required native prerequisite is unavailable
- **WHEN** full 模式缺少系统凭据库、真实宿主或更新旧版安装环境
- **THEN** 报告将相应场景记为 not-run 并附原因，整体不通过，不能由浏览器 fake 补成 passed

#### Scenario: Contract-only verification succeeds
- **WHEN** 用户选择 contract 且其声明的协议场景全部通过
- **THEN** 报告标明 scoped contract pass 及未覆盖范围，不声称 full 或双平台通过

### Requirement: Independent external service and safe fixtures

验收 SHALL 使用独立进程、可部署在另一台机器的 WSS／HTTPS 验证服务；服务配置、数据目录、fixture 集及控制端授权 SHALL 显式指定。模型请求 SHALL 使用本地可控 fixture，无真实密钥或付费服务；WSS／HTTPS SHALL 保留证书和主机名校验，可显式信任测试 CA，不允许全局 TLS 绕过。固定 token 的身份 fixture SHALL 明示其不能证明生产身份平台集成。

#### Scenario: External host presents an untrusted certificate
- **WHEN** 验证服务证书不受信或主机名不匹配
- **THEN** 客户端拒绝连接并输出安全分类，验收不通过，runner 不关闭 TLS 校验以继续

#### Scenario: Fixture identity succeeds
- **WHEN** 客户端通过隔离 fixture 身份获得任务权限
- **THEN** 报告记录身份 fixture 范围，生产登录、Token 续期和运维授权仍需对应集成证据

### Requirement: Real client effects and failure evidence

整链路场景 SHALL 通过正常客户端入口接收外部任务，验证指定版本获取、固定装配、本机模型选择、MCP、真实 Chrome 页面副作用、SQLite 证据、结果持久接收和匹配 ACK。重复投递、取消、超时、断线、进程重启、背压及权限失败 SHALL 验证模型和业务副作用次数，证明没有自动重跑。测试 SHALL 不仅依赖客户端自报成功。

#### Scenario: Service reconnects after a task completed offline
- **WHEN** 断线期间客户端完成一次浏览器操作后恢复 WSS
- **THEN** 独立服务接收并持久确认原结果，模型请求和页面副作用仍各对应原执行次数，不产生新 run

### Requirement: Distinct browser and native validation layers

runner SHALL 分别执行 Node 单测、浏览器用例、真实客户端进程和已安装原生包门槛。浏览器 HTML 回归 SHALL 等待明确 PASS／FAIL、捕获 pageerror 并设置截止时间，不能以加载成功替代断言。user 与 operations 及生产构建 SHALL 分别验证；真实系统凭据、CEF、Tauri IPC、原生 SQLite 和更新安装 SHALL 通过目标平台实际环境验证。

#### Scenario: Browser fixture shows a pass with a page exception
- **WHEN** 页面出现未处理异常或在截止时间内没有可判定的终态
- **THEN** runner 将场景记为失败，不因页面打开或存在 PASS 字样忽略异常

#### Scenario: Cross-built Windows package passes static inspection
- **WHEN** Windows 安装包仅在 macOS 完成交叉构建与 PE／ABI／哈希检查
- **THEN** 报告只确认静态产物检查，Windows 实际加载、凭据、浏览器与安装门槛仍为 not-run

### Requirement: Reproducible reports and two-platform merge

每份报告 SHALL 记录格式版本、源码 commit 与 dirty 状态、候选版本及包 SHA-256、平台／架构／Node ABI、fixture 集摘要、脱敏配置身份、每个场景的命令、时间、`passed | failed | not-run` 状态及证据引用。`not-run` SHALL 带原因。双平台结论 SHALL 仅由 macOS ARM64 与 Windows x64 的兼容完整报告合并产生，绑定同一候选源码与 fixture 版本；不同平台包允许各自摘要，缺失、失败、混版或不完整报告 SHALL 拒绝完整通过。

#### Scenario: Merge receives only one platform report
- **WHEN** `--merge` 缺少任一必需平台或报告不是 full
- **THEN** 汇总明确缺失范围并返回非零，不生成双平台全通过结论

#### Scenario: Merge receives matching complete reports
- **WHEN** 两个平台报告的所有必需场景通过且候选版本、源码和 fixture 身份匹配
- **THEN** 汇总列出两个平台包摘要与证据，并给出双平台完整通过结论

### Requirement: Bounded cleanup and unchanged observation behavior

runner SHALL 为每个独立场景分配隔离数据根、身份和浏览器 profile，并在成功、失败、取消和超时后按共同截止时间关闭本次服务、任务、浏览器、子进程和存储；不得终止用户原有 Chrome 或修改真实用户配置。失败证据 SHALL 在清理前保存。验证 SHALL 覆盖未初始化遥测、输出背压与遥测故障下业务结果不变，且不新增专门日志、span 或指标。

#### Scenario: A fault scenario times out
- **WHEN** 服务或客户端故障使场景超时
- **THEN** 保存安全证据和失败结果，在关闭预算内清理本次资源，后续独立场景不受残留进程影响
