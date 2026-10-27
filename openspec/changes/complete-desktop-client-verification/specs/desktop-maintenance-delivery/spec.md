## ADDED Requirements

### Requirement: User status and operations access

客户端 SHALL 在普通用户入口提供连接、认证、重连及必要维护状态；线上业务发起、取消和结果查看 SHALL 由外部 Console 承接。运维调试入口 SHALL 经可信身份权限开放。构建 edition 和隐藏按钮 SHALL NOT 替代服务端授权；共享页面 SHALL 只调用自有 interface，由入口选择真实 adapter。

#### Scenario: User opens a connected client
- **WHEN** 普通用户打开客户端且远端连接已完成认证
- **THEN** 基础界面展示真实连接及维护状态，业务运行不要求用户进入调试桌面，不创建空会话或自动聚焦 Chrome

#### Scenario: Operations permission is absent or expires
- **WHEN** 当前身份没有运维权限或权限在操作前失效
- **THEN** 客户端关闭运维写入入口，外部接口拒绝越权请求，未保存编辑保留，任务和已有记录不伪装成成功

### Requirement: Separate execution and delivery state

客户端 SHALL 分别保存和展示执行终态与结果交付状态。远端 thread 的运维查看 SHALL 为只读；切页、关闭面板和连接恢复 SHALL NOT 取消任务、改变绑定 Chrome 页面或重新执行。桌面启动失败 SHALL 显示明确失败及重试入口，不回退演示数据。

#### Scenario: Result waits for a durable acknowledgement
- **WHEN** 执行已结束但外部服务尚未确认持久接收结果
- **THEN** 记录保留原执行终态并显示结果待确认，收到匹配身份和摘要的持久回执后才显示已交付

#### Scenario: Operator changes the visible thread
- **WHEN** 运维在任务执行期间切换工作台或查看其他 thread
- **THEN** 原任务继续消费事件且操作原绑定页面，只读远端会话不产生本地续跑入口

### Requirement: Signed full-package update lifecycle

客户端 SHALL 在启动就绪后非阻塞检查一次更新，并提供手动检查；仅接受适配当前平台、架构、稳定通道的更高有效 SemVer。下载 SHALL 经用户主动发起，使用正常 TLS 验证和内置公钥验签；下载完成 SHALL 进入待安装，不能自动安装。同版、旧版、无效清单、错误包或签名不符 SHALL 明确失败并保留现应用。

#### Scenario: A valid newer package is downloaded
- **WHEN** 用户下载适配目标的更高版本且完整性和签名验证通过
- **THEN** 页面显示真实下载进度及待安装状态，等待用户明确安装确认

#### Scenario: Package verification fails
- **WHEN** TLS、下载、完整性或签名验证失败
- **THEN** 不调用安装器、不退出应用，显示安全错误并保留当前任务与数据

### Requirement: Update installation shares task admission

安装准备 SHALL 与本地调试、Skill 实验和远端任务共用原子准入边界。存在准备、执行、停止或未排空写入活动时 SHALL 拒绝安装并要求任务结束后再次用户确认；安装准备先取得准入时 SHALL 明确拒绝新任务。安装前 SHALL 在调用方给定的共同截止时间内释放任务、浏览器、存储及 Node 进程资源。安装与新版本启动完成后才 SHALL 判为升级成功，应用数据目录 SHALL 保留。

#### Scenario: User confirms while a task is active
- **WHEN** 已验证更新待安装且用户确认时存在执行活动
- **THEN** 客户端提示等待，不安装、不停止任务，任务结束本身不代替用户再次确认

#### Scenario: Installation preparation wins the admission race
- **WHEN** 空闲时用户确认安装且安装准备已取得准入
- **THEN** 新任务收到明确不可执行结果，资源清理完成才交给安装器，重启后版本正确且已有配置、会话、物料和证据可读

### Requirement: Consistent single-thread diagnostic export

诊断导出 SHALL 仅包含授权用户选择的一个业务 thread，按 threadId、runId、graphThreadId 映射读取所有关联图 namespace、checkpoint、父关系与 pending writes，以及已保存消息、记录和快照。导出 SHALL 阻止该 thread 开始新轮次，确认无执行活动且写入排空后冻结一致截止点；冻结后释放锁，后续数据不进入本包。导出 SHALL 使用逻辑读取，不复制整库、WAL 或 SHM，也不复制全库后删除其他 thread。

#### Scenario: Another thread continues running
- **WHEN** 所选 thread 已结束但其他 thread 正在执行
- **THEN** 仅冻结并导出所选 thread，其他 thread 继续运行，包中没有其他 thread 内容

#### Scenario: Selected thread is active
- **WHEN** 用户为正在准备、执行或停止的 thread 请求导出
- **THEN** 显示等待或显式停止的选择，不偷偷取消任务、不产生半写入快照，等待超时明确失败

### Requirement: Diagnostic confidentiality and completeness

客户端 SHALL 从冻结副本生成版本化 manifest、包内相对路径、文件字节数、SHA-256、截止点、版本和缺失说明，上传前提供材料清单、接收服务、身份及脱敏预览并取得知情确认。凭据、认证头、环境文件、浏览器 profile 和其他 thread 材料 SHALL 排除；脱敏 SHALL NOT 改写原件。旧版无 checkpoint、损坏记录、未知序列化值和缺失附件 SHALL 明确标记，不能伪造完整性、自动修库、补拍或重跑。

#### Scenario: SQLite or an attachment is unreadable
- **WHEN** 所选 thread 的部分证据不可读而其他材料仍可安全取得
- **THEN** 保留原件，导出可读材料并列出稳定错误与缺失项，不上传整库或后来补造的现场

#### Scenario: Credentials occur inside checkpoint values
- **WHEN** 消息、工具内容、metadata 或 pending writes 中含测试凭据
- **THEN** 导出副本经统一脱敏且预览可核查，包、普通配置和遥测中不出现凭据值，本地原件不被覆盖

### Requirement: Durable and idempotent diagnostic reception

上传 SHALL 使用 HTTPS 单包上传与接收状态查询；同一不可变包重试 SHALL 保留 uploadId 和摘要，内容变化 SHALL 使用新 ID。只有外部服务已持久保存包及可查询索引，且客户端核对回执中的 uploadId、threadId 和 bundleSha256 后，才 SHALL 显示已接收。HTTP 202 SHALL 仅表示处理中；同 ID 不同摘要 SHALL 冲突，权限失败 SHALL 保留本地包。取消准备或上传 SHALL NOT 改变原 run 终态。

#### Scenario: Receipt is lost after server persistence
- **WHEN** 服务端已提交诊断包但客户端未收到回执
- **THEN** 客户端先按 uploadId 查询，再按需要重传同一包；最终获得同一 diagnosticId，不产生重复材料

#### Scenario: Server returns processing or conflicting content
- **WHEN** 上传返回 HTTP 202 或同 uploadId 对应不同摘要
- **THEN** 前者保持接收待确认并查询，后者显示冲突；两者均不显示已接收

### Requirement: Independent read-only diagnostics and observation boundary

客户端 SHALL 提供不依赖主调试桌面、Agent、模型、MCP 或浏览器初始化的独立诊断导出入口；网络不可用时 SHALL 能保存本地不可变包，后续上传仍需相同授权。诊断查看 SHALL 不调用 invoke、stream 或 resume。本能力 SHALL 沿用现有安全状态与诊断业务记录，不新增专门日志、span 或指标，不将材料正文写入遥测。

#### Scenario: Main desktop cannot start
- **WHEN** 主调试桌面不可用但当前用户可读取本地材料
- **THEN** 独立入口可以列出授权 thread 并导出可读证据，无模型、MCP、Chrome 或原任务启动

#### Scenario: Diagnostic package is inspected remotely
- **WHEN** 有权运维查看已接收包的 run 和 checkpoint 时间线
- **THEN** 服务端仅展示材料与缺失说明，不连接包中服务、不执行脚本、不恢复图
