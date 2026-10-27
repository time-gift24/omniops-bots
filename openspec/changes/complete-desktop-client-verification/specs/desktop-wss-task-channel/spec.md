## ADDED Requirements

### Requirement: Desktop entry composes the existing A2A service
客户端 SHALL 在真实桌面 Node 入口组装现有 `createA2AService`、既有 runtime、精确官方版本解析和 WSS adapter。adapter SHALL 仅使用 A2AService 的公开 `protocolFor`、`confirmTaskDelivery` 边界，不自行创建 Task、维护去重表、执行 Agent 或写入业务终态。桌面 SHALL 主动连接配置的 `/api/clients/connect`；网络连接方向不改变桌面为 A2A Server 的业务角色。

#### Scenario: Remote request reaches the real desktop execution path
- **WHEN** 独立对端经已就绪 WSS 调用确定官方版本的 Agent
- **THEN** 请求经桌面入口、SDK handler 和 A2AService 到达既有共享运行准入及实际 runtime，而不是测试 HTTP 宿主或 demo adapter

#### Scenario: Invalid or unavailable exact version is not substituted
- **WHEN** 指定 Agent 版本不存在、未授权或完整包校验失败
- **THEN** 客户端明确拒绝或将已受理 Task 保存为安全失败，不替换为本地私有 Agent、最新版本或缺少能力的装配

### Requirement: Trusted session identity is bound to one connection
客户端 SHALL 在连接前通过可信 session 核验 `{organizationId, callerId, installationId}` 及有效期，使用配置中的受信网关和既有认证来源；网关 SHALL 在 Upgrade 核验同一主体及安装并承诺仅转发该主体的调用。一条连接 SHALL 固定一个主体，多个授权 tenant 可以共享连接；每次操作仍经 A2AService 授权。`tenant`、Task 正文和 metadata SHALL NOT 赋予身份或权限。非 loopback 接入 SHALL 使用证书验证有效的 WSS；凭据 SHALL NOT 放入 URL、Task、Artifact、状态或遥测。

#### Scenario: Forged body identity cannot cross authorization boundaries
- **WHEN** 连接主体在 RPC 正文或 metadata 中声明另一个用户、组织或安装
- **THEN** 请求仍按连接固定主体授权，越权入口和 Task 不可读取或执行

#### Scenario: Session expiry seals the connection without rerunning tasks
- **WHEN** 会话到期、可信会话层报告撤销或客户端切换主体
- **THEN** 旧连接封闭并清理等待；新连接重新认证，已有 Task 按原执行生命周期结算，不自动取消或重跑

#### Scenario: Invalid credentials fail before a usable connection
- **WHEN** 凭据未通过核验、安装不匹配或缺少可信有效期
- **THEN** 客户端不进入 connected，也不以正文身份或匿名上下文替代认证

### Requirement: WSS handshake explicitly negotiates the binding
连接 SHALL 使用 `urn:omniops:a2a:binding:wss-jsonrpc:v1`，在 Upgrade 请求和 `101` 响应中共同确认 `A2A-Version: 1.0` 及必需扩展 `urn:omniops:a2a:extension:delivery-receipt:v1`。项目协商头总量 SHALL 不超过 8 KiB，Authorization 值 SHALL 不超过 8 KiB，HTTP 握手头总量 SHALL 不超过 16 KiB；版本单值头冲突、非法 ASCII、缺失确认或未提出的扩展 SHALL 被拒绝。只有标准 WebSocket open 和项目头检查均成功后 SHALL 处理 RPC；每个确定版本的 AgentCard SHALL 声明相同 binding、版本和 tenant，并通过 SDK 公开版本检查。

#### Scenario: Missing version or required extension blocks execution
- **WHEN** 对端返回 `101` 但缺少版本、版本不为 `1.0` 或未确认 required receipt 扩展
- **THEN** adapter 终止连接，不处理提前到达的业务消息，不静默降级协议

#### Scenario: Upgrade event alone is insufficient
- **WHEN** 收到 Upgrade 响应但 WebSocket 标准握手尚未成功
- **THEN** 客户端不进入 connected，不创建无界预就绪消息队列

#### Scenario: A card cannot silently use another transport binding
- **WHEN** tenant 对应卡片仅支持 HTTP JSONRPC 或另一版本
- **THEN** adapter 返回安全兼容性错误，不将自定义 WSS 冒充标准 HTTP binding

### Requirement: Standard JSON-RPC dispatch is bounded and isolated
每个完整文本消息 SHALL 承载一个 JSON-RPC 2.0 请求对象；标准方法及 ProtoJSON 转换 SHALL 复用 SDK `JsonRpcTransportHandler`，只有 `omniops/ConfirmTaskDelivery` 走公开项目扩展入口。系统 SHALL 拒绝 batch、二进制业务消息、notifications、peer result/error 对象和缺失／null 请求 id。同连接活跃 id SHALL 唯一，安全整数和字符串 id 不混同；每请求 SHALL 有独立可信 `ServerCallContext` 与等待 signal。参数原类型、大小和深度 SHALL 在 SDK 默认化之前校验。未知方法 SHALL 返回 SDK 标准不支持错误，不扩充私有任务消息体系。

#### Scenario: Concurrent stream does not block cancellation or querying
- **WHEN** 一个发送流尚未结束，对端以不同 id 发起 GetTask 和 CancelTask
- **THEN** 短请求可并发进入授权和标准分发，不等待前一条流完整结束

#### Scenario: Malformed input creates no task
- **WHEN** 对端发送非法 JSON、batch、二进制、无 id 请求或超深参数
- **THEN** 客户端返回适用的安全协议错误或关闭非法连接，不创建 Task 或执行资源，不回显原始报文

#### Scenario: Duplicate active id cannot produce ambiguous responses
- **WHEN** 同连接再次提交仍活跃的 RPC id
- **THEN** adapter 按连接协议错误封闭连接并清理等待，不发出两条无法区分的调用响应

### Requirement: A2A task semantics remain stable across the WSS binding
WSS SHALL 沿用现有 A2AService 的标准任务契约：`messageId` 为持久幂等身份，RPC id 仅关联往返；先去重再准入；同消息同内容取得原 Task，同 ID 不同内容报冲突；busy 保存可查询 REJECTED 且不创建执行资源。SendMessage 默认 SHALL 等待终态，调用方显式设置 `returnImmediately=true` 才先取得受理 Task。每条已受理 Task SHALL 使用独立 thread、run、graphThreadId 和浏览器目标，Task 流只含任务级状态与最终 Artifact，不含模型 token、完整工具过程或 checkpoint。

#### Scenario: Lost acceptance response does not create another execution
- **WHEN** 首次受理响应丢失，对端以新 RPC id 重投相同 messageId 和不可变输入
- **THEN** 返回同一 Task，仅存在一次执行，容量已满也不改变该去重结果

#### Scenario: Rejected message stays rejected when replayed
- **WHEN** busy 消息已保存为 REJECTED，容量恢复后再次重投该 messageId
- **THEN** 返回原拒绝 Task，不新建 run、thread 或 Chrome 页面

#### Scenario: Falsy JSON results survive wire and persistence
- **WHEN** 实际运行输出 `0`、`false` 或 `null`
- **THEN** 线上原始标准报文、持久 Task、重连 GetTask 和摘要投影保留同一 JSON 值；SDK typed client 的已知 null 限制单独记录，不伪装修复上游

### Requirement: Flow completion and cancellation follow persisted task state
流 SHALL 以首个 Task 快照开始，后续仅为声明支持的 artifactUpdate／statusUpdate。终态快照、终态状态或同 id 安全错误 SHALL 结束对应 RPC，不关闭共享连接、不新增 done 信封。迭代器在非终态无故结束 SHALL 是传输失败，不能冒充 Task 完成。CancelTask SHALL 只请求既有执行停止；排空期间仍为 WORKING，真实排空并保存终态后才 CANCELED；结果已固定或终态 SHALL 返回 TaskNotCancelable。

#### Scenario: Cancellation waits for real drain
- **WHEN** 实际模型或浏览器操作已启动，CancelTask 请求生效但尚未排空
- **THEN** Task 保持 WORKING 并占用容量；排空且取消终态持久提交后才发布 CANCELED 并释放容量

#### Scenario: Fixed result cannot be overwritten by a late cancellation
- **WHEN** 执行结果已固定或 Task 已终态后收到 CancelTask
- **THEN** 返回标准不可取消错误，GetTask 保持原结果

#### Scenario: Unexpected stream end remains distinguishable from task completion
- **WHEN** SDK generator 在非终态快照后结束且未提供终态或错误
- **THEN** adapter 在可写时发送同 id 的安全结束错误，否则关闭连接；不改写持久 Task

#### Scenario: Stopping local consumption does not send a remote unsubscribe
- **WHEN** 调用方停止本地消费一条 WSS 流但保持共享连接
- **THEN** 不发送不存在的远端 unsubscribe 请求，也不挪用 CancelTask；桌面等待由既有 120 秒 RPC 期限或整条连接关闭回收，Task 执行不受影响

### Requirement: Transport and service resource budgets are finite
首版 SHALL 固定 A2A 请求 256 KiB、Task 1 MiB、JSON 深度 32、等待者 64、订阅 16；WSS 单消息 2 MiB、活跃请求 32、流 16、发送队列含在途项最多 32 条及 8 MiB。首个连接尝试总预算 SHALL 为 10 秒，单 RPC 等待为 120 秒，心跳间隔为 20 秒、pong 等待为 10 秒，重连退避范围为 0.5–30 秒。构造 SHALL 校验正安全整数、流槽位少于请求槽位及完整 Task 连 RPC 封套可发送。每连接 SHALL 使用有界发送器及公开 send callback／bufferedAmount，不逐消息创建无界任务；发送完成 SHALL NOT 等价于交付。

#### Scenario: Outbound backpressure does not hold execution capacity
- **WHEN** 对端停止读取导致发送预算耗尽
- **THEN** adapter 停止消费并有界关闭连接，Task 仍独立落盘结算及释放容量；不得无限排队或截断成功 JSON

#### Scenario: Oversized list does not corrupt persisted tasks
- **WHEN** ListTasks 完整响应超过单消息预算
- **THEN** 返回安全资源错误，允许调用方缩小分页或投影，持久 Task 保持完整

#### Scenario: Waiting timeout does not become execution timeout
- **WHEN** RPC 等待达到 120 秒但已受理 Task 仍在运行
- **THEN** 只取消该 RPC 等待与消费，不将 Task 改为 timed-out，不触发模型重试

### Requirement: Reconnection recovers queries rather than executions
网络断开 SHALL 仅清理该连接等待、定时器、监听、发送项及迭代器，不能调用 run 停止或关闭借入服务。重连 SHALL 重新鉴权；未知 taskId 使用原 messageId 重投，已知非终态订阅当前快照，终态查询原结果，不回放历史事件。进程重启 SHALL 沿用现有 A2A 恢复：已终态不变，遗留未完成在开放查询前持久转为 FAILED／`interrupted-unknown`，不 invoke、stream 或 resume checkpoint。

#### Scenario: Network loss leaves task execution alive
- **WHEN** WSS 在模型或 Chrome 操作期间断开而客户端进程仍在
- **THEN** 该 Task 继续按原 run 结算，重连取得同一 Task 当前状态或终态，不创建第二次执行

#### Scenario: Client restart preserves terminal results
- **WHEN** 客户端已有持久终态后强退并重启
- **THEN** 对端可查询相同 Artifact、状态时间及摘要，仅恢复交付，不重新装配或打开任务页面

#### Scenario: Interrupted run becomes unknown rather than silently replayed
- **WHEN** 客户端强退时 Task 为非终态
- **THEN** 重启后查询得到 FAILED／interrupted-unknown，明确外部操作可能发生，模型和浏览器操作不自动重跑

### Requirement: Delivery confirmation follows durable result receipt
终态与 Artifact SHALL 在进入网络发送前持久保存并完成运行结算。外部对端 SHALL 对标准结果投影 `{id, contextId, status, artifacts}` 按 RFC 8785 计算 SHA-256，持久保存原结果及索引后才发送 `omniops/ConfirmTaskDelivery`。客户端 SHALL 经 A2AService 核验主体、tenant、taskId、resultSha256 和 receivedAt，持久提交确认后才响应成功。重复确认 SHALL 幂等；错误摘要、非终态或落盘失败 SHALL 不改原结果、不伪造已交付。

#### Scenario: Confirmation response loss is harmless
- **WHEN** 确认已提交但响应丢失，对端重发相同 Task 和摘要
- **THEN** 返回相同成功结果，不重新运行 Task，不重复推进外部结果消费

#### Scenario: Wrong digest cannot acknowledge another result
- **WHEN** 对端提交错误摘要或另一授权入口的 Task
- **THEN** 返回安全协议错误，原终态和未确认状态保持不变

### Requirement: Shutdown and status respect ownership and one deadline
adapter SHALL 公开安全状态快照，区分 connected、reconnecting、blocked、closing、closed，不暴露凭据、原始 URL 或错误来源链。连接断开和 close SHALL 先 abort 等待再回收 pending next／迭代器；旧连接晚回调不能写入新连接。adapter 关闭 SHALL 受 3 秒上限及应用剩余总预算共同限制；应用退出 SHALL 在同一个 10 秒 deadline 内依次尝试 adapter、A2AService、runtime 和存储清理，前项失败仍尝试后项，不能重置预算。adapter SHALL 不关闭借入的 service/runtime。观测 SHALL 复用已有安全状态、Task／Run／receipt，不新增日志、span 或指标。

#### Scenario: Pending stream is reclaimed within shutdown budget
- **WHEN** adapter close 时 SDK generator 正等待 next 且 socket 不可写
- **THEN** 先取消等待、再清理迭代器和连接，预算耗尽明确失败，不无限等待也不伪造已清理

#### Scenario: Late old connection callback cannot corrupt the replacement
- **WHEN** 已重连成功后旧连接 send callback 或异步授权返回
- **THEN** 回调仅清理旧代资源，不发送到新连接、不修改新主体或状态

#### Scenario: Cleanup failure does not skip later owners
- **WHEN** adapter 清理失败或预算已耗尽
- **THEN** 应用仍以同一 deadline 尝试 service、runtime 和存储关闭，返回安全失败，不额外延长退出
