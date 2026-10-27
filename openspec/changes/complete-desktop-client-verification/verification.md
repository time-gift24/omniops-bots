# 客户端完整验收设计与追踪矩阵

2026-10-27 更新：本 change 已实施，实际结果与未完成门槛见 [实施与验证记录](./implementation-verification.md) 及 [任务清单](./tasks.md)。下段和“已有／TODO”表格保留为提案时的基线，不是当前实施状态。

本文件是实施后的验收契约。2026-10-26 本次只生成 OpenSpec 文档；`desktop/verification/server.mjs`、`verify.mjs` 及下列新增整链路用例尚未实现，不能执行，也没有产品全量验收结果。表中的“已有”表示可复用的代码或历史测试资产，不表示本次已运行、通过或覆盖完整需求。所有产品实施任务保持未完成。

## 1. 当前可核查的基线

| 边界 | 现有代码／证据 | 尚缺的验收闭环 |
| --- | --- | --- |
| 独立 A2A | `desktop/runtime/a2a/`；`tests/a2a*.test.mjs`；`tests/fixtures/a2a-{agent,harness}.mjs`；前一 change 的独立外部 Agent 记录 | 当前 `main.ts` 未组装 A2A／WSS；独立模块验证不是桌面远端调用验证 |
| Node 桌面入口 | `desktop/runtime/main.ts` 真实 JSONL IPC、Provider、资源、SQLite 与 Chrome；`runtime.ts` 已有 `reserveRun()` | 真实 WSS 身份、协商、网络背压、断线恢复和入口关闭组装 |
| 本地资源与装配 | `skill-library.ts`、`resources.ts`、`assembly.ts`、只读 Skill backend、会话完整快照 | 正式 Agent 两文件目录、网络版本解析、草稿／发布、运行指纹；本地配置 contentId 不能冒充正式包摘要 |
| 本地界面 | `web/src/adapters/tauri/`；`main.tsx` 初始化失败不回退 demo；`App.tsx` 和 Makefile 已有 user／operations edition | user 当前是执行记录＋官方 Skill 只读界面，还不是完整连接／维护入口；edition 不是授权边界 |
| Provider | `providers.ts`、`credentials.ts`、原生 `credentials.rs`；配置、默认值、可选 Key、手动测试已有用例 | 远端任务默认组合固定、拒绝远端覆盖、Windows 凭据实机门槛 |
| 真实浏览器 | `tests/{chrome-host,browser-concurrency,script-safety}.browser.mjs`；`local-client.browser.mjs` | WSS 正常入口触发的浏览器副作用与结果交付；真实 CEF／Tauri 宿主仍需原生门槛 |
| checkpoint | `execution/sqlite.ts`、`tests/sqlite.test.mjs`，包脚本已有原生 addon 校验 | 单 thread 一致导出、脱敏预览、独立导出入口、HTTPS 接收回执；Windows 实际加载 |
| 更新 | `desktop/scripts/` 已有两平台整包构建和交付路径 | updater 接口、签名更新站点、用户确认、任务互斥、旧版安装升级实机验证 |

历史截图、阅读页／图形检查和 [既有文档验收记录](../../../docs/requirements-walkthrough/evidence/验收记录.md) 只证明其声明的时间和范围；不能移用旧测试计数作为本候选版本结果。`web/tests/support.tsx` 默认使用 demo adapters；对应页面通过不证明外部服务接入。

## 2. 来源覆盖

| 需求来源 | 本文件场景 | 边界与判据 |
| --- | --- | --- |
| [README](../../../docs/requirements-walkthrough/README.md)、[00 总体架构](../../../docs/requirements-walkthrough/00-总体架构.md) | WS-01～12、UI-01～03、EXT-01～04、NATIVE-01～03 | Console 业务入口、客户端后台执行、运维调试和基础维护分工；不将线上任务变成本地聊天 |
| [前置 Agent 版本管理](../../../docs/requirements-walkthrough/前置-Agent版本管理.md) | SYNC-01、ASM-01～02、FP-01～02、PRV-03 | graph 随代码；业务 Prompt 在包外装配；内容 ID、指纹、run 身份分开；显式历史选择不重跑 |
| [核心 服务端部署与持久化](../../../docs/requirements-walkthrough/核心-服务端部署与持久化.md) | EXT-01、EXT-03～04、WS-08～10、SYNC-01、PKG-01 | 外部服务重启、持久交接、不可变物料；本仓不建设生产 API／worker／PostgreSQL／Redis／NFS 集群，不声称验证生产高可用 |
| [核心 WS 调用客户端](../../../docs/requirements-walkthrough/核心-服务端通过WS调用客户端.md) | WS-01～12、EXT-01～04 | 保留独立 A2A 门槛，再通过真实桌面入口接 WSS；标准操作与唯一持久回执扩展 |
| [核心 Skill 模板与迭代](../../../docs/requirements-walkthrough/核心-Skill模板与迭代.md) | RES-03、ASM-01～02、MCP-01、WS-05、PKG-01 | 验证完整包、按需读取、工具权限和实际结果；路由／平台模板不是 CDAS 业务实践。探索上传、定时汇总、业务测试集明确属于后续方向，不增加本期任务 |
| [01 Skill](../../../docs/requirements-walkthrough/01-SKILL.md) | RES-01～03、REL-01～02、SYNC-01、FP-02 | 文件上传、本地保存、草稿上传、正式发布为不同动作；保存失败保留编辑，完整包固定 |
| [02 MCP](../../../docs/requirements-walkthrough/02-MCP.md) | MCP-01、ASM-02、PRV-01、WS-06～07 | 真实 Streamable HTTP、能力白名单、取消／错误与清理；resource／prompt 不自动成为工具 |
| [03 builtinTool](../../../docs/requirements-walkthrough/03-buildintool.md) | ASM-02、WS-05、UPD-01～03、PKG-02 | 运行前与运行中白名单；缺失要求桌面更新，不从 Skill 下载实现 |
| [04 Agent](../../../docs/requirements-walkthrough/04-agent.md) | RES-02～03、REL-01～02、ASM-01～02、PRV-03、FP-01～02 | 私有与官方身份、正式 Prompt／配置、完整装配、新会话生效、旧会话固定 |
| [05 桌面更新](../../../docs/requirements-walkthrough/05-桌面端更新.md) | UPD-01～03、NATIVE-03、PKG-02 | 两平台签名整包、用户确认、空闲互斥、原数据保留 |
| [06 同步装配](../../../docs/requirements-walkthrough/06-同步与装配.md) | SYNC-01、ASM-01～02、REL-02、PKG-01 | 精确版本核对、原始字节、按需缺包、受控原子缓存、不降级 |
| [07 执行恢复](../../../docs/requirements-walkthrough/07-任务执行与恢复.md) | WS-04～12、UI-03、NATIVE-02、DIA-01 | 并发默认 4／1～64、按 thread 页面、唯一终态、取消排空、断线补交付、重启不续跑 |
| [08 前端现状与缺口](../../../docs/requirements-walkthrough/08-前端现状与缺口.md) | UI-01～03、RES-01～03、UPD-01～03、DIA-01～04 | 界面完成和业务接入分别判断；包含已存在但正文未及时反映的 edition 隔离 |
| [09 诊断](../../../docs/requirements-walkthrough/09-运维与诊断上传.md) | DIA-01～04、NATIVE-01、EXT-03～04 | 指定 thread 的一致逻辑导出、知情确认、幂等接收、独立只读入口 |
| [10 服务端 API](../../../docs/requirements-walkthrough/10-服务端API.md) | RES-02、REL-01～02、SYNC-01、WS-01～12、EXT-01～04、UPD-01～03、DIA-01～04 | 每一 API 分组都有真实对端刺激与失败断言；fixture 支持不等于生产服务已实现 |
| [11 Provider](../../../docs/requirements-walkthrough/11-Provider.md) | PRV-01～03、FP-01、NATIVE-01 | 本地配置、系统凭据、显式测试与默认值固定；无远端密钥／模型覆盖 |
| [Agent 版本布局](../../../docs/agent-version-layout.md)、[Skill 版本布局](../../../docs/skill-version-layout.md)、[Skill 加载](../../../docs/skill-storage-and-loading.md) | PKG-01、SYNC-01、ASM-01、RES-01、REL-01～02 | 同相对目录／原始字节，空目录与文件都入 Skill 摘要，正式 Agent 恰好两文件，包外元数据与本地资源迁移边界 |

## 3. 用例、刺激、断言和证据

证据层级：`unit` 为公开入口小型 fake 行为检查；`contract` 为独立外部对端与真实客户端进程；`browser` 为真实 Chrome／共享前端；`native` 为真实安装包与系统能力。表内 `已有／部分` 仅描述现有资产；每一个完整场景仍待本候选版本执行。一个编号可以包含列明的正反例，runner 必须逐个子例报告，不能以一次成功覆盖全部边界。

### 资源、版本、装配和模型

| ID | 刺激与可观察断言 | 证据／当前状态 |
| --- | --- | --- |
| RES-01 | 新建／上传文本与二进制、空目录、重名替换、目录切换与保存失败；磁盘原始字节正确，失败保留编辑，旧请求不覆盖新 scope，重开可读；保存／发送成功前不进侧栏 | unit＋browser＋contract；本地文件、失败和 stale response 已有资产，整场景待跑 |
| RES-02 | 普通用户／运维／过期身份请求官方读取和写入；只读原文不被本地草稿覆盖，本地复制不改官方；跨组织／设备访问拒绝；隐藏 UI 外直接请求也拒绝 | unit＋browser＋contract；本地只读／edition 部分已有，可信外部权限 TODO |
| RES-03 | 保存未发布完整 Skill 后选 Agent 实验，再编辑原包；实验按需读取当时固定的引用／脚本，模板和旧会话不变；未保存内容不误入实验，坏包阻止执行 | unit＋browser＋contract；本地实验／完整快照已有资产，正常入口场景待跑 |
| REL-01 | 上传期间继续编辑、回执丢失、重复同幂等键、同键异内容、expectedRevision 过期；提交的是冻结原字节，生成不可变修订；同键恢复同结果、异内容冲突；失败保留工作副本 | contract＋browser；网络草稿上传 TODO |
| REL-02 | Skill 发布预览后其他人修改关联 Agent，或标签冲突／中途提交故障；完整受影响 Agent 集合和所有新包可读后才发布成功；冲突／失败无部分可见标签；同幂等键恢复同发布 | contract＋browser；联动发布 TODO；验证服务为测试接收方，不实现生产发布平台 |
| SYNC-01 | 指定新旧精确 Agent 版本，分别缓存命中、缺一个 Skill、下载中断、过期链接、哈希错、来源错、恶意归档；只下缺包，保留原始字节，安全暂存后原子提交，无半包／旧版降级／全量镜像 | unit＋contract；本机缓存与摘要部分已有，HTTPS 精确版本流程 TODO |
| ASM-01 | 正式两文件 Agent＋多个完整 Skill＋固定 MCP 配置装配，开始后修改全局资源并重开旧会话；Prompt 在图外读取、只读包按需挂载、旧快照不变、新会话用新版本；本地旧摘要与正式包摘要有明确 schema 区分 | unit＋contract＋browser；本地完整装配已有，正式包接入／身份迁移 TODO |
| ASM-02 | 缺 builtinTool、缺包、错误挂载、Skill 篡改、MCP 能力变化、Provider 不可用；在模型／工具／业务副作用之前失败并给稳定错误，保持已有缓存；不静默换版本或下载工具实现 | unit＋contract；本地准备检查已有，远端正式流程 TODO |
| MCP-01 | 真实 fixture 服务发现工具／resource／prompt、执行选定工具、鉴权拒绝、断流、取消与关闭；仅选择工具可调用，resource／prompt 不自动变工具；错误安全，连接有界释放 | unit＋contract＋browser；MCP 本地用例已有，WSS 场景待跑 |
| PRV-01 | 两 Provider 多模型、有 Key／无 Key／引用丢失、系统凭据写入失败、配置损坏、旧配置迁移；地址保留路径前缀、凭据不回显；保存失败保留原配置；有引用但取不到不发送无鉴权请求；不自动切换 | unit＋browser＋native；本地首版已有，Windows 实机及新整链路待跑 |
| PRV-02 | 显式测试已保存模型，修改配置、15 秒超时、取消、上游拒绝／断流；固定最小请求且无历史／工具／浏览器；保存／打开不自动测试；旧结果不证明新配置通过；不重发 | unit＋browser＋contract；现有手动测试资产可复用，待跑 |
| PRV-03 | 远端任务受理后改变默认值，正文尝试传 Provider／model／Key；任务固定本机默认组合，远端覆盖拒绝；缺默认值在准备失败；本地新会话可在开始前改选，开始后不换 | unit＋contract＋browser；本地固定部分已有，远端解析 TODO |
| FP-01 | 同组合更换对象键／Skill 顺序、改展示名／轮换 Key，再分别改变 Agent、Skill、挂载、模型与有效参数；同组合同指纹，配置变化异指纹，保存格式版本与可解释清单；有效参数逐项匹配模型 fixture 实收请求字段，未生效参数不得仅参与哈希；不把秘密／输入／runId／graph 代码混入 | unit＋contract；运行指纹 TODO |
| FP-02 | 显式选择历史组合创建新任务，分别缺旧物料／模型／兼容工具；可用时得到原组成指纹，不可用时失败；不改历史标签或旧会话，不自动重跑失败 run、不回滚业务操作 | unit＋contract＋browser；历史组合与指纹关联 TODO；不要求构建业务评估平台 |

### WSS 和外部验证对端

| ID | 刺激与可观察断言 | 证据／当前状态 |
| --- | --- | --- |
| WS-01 | 正常 `main.ts`／安装包主动连接独立 WSS，校验 Upgrade、绑定协议版本和 Agent Card；自定义 WSS transport 负责成帧与请求 ID 关联，复用 SDK 对象／标准错误，经现有 A2AService、精确版本准备、reserveRun 到真实 LangGraph；输出与页面效果匹配；标准 ClientFactory 的 HTTP 独立基线另跑，不能冒充 SDK 内置 WSS 支持 | contract＋native；A2A 核心已有，入口 WSS TODO |
| WS-02 | 正确／无效／过期 token、伪造正文 principal／tenant／device、跨身份任务、Token 到期；身份仅取可信 session，权限失败不执行、不泄漏存在性，续期不扩大原任务归属 | unit＋contract；A2A 归属已有部分，生产身份 adapter／WSS TODO |
| WS-03 | 畸形 JSON、batch、notification、非法 ID／参数／深度、活动 ID 复用、不支持操作；标准 JSON-RPC 安全错误，关联正确，未准入输入不产生 task／模型调用 | unit＋contract；A2A 原始边界部分已有，WSS 边界 TODO |
| WS-04 | 同 messageId 同输入并发重投／重启后重投、异输入重用；不同 thread 并发至容量，同 thread／手动导航冲突；默认 4，设置 1～64 下调；同请求只启动一次，冲突／忙明确返回、不排队，下调不取消已有任务 | unit＋contract＋browser；持久去重／准入已有资产，WSS 集成待做 |
| WS-05 | SendMessage 默认等待／显式立即返回、流订阅／停止本地消费／恢复查询，输出 `0`、`false`、`null`、对象和无效 JSON；终态／artifact 正确、不套额外业务封套；调用方停止本地消费不发送 unsubscribe 帧、不取消 Task，远端订阅仅在终态、超时或连接清理时释放，Task 仍按原生命周期执行；人工登录需求明确失败不自动等候续跑 | unit＋contract＋browser；A2A 与 JSON 图部分已有，远端正常入口待跑 |
| WS-06 | 准备／执行中取消、重复取消、取消与正常终态竞争、工具延迟排空；每 run 唯一终态，返回实际停止结果，排空前不释放容量；不影响其他 thread、不自动回滚或重试 | unit＋contract＋browser；execution／A2A 部分已有，WSS race 待跑 |
| WS-07 | 模型停滞、MCP 不返回、脚本超时与截止时间交错；run 总预算含准备，实际停止／清理有界；保留未知副作用，失败／超时不重发模型或工具 | unit＋contract＋browser；本地超时部分已有，全入口预算待跑 |
| WS-08 | 运行中断网、外部网关重启、任务离线完成、网络恢复；本地任务继续，连接恢复只查询／订阅与补交原结果；外部页副作用和模型调用次数不增加 | contract＋browser；网络绑定及恢复 TODO |
| WS-09 | 客户端分别在持久受理前、受理后、终态前、终态后强退并重开；仅恢复持久证据，未完成结果标未知／中断，已终态结果可查询／补交；任何分支不自动 invoke／resume | unit＋contract＋native；本地不重跑／A2A 存储已有资产，WSS 崩溃矩阵 TODO |
| WS-10 | 服务端已持久保存结果后 ACK 丢失，错身份／错 task／错摘要 ACK，重复 ACK；只接受匹配持久回执，交付只结算一次；两端重启仍能查询原结果及回执，不以 WS send 完成认定交付 | unit＋contract；A2A receipt 已有，WSS 双端持久交接 TODO |
| WS-11 | 超大／分片帧、慢消费者、发送队列满、活动请求／订阅超限、断开的请求总期限；所有字节／数量预算冻结且有界，超限明确拒绝或关闭，无无限缓存／每条重试；终态仍在本地可查且业务不被伪造成功 | unit＋contract；WSS 全预算与背压 TODO |
| WS-12 | 活跃任务期间退出、重复 close、服务未连上即关闭、关闭时流写入阻塞；停止准入后关闭订阅／任务／浏览器／存储／WSS，使用单一总截止时间；stdout 始终合法 IPC，退出不重跑、不误杀手动 CEF／用户 Chrome | unit＋contract＋native；原入口关闭已有，新增连接组装 TODO |
| EXT-01 | 在独立进程及另一主机启动验证服务，使用独立数据根、可信 TLS、session 身份与受控管理端；客户端无服务私有内存／IPC捷径；无管理授权不能注入故障，生产客户端不暴露测试控制入口 | contract；独立 A2A harness 可借鉴，外部 WS／HTTPS 服务 TODO |
| EXT-02 | HTTPS session、目录／版本／包、草稿／发布、updates、diagnostics 接口及模型／MCP／业务页面 fixture；各请求／响应遵守第 10 章，包括 schemaVersion 与二进制例外；fixture 有原始字节与摘要，缺接口不能假成功 | contract；模型／MCP／页面有现成资产，组合服务和物料／维护 API TODO |
| EXT-03 | 结果／发布／诊断持久提交前后强杀服务、丢回执、同幂等键重传；恢复后只返回已提交接收事实、同一身份／摘要同结果；暂存未提交不显示已接收，ledger 能核查执行与副作用次数 | contract；独立 A2A store 可复用思路，完整服务 ledger TODO |
| EXT-04 | 确定性注入掉线、延迟、重复调用、错摘要、过期身份、下载中断、慢读、坏归档、磁盘写失败；每故障都有预期安全类别及资源清理证据；控制端不让任务内容执行任意 shell／文件操作 | unit＋contract；测试配套 TODO |

### 界面、维护和平台交付

| ID | 刺激与可观察断言 | 证据／当前状态 |
| --- | --- | --- |
| UI-01 | user／operations 两个独立构建，真实正常／认证失败／重连状态；user 不要求调试桌面，operations 按权限开放；保存／发送前侧栏不出现新条目；桌面启动失败明确重试无 demo fallback | browser＋contract＋native；edition／启动用例已有，基础状态 TODO |
| UI-02 | 运维令牌失效、普通用户直接访问运维路由／API、双实例与不同缓存身份；写入被实际拒绝，编辑保留，私有／官方／不同身份数据不串；build flag 不成为授权依据 | unit＋browser＋contract；本地隔离部分已有，平台权限 TODO |
| UI-03 | 任务执行中切页／折叠／切换 thread、远端 thread 只读、离线完成待 ACK；后台继续、原页面固定、仅显式停止对应 run、执行终态与交付状态分别显示；窄屏、键盘和亮暗主题可操作 | browser＋contract＋native；本地生命周期已有，远端只读及交付呈现 TODO |
| UPD-01 | 启动就绪／手动检查、更高／同版／旧版／错平台清单、用户下载／未下载；启动只查一次不阻塞，版本和架构严格，下载显示真实进度，完成只待安装 | unit＋browser＋contract；更新 TODO |
| UPD-02 | 下载失败、TLS 错、签名错、摘要错、坏清单；不安装、不退出、不丢数据，无自动重试／降级；测试 CA 受控信任，不禁用校验 | unit＋contract＋native；更新 TODO |
| UPD-03 | 用户确认与本地／实验／远端新任务竞争、任务停止尚未排空；有任务不安装、结束后再确认；安装先准入则任务明确拒绝；共同预算关闭后安装，新版启动与原数据可用才成功 | unit＋contract＋native；原准入可复用，安装互斥 TODO |
| DIA-01 | 两个 thread、多 run／namespace／父链／pending writes；所选 thread 活跃、冻结期间新轮次、并行其他 thread；一致截止点包含完整依赖，只导出所选 thread，不复制全库、不影响其他 thread | unit＋contract＋native；SQLite／记录已有，导出 TODO |
| DIA-02 | 旧版无 checkpoint、SQLite 损坏、记录截断、磁盘满、缺截图、凭据藏在 metadata／正文／checkpoint；保留原件和可读材料、缺失清晰、脱敏不回写；预览接收方／身份／材料并知情确认，无自动补拍／修库／执行 | unit＋browser＋contract；诊断准备与预览 TODO |
| DIA-03 | limits、单 ZIP PUT、HTTP 202、最终回执丢失、同 ID 同／异摘要、越权、ZIP slip／符号链接／重复路径／展开炸弹；先查询再按需重传同包、同回执，提交后核对 uploadId、threadId、bundleSha256 才已接收；取消上传不改原 run | unit＋contract＋browser；上传及测试接收方 TODO |
| DIA-04 | 主调试桌面无法启动、网络不可用、重启后待上传包、服务端只读查看；独立入口只读导出、不初始化 Agent／模型／MCP／Chrome；同包有权再上传；查看不反序列化执行／resume | contract＋native；独立入口 TODO |
| NATIVE-01 | macOS ARM64 与 Windows x64 已安装包分别调用系统凭据、加载 SQLite addon、落盘并重开、强退后读取已提交 checkpoint；实际架构／ABI匹配，凭据引用失败无降级，未提交尾部不冒充已保存 | native；macOS 历史证据存在，Windows 实机待做；本候选两平台均需重验 |
| NATIVE-02 | 真实 Tauri IPC、外部 Google Chrome、独立 CEF `__manual__` 同时操作；普通启动／选择 thread 不启动或聚焦 Chrome，显式显示才聚焦；CEF 地址／历史／输入不受 Agent 锁或任务改变；退出只关闭所属资源 | native；本地 CDP／fake bridge 有用例，不能替代此门槛 |
| NATIVE-03 | 两平台真实安装旧版→有效签名新版，另测错误包、有任务竞争与重启失败；保留本机数据与可解释结果，未启动新版不能显示升级成功；不要求差分／静默／自动回滚 | native；真实 updater 验收 TODO |
| PKG-01 | 两端按相同版本目录保存相同字节；Agent 恰为 agent.json／prompt.md，Skill 含二进制／空目录／NFC 路径；按 UTF-16 路径／键序和原字节算摘要；非 NFC、大小写／重复冲突、越界／符号链接拒绝，标签／时间等包外元数据不影响摘要 | unit＋contract；Skill 摘要已有，正式 Agent 两文件与传输 TODO |
| PKG-02 | 两平台整包检查与运行；前端／Node／CEF／runtime／工具一起更新，外部 Chrome 独立；包无真实 Key／.npmrc／本地 profile，Node 26.11.1、对应架构 addon、签名和清单正确；跨编译静态检查不冒充目标实机运行 | unit＋native；prepare／构建资产已有，候选交付与更新验证待做 |

## 4. 外部验证服务与配置

实施后可在另一台机器启动服务，客户端始终主动连接。验证服务是隔离测试配套，不是生产 Console、身份系统或业务调度后端。它必须提供独立持久目录，按测试身份保存调用、结果、回执与诊断接收索引；发送 ACK 的前提是接收提交完成。受控故障 API 与正常 WSS／HTTPS 入口分开授权，默认不得暴露到非测试网络。

配置使用受校验的 JSON 文件；配置文件绝对路径通过 CLI 显式传入，字段及完整类型以 [design.md 第 8 节](design.md) 的 `ServerConfig`／`VerifyConfig` 为准。最少配置项及验收检查如下：

| 配置语义 | 必须验证的内容 |
| --- | --- |
| 服务监听与公开地址 | WSS／HTTPS 绝对地址、绑定主机、端口、证书与私钥路径；客户端实际使用的主机名匹配证书，不从任务输入取得服务端点 |
| TLS 信任 | 可使用显式测试 CA；证书错误应失败，不设置 `NODE_TLS_REJECT_UNAUTHORIZED=0` 或浏览器 ignoreHTTPSErrors |
| 身份与权限 | 通过凭据引用取得隔离 fixture token；组织／设备／角色／到期由可信 session 固定，原始 token 不进报告；测试固定 token 不能证明生产登录、续期和权限平台已集成 |
| fixture 集 | 确定的 Agent／Skill 原始包、版本摘要、模型 SSE、MCP、业务页面、更新签名公钥／产物、故障剧本；场景不调用付费模型或真实业务网站 |
| 存储与控制 | 服务独立 dataRoot、客户端独立本地根和 Chrome profile、控制端凭据引用、资源预算；路径归属校验，不使用用户真实应用根 |
| 目标与报告 | 当前平台、候选安装包路径／摘要、旧版隔离安装环境、源码身份、报告输出目录；full 不能将其他平台目标解释为已验证 |

用于更新 fixture 的测试签名私钥只在隔离测试环境读入，不进入客户端包或 Git；客户端仍只持有测试公钥。用于验证真实系统凭据的秘密是随机测试值，清理仅针对本次创建的凭据项。fixture 数据中的假 Key 可用于检测泄漏，不打印真实环境变量、请求头、提示词或回复正文作为报告。

本期不新增专门日志、span 或指标，沿用需求 README、第 09／11 章的决定。报告通过测试断言、现有安全状态、持久业务回执、次数和文件摘要留证；`stdout` 对正常客户端仍仅用于 IPC。未初始化遥测、遥测故障和输出背压下业务结果不变属于回归断言，不据此新建 Node 遥测门面。

## 5. 一次执行入口与阶段

**以下是待实现的命令契约；当前文件不存在。本次没有执行这些命令，也没有创建服务配置或测试私钥。** `node` 必须是仓库要求的 26.11.1；所有示例 `/absolute/...` 为实施时提供的真实绝对路径。

外部主机先提供可被客户端访问的测试服务：

```sh
node desktop/verification/server.mjs --config /absolute/service.json
```

每个目标平台只执行一次 full，runner 自动完成阶段并归档所有必需子例；服务可以是已启动的外部主机，也可按显式配置由 runner 启动独立子进程，不能偷偷降成进程内 fake：

```sh
node desktop/verification/verify.mjs --profile full --config /absolute/verify.json
```

`contract` 用于开发期只跑契约层；成功报告只能标记其声明的限定范围，不能给全产品或原生平台通过：

```sh
node desktop/verification/verify.mjs --profile contract --config /absolute/verify.json
```

收齐 macOS ARM64 与 Windows x64 的 full 报告后生成最终结论：

```sh
node desktop/verification/verify.mjs --merge /abs/macos-report.json /abs/windows-report.json --output /abs/summary
```

full 的阶段按依赖顺序进行；独立用例可以继续收集失败，前置失败的后继必须明确 not-run，不得硬跑出误导性成功：

1. **前置检查。** 锁定源码／dirty 清单、Node／Rust、依赖、平台、Chrome、原生包、旧版安装环境、测试身份、证书和 fixture 摘要；检查没有真实 Key、真实用户数据根或未授权的外部地址。缺任何必需项即记录并阻止平台全通过。
2. **现有检查。** 按改动范围运行下节命令，Node 与浏览器分开留证；独立 A2A 用例保留为一层证据。测试失败不修改标准、关闭警告或自动跳过。
3. **外部契约。** 服务与真实客户端入口分别独立运行，执行资源、发布、WSS／A2A、模型、MCP、Chrome 副作用、SQLite、终态与持久回执闭环；逐项注入恢复和失败场景，服务 ledger 独立核查调用及副作用次数。
4. **界面。** 通过 Vite 执行对应 `web/tests/*.browser.html`，每页隔离 context，监听 pageerror、等待明确 PASS／FAIL、设截止时间；user／operations 两构建及生产 CSS 分别检查。不要假定所有 HTML 都有相同 dataset 字段。
5. **已安装包。** 使用正常打包入口产生并安装目标平台候选包；重用包内 runtime 回归，再真实操作 Tauri／系统凭据／CEF／Chrome／SQLite／维护 UI；执行旧版到新版签名更新。包内 runtime 测试的 fake credential／bridge 不能替代此阶段。
6. **输出与清理。** 无论成功、失败或取消都先保存安全证据，再在共同截止时间内清理本次创建的资源；生成机器可读 JSON 和简短 Markdown，附未执行原因与复现命令。不可清理用户原有 Chrome、系统凭据或真实应用数据。

runner 推荐退出码统一为：`0` 表示本次声明范围全部必需项 passed；`1` 表示断言失败；`2` 表示配置／前置环境不合法、必需项 not-run 或报告不能合并。若同时出现失败和未执行，报告保留二者，退出非零。full 的单平台通过不能写成双平台通过。

## 6. 复用的现有检查命令

以下命令目前存在，但本次文档提案不运行产品检查，也不声明其结果。实施时按实际修改范围执行，full 报告记录实际命令、版本和结果，而不是复制本文文字。

```sh
npm --prefix desktop/runtime run typecheck
npm --prefix desktop/runtime test
npm --prefix desktop/runtime run test:browser
npm --prefix web run typecheck
npm --prefix web run lint
npm --prefix web test
npm --prefix web run build
node --test desktop/scripts/*.test.mjs
python3 -m unittest discover -s desktop/scripts -p 'test_*.py'
cargo fmt --all -- --check
cargo check --workspace --all-targets --all-features --locked
cargo clippy --workspace --all-targets --all-features --locked -- -D warnings
cargo test --workspace --lib --bins --all-features --locked
```

Collector 改动另跑 `cargo test -p omniops-bots-collector --doc --locked` 和 `cargo test -p omniops-bots-collector --test runtime --locked`；Rust 依赖改动另跑 `cargo deny check --disable-fetch`。打包及原生启动用 `make dev`、`make package-macos`、`make package-windows`；edition 用现有 `EDITION=user|operations` 选择。已有 `web/test` 只匹配 `.test.mjs`，不执行 HTML 或 `.browser.mjs`，所以浏览器阶段必须单列。

`desktop/runtime/tests/local-client.browser.mjs` 可通过 `OMNIOPS_BOTS_TEST_NODE_EXECUTABLE` 与 `OMNIOPS_BOTS_TEST_RUNTIME_DIRECTORY` 指向包内 Node 和 runtime；其模型、MCP、原生 bridge 与凭据处理各有明确 fixture 范围。`web/tests/production-chat-layout.browser.mjs` 是本次工作开始时已有的未跟踪文件，要求 operations 生产构建及 preview；不能覆盖用户改动，也不能以默认 user 构建或开发 CSS 替代。runner 纳入它时须显式登记候选输入身份。

## 7. 报告结论与最终门槛

每个最小子例只允许 `passed`、`failed`、`not-run`，禁止把能力缺失写为成功或静默 skip。报告必须包含 `schemaVersion`、profile、目标平台／架构、候选应用版本、源码 commit 与 dirty 文件身份、该平台包 SHA-256、Node 版本／ABI、fixture 集摘要、脱敏配置身份、用例／子例 ID、开始／结束、实际命令、预期／观测安全摘要、证据路径与摘要、失败／未执行原因。场景 fixture 有意返回错误，只在错误分类、副作用、清理等断言都符合预期时 passed。

合并器校验：两份均为 full，平台恰为 macOS ARM64 与 Windows x64；候选版本、源码与 fixture 集相同；每个平台必需 ID／子例无缺失且全部 passed；证据和报告摘要可核查。两个平台的包摘要自然不同，均须保留。只有满足这些条件才给“本候选客户端对约定验证对端的双平台完整验收通过”。混版、只做交叉构建、缺平台、缺原生用例、not-run 或失败均阻止该结论。

固定 token、模型 fixture 和测试业务页面证明客户端遵循约定及正确执行，不证明生产身份平台、真实业务 Skill 质量、付费模型效果或外部生产集群已经上线。报告必须列明这些实际边界；真实生产接入另绑定对应环境证据，不把 fixture 替身写成生产验收。
