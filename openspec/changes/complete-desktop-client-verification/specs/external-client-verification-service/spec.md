## ADDED Requirements

### Requirement: Verification peer runs independently of the client
项目 SHALL 提供位于 `desktop/verification/` 的独立外部验证服务，可在本机独立进程或另一台机器启动，接收客户端主动连接的 `/api/clients/connect` 并发起 A2A 调用。外部服务 SHALL 仅经公开网络协议获取业务结果，不能 import 客户端 A2AService、runtime、store 或使用同进程函数调用替代验收。实现 SHALL 复用 `desktop/runtime/package.json` 管理的标准库和已锁依赖，不新增生产账号、调度或数据库服务架构。

#### Scenario: Separate process exercises real WSS access
- **WHEN** 客户端与验证服务在不同进程启动
- **THEN** 验证服务可通过真实 WSS 提交、查询、订阅、取消并确认 Task，业务输入输出不依赖测试父进程 IPC

#### Scenario: Remote deployment preserves the same protocol
- **WHEN** 验证服务部署到另一台机器并使用有效 TLS 配置
- **THEN** 客户端以 HTTPS／WSS 验证证书后接入，保持同一 binding、A2A 对象和权限契约；不关闭 TLS 校验

### Requirement: Verification identity and control surfaces are separated
服务 SHALL 用受控测试凭据映射可信组织、caller、安装、权限和有效期，通过 `GET /api/session` 与 Upgrade 表达相同身份。普通用户、运维及越权身份 SHALL 能独立验证授权；静态测试凭据 SHALL 明确标识为 fixture，不能宣称生产登录／续期完成。故障控制面 SHALL 仅监听 loopback 或使用父进程 IPC，不能暴露于远端业务端口；控制操作 SHALL 不新增生产 WSS 业务帧。

#### Scenario: Gateway rejects an invalid identity binding
- **WHEN** 网关使用同一已核验凭据检查安装或主体绑定失败
- **THEN** 网关拒绝 Upgrade，客户端不进入 connected；测试不以 fixture 特权绕过，也不宣称客户端能在缺少身份回显时发现受信网关擅自重映射主体

#### Scenario: Remote caller cannot invoke the fault controller
- **WHEN** 从非 loopback 地址访问测试控制接口
- **THEN** 控制面不可达，业务端口也不存在同等故障注入路由或私有 WSS 控制消息

### Requirement: Fixture APIs cover the required platform contracts
外部服务 SHALL 提供第 10 章所需的测试 API：session；官方 Agent／Skill 目录、版本、精确 manifest 和完整包下载；完整草稿修订、发布预览及原子 Skill／Agent 联动发布；静态更新清单与测试签名产物；指定 thread 的诊断限制、上传、状态、查询及授权附件下载。HTTPS JSON 业务 API SHALL 使用 `schemaVersion: 1`，A2A SHALL 使用其标准对象，二进制和 Tauri 更新清单 SHALL 保持各自格式。fixture SHALL 保留原始包字节、不可变 contentId、幂等请求结果和授权边界，不能全部返回固定成功。

#### Scenario: Empty cache obtains one exact official assembly
- **WHEN** 客户端没有所指定版本的正式 Agent 与 Skill 缓存
- **THEN** 客户端经 fixture API 下载并校验完整包后运行；服务端能证明所取版本和原始字节，客户端不读取测试共享目录代替下载

#### Scenario: Draft or linked release conflict is observable
- **WHEN** expectedRevision、预览基线、expectedContentId 或标签发生冲突
- **THEN** fixture 返回相应失败，没有部分发布；相同幂等请求重试得到同一已提交结果

#### Scenario: Maintenance uses actual protocol artifacts
- **WHEN** 客户端验证更新或上传指定 thread 诊断
- **THEN** 验证服务实际交付更新清单和产物、接收诊断字节并返回持久回执，不能只由页面模拟状态证明完成

### Requirement: Calls and results survive peer process restart
服务 SHALL 维护自己的持久账本，保存不可变调用意图、稳定 messageId、目标安装、确定版本、业务输入、taskId 映射、原终态 Task、摘要及结果消费标记。调用意图 SHALL 在发送前提交；结果和索引 SHALL 在 receipt 前提交。账本 SHALL 使用已有 SQLite 或原子文件能力，独立于客户端数据库。重启 SHALL 从持久记录沿原 messageId／taskId 对账，不依赖旧 Promise，不自动使用新消息触发重复执行。

#### Scenario: Peer restart after sending but before learning task id
- **WHEN** 调用意图已持久提交且请求已发出，验证服务在保存 taskId 前崩溃
- **THEN** 重启后以同一 messageId 和输入重投取得原 Task，并验证实际运行次数为一

#### Scenario: Peer restart after result commit but before receipt
- **WHEN** 原终态与索引已持久保存，确认尚未成功时验证服务崩溃
- **THEN** 重启后校验同一摘要并重试交付确认，不再执行或重复消费业务结果

#### Scenario: Failure to persist result prevents premature acknowledgement
- **WHEN** 验证服务结果保存失败或事务回滚
- **THEN** 不发送成功交付确认，客户端仍保留可查询结果，服务恢复后可重新接收并核对

### Requirement: Deterministic fixtures exercise real execution dependencies
服务配套 SHALL 提供确定性本地 OpenAI Chat Completions 兼容模型、本地 MCP 和业务测试站点，覆盖结构化输入输出、受控工具调用、延迟、失败、登录要求与取消排空。客户端黑盒验收 SHALL 运行实际 runtime／LangGraph，并在浏览器用例中使用受管理外部 Chrome；模型／MCP／网站的测试观测可证明启动、排空及副作用次数，但 SHALL 不承载绕过业务协议的请求和结果。测试 SHALL 不依赖真实模型 Key 或付费服务。

#### Scenario: Browser task proves the bound Chrome target was used
- **WHEN** 外部 WSS Task 经模型工具调用访问本地业务站点
- **THEN** 对应独立 thread 的受管理 Chrome 页面产生可核对副作用，切换调试视图或操作手动 CEF 不改变目标

#### Scenario: Controlled cancellation has a measurable drain interval
- **WHEN** fixture 模型或工具收到停止 signal 后仍短暂排空
- **THEN** 验收可观察 WORKING 期间容量未释放，实际操作排空后才报告 CANCELED

#### Scenario: Output falsy values are checked on the wire
- **WHEN** fixture 返回对象、0、false 和 null
- **THEN** 外部验收检查原始标准线上 JSON、Task 查询与摘要一致，不因 SDK typed client 默认化而漏掉 null

### Requirement: Fault injection covers protocol and durability boundaries
验证服务 SHALL 能确定性注入握手缺头／错版／缺扩展、认证与到期失败、断线、丢受理响应、丢确认响应、暂停读取、乱序晚回调条件、协议非法报文、资源坏包／半包／超限、草稿发布竞争及诊断接收失败；客户端或服务强退 SHALL 使用真实进程停止验证恢复。注入 SHALL 有明确开始条件和有限等待，不以任意固定长 sleep 代替可观察边界。服务 SHALL 遵守有限消息、队列和调用账本资源预算，关闭过程有界。

#### Scenario: Lost response targets the committed acceptance boundary
- **WHEN** 服务在已持久受理后丢弃首个响应并断线
- **THEN** 重投验证定位于同一 Task，而不是重新提交新业务或误把未发送请求当丢响应

#### Scenario: Backpressure does not falsely prove cancellation
- **WHEN** 服务停止读取使客户端发送队列达到上限
- **THEN** 验收分别检查连接清理与 Task 仍可持久结算，不能将断线当成业务取消成功

#### Scenario: Corrupted package never enters execution
- **WHEN** 服务返回摘要错误、路径穿越、符号链接或展开超限的完整包
- **THEN** 客户端安全失败且正式缓存未被半包替换，模型和工具不开始执行

### Requirement: Verification evidence is reproducible and scoped
验证服务 SHALL 为统一验收入口提供可重复场景和安全证据，覆盖 WS-01 至 WS-12、EXT-01 至 EXT-04 对应的协议、真实运行、持久交付及对端重启边界。报告 SHALL 记录用例 ID、输入 fixture 身份、预期／实际、命令、退出码、平台和对应证据路径；只能将实际执行且断言通过的用例计为通过。服务 SHALL 不新增产品日志、span 或指标；测试报告与既有持久结果承担验收证据，凭据、真实用户正文及原始错误链不能作为遥测输出。

#### Scenario: Missing independent peer blocks a full pass
- **WHEN** 没有启动独立对端，或仅运行模块 fake／HTTP A2A 测试
- **THEN** WSS 与外部服务验收标记未执行或失败，整体不能声称完整客户端通过

#### Scenario: Fixture acceptance does not claim production platform completion
- **WHEN** 独立验证服务全部场景通过
- **THEN** 报告仅证明客户端对所冻结测试契约的兼容性，生产认证、多机网关、PostgreSQL／Redis／NFS 和未执行平台整包仍保留各自未验状态
