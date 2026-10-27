## 1. 固定验证输入与最小依赖

- [x] 1.1 按 design.md §8 实现 ServerConfig／VerifyConfig 校验：绝对测试目录、TLS、fixture 凭据引用、目标平台和安全报告位置；缺配置明确失败，不读用户真实数据根。（EXT-01、PKG-02）
- [x] 1.2 核验并直接锁定 `ws`，用公开 Upgrade／send callback／maxPayload API 完成最小双进程握手检查；依赖由 runtime 的 package.json／lock 管理，包内可加载。（WS-01、PKG-02）
- [x] 1.3 选择并锁定满足逐项读取、链接／特殊文件识别、流式字节上限与 ZIP 写入的最小依赖；补一个恶意归档行为检查，不使用 shell 解包。（SYNC-01、DIA-03、PKG-01）
- [x] 1.4 建立独立摘要黄金向量：Agent 两文件、Skill 二进制／空目录／NFC、UTF-16 排序、ZIP 摘要与包摘要区分；期望值不调用客户端实现计算。（PKG-01）

## 2. 可独立部署的外部 WS／HTTPS 对端

- [x] 2.1 实现 server.mjs 独立启动、HTTPS／WSS listener、配置的可信测试身份与 `/api/session`、有限 ready／关闭；验证本机和跨机均不关闭证书验证。（EXT-01、WS-02）
- [x] 2.2 实现固定标准 AgentCard、官方目录／版本／manifest／原始包和分页；提供至少两个正式版本及一个缺包场景，不挂载客户端数据目录。（EXT-02、SYNC-01、PKG-01）
- [x] 2.3 复用已有本地模型 fixture 与 MCP SDK，提供确定 JSON／工具／延迟／错误／登录要求及可核查页面副作用；模型仅使用测试接入，不依赖付费服务。（EXT-02、MCP-01、WS-05～07）
- [x] 2.4 实现服务自己的调用／结果 SQLite 账本：发送前意图、taskId 映射、原终态与摘要、幂等消费记录，持久提交后才 receipt；真实强退后恢复原消息身份。（EXT-03、WS-08～10）
- [x] 2.5 实现自定义 WSS caller 的有限分帧／RPC 关联和 SDK 对象转换；保留标准 HTTP/SSE 独立用例，不让 ClientFactory HTTP transport 直接代替 WSS。（WS-01、WS-03、WS-05）
- [x] 2.6 实现独立 loopback／IPC 控制面、运行期控制凭据、固定故障枚举与自动复位；覆盖握手、断线、响应丢失、慢消费者、坏包、提交前后故障，无任意代码／路径入口。（EXT-04、WS-11）

## 3. 精确正式版本与现有装配衔接

- [x] 3.1 在 platform.ts 实现受控 HTTPS 请求、schemaVersion、安全错误与同一凭据快照的 `credentials()`；从同一头值核验 session 再 Upgrade，测试凭据轮换竞争。（RES-02、WS-02）
- [x] 3.2 实现 Agent／Skill 正式包读取、包外标签和 MCP 完整固定配置，沿用现有 packageContentId；legacy 本地配置与正式内容身份分开，不改历史 Run／会话。（ASM-01、PKG-01）
- [x] 3.3 实现精确版本 manifest、受限 origin 下载和暂存校验／原子提交，落实 1000 项／32 层及既有文件／包／装配大小限制；失败无半包，过期链接只重取相同版本。（SYNC-01、ASM-02）
- [x] 3.4 将正式版本和 AbortSignal 接入 resources.prepareSession 公开入口及全部本地／实验／远端调用方，复用只读完整 Skill 快照；缺包／工具／MCP／快照失败在模型与页面操作前终止。（ASM-01～02、RES-03）
- [x] 3.5 在 reserveRun 准入时排入现有 Provider pin 队列、保存受控解析结果；缺默认／凭据失败走该 Run 准备失败，长下载后更改默认不影响已受理任务，远端不能覆盖模型或 Key。（PRV-01、PRV-03）
- [x] 3.6 实现格式版本 1 的运行指纹与组成清单，记录实际模型参数而非未应用的配置；fixture 实收请求字段与指纹核对，显示名／密钥轮换不变。（FP-01）
- [x] 3.7 提供显式历史组合选择并为新会话重新校验物料／模型／工具；不可用明确失败，不改标签、不重跑旧 Run。（FP-02）

## 4. 桌面 WSS 接入与有限生命周期

- [x] 4.1 按 design.md §7 实现 connectA2AWss 公共签名、构造校验、首次总预算、安全状态订阅与独立清理；始终 HTTPS／WSS，固定单主体与有效期。（WS-01～02）
- [x] 4.2 实现 Upgrade 双向版本／receipt 协商、项目／认证／总头预算、open 完成检查与逐卡片 binding 校验；提前数据、缺头／错版不进入任务。（WS-01、WS-03）
- [x] 4.3 实现原 JSON 预检、活跃 id 区分与限额、规范 owner／可信 context／waitSignal，标准请求交 SDK handler，仅 receipt 单独分发；batch／notifications／二进制／peer 响应拒绝。（WS-02～03）
- [x] 4.4 实现并行短请求与有界流消费／发送器，完整 Task 可发送、超限分页明确失败；非终态 generator 结束返回安全错误，不新增结束／退订业务帧。（WS-05、WS-11）
- [x] 4.5 实现 Ping/Pong、单尝试退避、连接 generation 隔离、到期封闭与等待超时；先 abort 再回收 pending next，断线／停止消费不取消 Task。（WS-07～08、WS-11）
- [x] 4.6 在 main.ts 组装 platform、既有 A2AService、endpoint resolver 和 WSS；本地 ready 不等网络，未配置不伪造身份；A2A 存储恢复完成才开放远端。（WS-01、WS-09、UI-01）
- [x] 4.7 将新增 owner 接入单一 10 秒退出 deadline，adapter 最多 3 秒，前项失败仍清理后项；普通断线不 close service，stdout 继续只输出合法 IPC。（WS-12）
- [x] 4.8 经外部对端覆盖持久去重／busy、取消排空、两端重启、receipt 丢失／错摘要、旧回调和背压；记录唯一 Run、模型请求与页面副作用次数，修复实际失败。（WS-04～12、EXT-03～04）

## 5. 资源编辑、草稿与原子联动发布

- [x] 5.1 补当前 Markdown 工作区上传入口，复用现有真实文件 interface／adapter；验证文本／二进制／空目录、同名替换／跳过、失效目录、保存失败保留编辑和重开。（RES-01）
- [x] 5.2 实现受权官方工作副本／历史版本选择，后端拒绝正式内容写入；复制本地保持独立，普通用户不能靠路由／直接请求越权。（RES-02、UI-02）
- [x] 5.3 在验证服务和 platform client 实现创建官方身份、完整草稿上传／查询、不可变修订、expectedRevision 和内容绑定幂等键；上传期间编辑不改本次修订。（REL-01、EXT-02）
- [x] 5.4 实现发布预览、Skill＋全部受影响 Agent 原子索引提交、标签／基线冲突和提交后丢回执；首次 Agent 发布用 null 基线，已有版本精确 CAS。（REL-02、EXT-04）
- [x] 5.5 接入自有资源 interface 与运维页面，明确保存／上传／发布状态、人工标签、冲突和原键重试；不加审批或强制实验门槛，旧会话继续固定快照。（REL-01～02、RES-03、ASM-01）

## 6. 基础状态与运维界面

- [x] 6.1 扩展自有 DesktopRuntime 与 Tauri adapter 的安全状态 DTO，把连接、执行、交付三种状态投影到页面；共享页面不直接网络／Tauri／存储调用。（UI-01、UI-03）
- [x] 6.2 收敛 user 构建为连接／维护主入口，operations 按真实权限开放调试；远端 thread 只读，本地调试可继续；桌面初始化失败显示重试，不切 demo。（UI-01～03）
- [x] 6.3 回归切页／折叠／会话切换不停止任务、不聚焦 Chrome，明确待确认结果、窄屏、亮暗主题和键盘操作；保留已有导航与工作区行为。（UI-03、NATIVE-02）
- [x] 6.4 回归现有 Provider 配置／系统凭据、15 秒手动测试和地址前缀，测试无历史／工具／Chrome；当前配置改变后旧测试结果不复用。（PRV-01～02）

## 7. 一致诊断导出与持久上传

- [x] 7.1 在既有 runtime 增加 thread 导出租约及公开 exportThreadDiagnostics，所有新轮次／导航／准备共享互斥；拒绝活跃 thread，排空其写入并冻结截止点，其他 thread 继续。（DIA-01）
- [x] 7.2 实现按 run／graphThreadId／全部 namespace 的逻辑 checkpoint、父链／增量依赖／pending writes 导出及 JSON 记录副本；不复制整库／WAL／SHM，不误收其他 thread。（DIA-01、NATIVE-01）
- [x] 7.3 实现版本化 manifest、脱敏、附件选择、缺失／损坏记录和不可变 ZIP 摘要；取消清理本次暂存，不修改原件、不补拍／重跑。（DIA-02）
- [x] 7.4 宿主用标准 OS 文件锁覆盖正常／独立诊断模式；实现只读离线列表与导出公开入口，主桌面失败仍可用，不初始化 runtime／模型／MCP／Chrome。（DIA-04）
- [x] 7.5 验证服务实现 diagnostics limits、单 ZIP PUT、202／查询、归属／摘要／容量校验、包与索引持久提交、幂等回执和只读附件检索。（DIA-03、EXT-02～04）
- [x] 7.6 接入诊断自有 interface／adapter、材料预览／接收方／账号／知情确认及上传恢复；核对 uploadId、threadId、bundleSha256，失败保留包，同包重试同 ID。（DIA-02～04）

## 8. 原生签名更新与安装互斥

- [x] 8.1 锁定并接入标准 Tauri updater 能力，宿主只实现系统操作；验证服务分发已签名整包／原生 latest.json，不持有更新签名私钥。（UPD-01、EXT-02、PKG-02）
- [x] 8.2 接入自有维护 interface／adapter，启动 ready 后只检查一次、用户主动下载、验签后待安装；更高 SemVer／平台架构严格，不静默轮询或自动安装。（UPD-01～02）
- [x] 8.3 实现 runtime.beginMaintenance 和本地／实验／远端／导航共用的同步准入闸门；有任务等待后需再次确认，安装先进入则新任务拒绝，失败释放闸门。（UPD-03、WS-04）
- [x] 8.4 按同一退出预算清理后交安装器，重启核对版本和既有数据；错误签名／下载／安装准备失败不退出或伪造升级成功。（UPD-02～03、NATIVE-03）

## 9. 一次执行入口与分层证据

- [ ] 9.1 实现 verify.mjs 的 contract／full、独立服务启动／连接、逐用例隔离、所有可继续失败的汇总和有界 finally 清理；45 个场景下的正反子例逐个报告，不因一次成功覆盖整组。（全部场景）
- [x] 9.2 接入已有 runtime typecheck／test、web typecheck／lint／test／两 edition build、脚本检查与独立 A2A 用例；使用 fixture，不把文档或 Node 单测当浏览器测试。（MCP-01、PRV-01～03、PKG-01～02）
- [x] 9.3 执行 runtime test:browser 与 web HTML 浏览器清单，等待明确终态、捕获 pageerror／超时，分别测 user／operations／生产构建；已有用户未提交测试先保持归属并核对适用构建。（UI-01～03、NATIVE-02）
- [x] 9.4 黑盒用正常 main.ts／包内 Node 运行 WSS→空缓存物料→真实模型 fixture／MCP→受管理 Chrome→SQLite→终态→持久 ACK，不经测试 IPC 代交业务输入输出。（WS-01～12、EXT-01～04、SYNC-01）
- [x] 9.5 实现 JSON＋Markdown 报告及 full 双平台 merge：绑定源码／dirty 摘要、候选版本、各平台包 SHA、fixture、命令／时间／证据；passed／failed／not-run 及 0／1／2 退出语义严格，缺项不全过。（全部场景）
- [x] 9.6 回归未初始化遥测、遥测故障和 stderr／网络背压下业务结果不变；敏感哨兵不进入 IPC 错误、Task 摘要、普通报告或日志，不增加新埋点。（WS-12、DIA-02）

## 10. 候选交付与最终验收

2026-10-27 范围调整：用户明确要求本轮暂不验证 Windows。10.3 暂缓，依赖 Windows 的 10.4 双平台完整合并也顺延；两项保留未勾选，不计为通过，不阻塞本轮 macOS 范围的交付。

- [x] 10.1 运行并记录 Node 后端及前端规定检查、受影响脚本／浏览器检查；Rust 变更运行 fmt／check／clippy／test，Rust 依赖变更加 deny；若触及 Collector 再加其 doc／runtime 检查，失败不绕过。（PKG-02）
- [ ] 10.2 在 macOS ARM64 已安装候选包执行 full，验证系统凭据、SQLite native addon／重开、真实 Tauri IPC、Chrome／手动 CEF、签名旧版→新版和数据保留。（NATIVE-01～03）
- [ ] 10.3 在 Windows x64 已安装候选包执行同一 full；缺主机／签名／安装环境标 not-run，PE／ABI 静态检查不能替代实机。（NATIVE-01～03）
- [ ] 10.4 合并同候选源码与 fixture 的两平台完整报告；逐项复核所有失败／缺失及外部平台真实身份边界，只有必需场景和两个平台全过才给完整验收结论。（全部场景）
- [ ] 10.5 在有真实平台会话／网关／物料 origin 的环境复用握手、主体隔离和标准任务用例，明确区分 fixture 兼容与生产集成；完成实际 WSS 后关联旧 change 的 4.1／4.2，不提前勾选。（WS-01～03、EXT-01）
