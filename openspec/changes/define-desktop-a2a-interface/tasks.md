## 1. 接口讨论与实施前置条件

- [x] 1.1 确认本轮聚焦 A2AService与 runtime 边界，WSS 实现接口另行确定。
- [x] 1.2 确认首版沿用 Task/Run 持久记录和安全错误边界，不新增日志、span 或指标。
- [x] 1.3 记录用户已确认的 runtime 业务源码统一 TypeScript 决定，本轮不实施迁移。
- [x] 1.4 确认 RemoteRunRequest／ExecutionOutcome 数据边界、A2AService 与 runtime 的职责，以及共享预留的 execute/requestStop/release 接口和正常受理／结算顺序。
- [x] 1.5 确认本轮不绑定具体业务 Agent，input/output 保持 JSON；统一模块名称为 A2AService，Task 管理属于其内部职责。
- [x] 1.6 模块验证固定受控调用主体、授权隔离和有限额度；生产平台身份／有效期／重投政策移入后续 WSS 接入评审，不阻塞独立验收。
- [x] 1.7 用户明确要求按当前提案实施 A2AService，批准本阶段公开操作、故障处置和关闭；生产 WSS 参数除外。
- [x] 1.8 按当前提案实施单 JSON Data Part、固定官方 contentId、受控错误分类；未绑定具体业务 Agent。
- [x] 1.9 已取得明确实施指令；当前按模块／真实 runtime／外部标准 A2A 验证推进，不接 WSS。
- [x] 1.10 确认采用官方 @a2a-js/sdk、先不 fork；只读核验 1.3.0 发布包及发布提交，记录 SDK 直接复用与项目取消／持久化适配分工；本轮不安装依赖。
- [x] 1.11 按用户要求重新审查 SDK 默认实现与开源 A2A + LangGraph；缩小自定义处理范围并记录一手源码依据，仍不实现。
- [x] 1.12 只读核验 DatabaseTaskStore(Transaction)、Kysely SQLite 连接／锁及 owner 规则；给出一张项目表与三个事务边界设计，明确尚未运行验证。

- [x] 1.13 用户确认采用 SDK Task 表＋一张项目扩展表，继续复用 SDK 存储，不实现。
- [x] 1.14 整理 contract.md 完整公开契约，并与 design/specs 对齐；保留新增行为的评审状态及外部接入参数。

- [x] 1.15 只读核验 SDK transport／版本扩展和 Node 26／ws 公共能力，形成 wss-contract.md 接入评审稿，覆盖可信主体、握手、背压、流结束及连接清理，不实现。

- [x] 1.16 按用户要求先模块后 WSS，整理外部标准 A2A／真实 runtime／SQLite 三层验收门槛，同步串讲与一张关键类图；不实施或宣称已通过。

## 2. 后续实现：A2AService 与共享执行边界

- [x] 2.1 将 runtime 业务源码迁移到严格检查的 TS，适配导入、测试、启动与打包／宿主入口；验证行为兼容，不引入新编译框架。
- [x] 2.2 锁定并复用官方 SDK 发布版的协议类型、序列化、错误与 JsonRpcTransportHandler，以 SDK A2ARequestHandler 对接 A2AService，核验 RFC 8785；复用 DefaultRequestHandler 的 8 个标准操作、SDK AgentExecutor／事件总线和队列；只对发送两方法及取消做差异适配。不 fork，不重复逐方法协议 facade，不新增产品 Express／gRPC 服务（标准 HTTP 验证宿主除外），持久化扩展按 2.4 先验收 SDK。
- [x] 2.3 复用现有 runtime 并发设置实现共享预留，接入本地、实验和远端；在 execution 真实边界暴露取消是否仍有效。
- [x] 2.4 复用 SDK DatabaseTaskStore(trx) 与 SDK 迁移，只新增一张项目表；通过三种短事务完成受理、Task+摘要封存和 receipt。Task 更新保持 ResultManager → 受控 TaskStore.save → 事务 → SDK save 的锁顺序，不在事务内调用根句柄／嵌套 ResultManager。确认本地路径、直接依赖、owner 规范化及迁移，不改 checkpoint、不手写 Task CRUD／分页。
- [x] 2.5 实现 RemoteRunRequest 数据入口、固定官方版本准备和通用 JSON 映射，复用 ExecutionOutcome；补齐已确认的受控错误分类，接入现有模型、MCP 与 Chrome，不预建具体业务 Agent。
- [x] 2.6 仅适配 SDK sendMessage／sendMessageStream／cancelTask：原子受理、独立后台结算及真实 requestStop；复用其他标准方法、ResultManager 与订阅，补共同授权／closing／安全错误边界。明确每条流一个 Task 快照、每 Task 最多 3 个后续任务事件及字节／活动流限制，不把默认无界队列当容量保证。
- [x] 2.7 实现不可变终态摘要与持久交付确认，验证重复确认、错摘要和确认落盘失败。
- [x] 2.8 完成模块及独立验收宿主的启动与关闭组装，验证资源排空、存储失败和总退出预算，不因订阅断开停止任务。桌面 main.ts 尚未创建 A2AService，其生产生命周期随后续 transport 接入。

- [x] 2.9 按完整契约校验构造参数、必填限额、可信 context 和目录归属；启动取消／失败清理自有资源，旧 schema／记录损坏不静默重建，close 仅由 Kysely 关闭自有连接，不关闭借入 runtime。

## 3. 后续独立验证：先交付可用作黑盒的 A2A 模块

- [x] 3.1 经 SDK 公开 transport／handler 入口，用小型 fake 覆盖重复消息、busy、停止时 WORKING、真实排空后 CANCELED、结果已固定／缺失运行归属、无人订阅仍落盘、断线／重启／持久失败及交付确认；不使用真实密钥。
- [x] 3.2 执行 runtime typecheck、test，受影响的浏览器／IPC 与脚本／打包／原生入口检查；验证 TS 迁移、现有本地行为及各类任务共用名额，手动 CEF 独立。
- [x] 3.3 按 contract.md 第 10 节提供临时 loopback 标准 HTTP/SSE 验证宿主，直接复用 SDK agentCardHandler／jsonRpcHandler、ClientFactory 及可信 contextBuilder；Express 仅为宿主可选 peer，不新增产品常驻服务或自写 HTTP/SSE；外部 Agent 在独立进程经 AgentCard 完成任务，不能引用 service/runtime 私有入口。
- [x] 3.4 验证同消息并发／跨入口冲突、重复先于额度、SDK Task 与项目行一起回滚、终态 Task+SHA 原子性、同态／迟到 Artifact／完整 Task 冻结、首次／重复／失败 receipt；覆盖未知提交和启动一致性检查，不使用真实图或模型。
- [x] 3.5 验证 Kysely 事务句柄与单连接锁顺序、规范 owner 隔离及 SQLITE_BUSY 安全失败；A2A 连接显式 timeout=0，不改 checkpoint；验证有事务在途时的关闭预算和平台打包。
- [x] 3.6 经公开 KyselyPlugin.transformResult 为 SDK Task 查询加定点结果校验，复用公开 TaskRow 与 Task.fromJSON，不变更 SDK SQL／分页；验证损坏 JSON、非法字段、投影缺列、count／迁移不误判，确保 SDK list 不跳坏行或输出原始错误；不能靠外层 catch 或全局 console 替换掩盖问题。

- [x] 3.7 经公开创建／handler／close 入口验证构造取消、限额归还、旧 handler 不能绕过 closing、发送内嵌 push 配置拒绝、JSON 输出超限安全终态、受理与关闭竞争、固定候选最多一次存储收尾，以及 Kysely 与借入 runtime 的清理归属。

- [x] 3.8 接入真实 runtime／LangGraph、通用 JSON 固定物料及本地确定性模型 fixture，验证端到端 Artifact、Run 结算、取消实际排空和共享容量；涉及浏览器时用受管理 Chrome 和本地站点，不依赖付费模型或特定业务 Agent。
- [x] 3.9 由独立外部 SDK client 覆盖阻塞／受理返回／流、Get/List/Subscribe、取消、原消息重投、主体隔离、安全错误、持久回执；关闭／重启真实验收进程验证终态不变、未完成 interrupted-unknown 且不重跑。可选能力的 Server 拒绝须让请求实际到达 Server，不将 client 本地拦截当验收。
- [x] 3.10 汇总模块 fake、真实 runtime 集成、外部 HTTP/SSE 互操作三层证据及平台限制；按 verification.md 的实际通过范围交付模块，WSS 接入复用同组任务回归。

## 4. 后续 WSS 接入（暂缓，不阻塞第 3 阶段）

- [ ] 4.1 模块独立验收后再评审 wss-contract.md，确认单主体会话／网关委托、有效期、真实 binding 校验与传输限额，核定是否采用 ws；在桌面入口组装 A2AService，并按同一 deadline 依次关闭 adapter、A2AService 与 runtime；不把 WSS 字段或 URN 写入 A2AService 核心接口。
- [ ] 4.2 经公开 WSS／SDK 接入覆盖缺头／错版／缺扩展、伪造主体／错误安装、升级未 open、重复活跃 id、输入洪峰、共享发送队列满／callback 失败、非终态 done、pending next 断线、流超时不停止 Task、重连旧回调及总预算关闭；不新增业务心跳／退订／结束 RPC。

本轮已获准实施并完成 A2AService／runtime 与独立标准 A2A 验证。最终命令、实际结果与限制见 verification.md；WSS 两项保持未完成，不将其计为本轮交付。
