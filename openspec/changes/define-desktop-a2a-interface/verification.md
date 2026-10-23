# A2AService 实施与验收记录

日期：2026-10-23。当前宿主：macOS arm64，Node.js 26.11.1。用户已明确授权按本提案实施模块，WSS 接入继续暂缓。

## 已交付的模块边界

- 公开入口：`desktop/runtime/a2a/index.ts` 的 createA2AService／protocolFor／confirmTaskDelivery／close；标准方法直接使用 SDK A2ARequestHandler。后续 adapter 不需要读取内部数据库或执行状态。
- 官方 SDK 1.3.0 不 fork：查询、列表、订阅、可选能力拒绝复用 DefaultRequestHandler；发送两方法与取消按项目契约适配，执行用 SDK AgentExecutor 薄桥接，持久合并用 ResultManager。
- 持久化：SDK DatabaseTaskStore、Kysely 0.29.5、better-sqlite3 12.11.1、json-canonicalize 3.0.1；固定 `<directory>/a2a.sqlite`。SDK Task 表＋一张项目扩展表，另有 SDK 自带迁移 ledger。受理、完整终态＋摘要、首次回执分别原子提交。
- runtime 业务源码统一为严格 TS／ESM，由随包 Node 直接加载；main.ts／Rust 启动路径／打包入口和测试引用同步。共享执行名额、固定官方版本、真实结果固定边界与取消排空均复用已有 runtime／execution／LangGraph。
- HTTP/SSE 验证宿主只在测试进程临时监听 loopback。Express 是开发依赖，核心不引入 HTTP 框架；桌面 main.ts 尚未组装 A2AService，也没有生产 a2a.close。生产身份、transport 与桌面生命周期随后续接入，不能将验收宿主的同预算关闭视为桌面接入完成。
- 不新增日志、span 或指标，继续使用 Task／Run 持久记录和安全错误边界。凭据、业务正文与原始错误链不输出为遥测。

## 三层运行证据

| 层次 | 入口／真实依赖 | 覆盖与通过条件 |
| --- | --- | --- |
| 模块／事务 | tests/a2a.test.mjs、a2a-failures.test.mjs、a2a-store.test.mjs；真实 SDK 和 SQLite，小型 runtime fake | 并发重投、先查重再准入、busy、JSON 结果、SDK User getter、并发取消只停止一次、立即排空竞争、待决 next 的 return 清理、字节／订阅限额、授权隔离、关闭竞争和期限、SDK Task 与项目行回滚、完整终态冻结、迟到写拒绝、回执首次／重复／失败、坏行与零原始错误输出 |
| 真实 runtime | tests/remote-runtime.test.mjs；实际 createDesktopRuntime／execution／LangGraph／版本装配，本地确定性模型与临时 checkpoint | JSON 对象进入实际图执行，返回对象／0／false／null；保持独立运行身份，共享本地容量，execute 前停止锁存，模型实际排空后结算，固定版本不回退，输入复制和非法 JSON 拒绝，退出预算不伪造清理完成 |
| 独立外部 Agent | tests/a2a-external.test.mjs 启动 fixtures/a2a-agent.mjs 与 a2a-harness.mjs 两个独立子进程 | Agent 只使用官方 ClientFactory／SDK transport 与 Node 标准 API；从 AgentCard 经真实 HTTP/SSE 调用实际 service/runtime/SQLite。验证阻塞／受理返回／流与重订阅、Get/List、重投冲突、隔离、缺版本／扩展、服务端能力拒绝、满额拒绝、CancelTask 的 WORKING→实际排空→CANCELED、断线继续、持久回执，以及 SIGKILL 后重启保留原终态／回执、遗留任务 FAILED/interrupted-unknown 且无模型重跑 |

外部 Agent 不 import 本项目 service、runtime、store 或 fixture 控制对象。宿主 IPC 的统计仅用于父测试观察真实模型启动／排空，不承载 Agent 的业务请求或结果；业务均经过标准 A2A。取消 fixture 在停止后仍排空 250ms，验证收到 CancelTask 不等于执行已取消。该外部宿主使用小型 browser fake，证明协议／真实 runtime／LangGraph／SQLite 闭环，不证明 A2A 任务操作真实 Chrome；下述真实浏览器用例是已有 runtime／IPC 路径的独立回归。

## 执行命令

以下命令在当前宿主执行通过：Node 后端 162/162，真实浏览器 4/4；前端检查、测试与构建通过；Rust 原生单测 21 项通过，原有系统凭据测试 1 项 ignored。

```sh
npm --prefix desktop/runtime run typecheck
npm --prefix desktop/runtime test
npm --prefix desktop/runtime run test:browser
node --test desktop/scripts/*.test.mjs
python3 -m unittest discover -s desktop/scripts -p 'test_*.py'
npm --prefix web run typecheck
npm --prefix web run lint
npm --prefix web test
npm --prefix web run build
cargo fmt --all -- --check
CEF_PATH="$HOME/Library/Caches/tauri-cef" cargo check --workspace --all-targets --all-features --locked
CEF_PATH="$HOME/Library/Caches/tauri-cef" cargo clippy --workspace --all-targets --all-features --locked -- -D warnings
CEF_PATH="$HOME/Library/Caches/tauri-cef" cargo test --workspace --lib --bins --all-features --locked
```

Rust 使用现有本机 CEF 缓存；未配置该路径的首次检查因依赖尝试联网下载失败，按仓库构建脚本的缓存路径重跑后通过。Rust 测试中已有一项写系统凭据库的隔离测试按原用例显式 ignored，没有将其计为通过。

首次提交钩子的 Node 测试遇到宿主合盖休眠而超时：系统电源日志记录 08:19:06～08:20:44 的 Clamshell Sleep，与多个独立测试进程同时约 95 秒停顿吻合。唤醒后未改代码或超时阈值，完整重跑 162/162 通过；提交继续执行全部钩子。

真实浏览器四项覆盖多任务页面／登录态／独立取消、可见 Chrome profile 恢复、手动 CEF 与 Agent Chrome 的 IPC 分离，以及 Node 脚本权限、CDP 目标隔离与模型工具调用。打包脚本 6 项、Python 5 项通过；暂存的 TS 模块包含 A2A 公开入口，实际经 SDK CLI 创建 SQLite、保存 Task 并重开读取。脚本测试使用已锁定的本机依赖，不冒充完整安装包验收。前端检查用于本轮源码引用迁移的回归，不作为 Node 或 A2A 协议验收证据。

## 独立 review 后修复

- 故障后结束并移除共享总线，已有及后来建立的 Subscribe／重投 SendStream 在快照后安全结束；保留未落盘结果及运行名额，不伪造终态。
- CancelTask 对过期 WORKING 快照后已删除的运行重新读取持久终态，返回 TaskNotCancelable；关闭中止与调用方中止分别报告 unavailable／aborted。
- 终态 status 事件发布已经提交的 resultSha256；独立外部 Agent 比较流事件与 GetTask 摘要，再用同一摘要确认持久交付，并核验扩展响应头。
- 正常失败与重启恢复共用安全 Message 构造，包含 text、JSON reason、taskId/contextId，并追加协议历史；重开保留原消息。
- 公开 SDK 错误移除原始 cause，来源仅留在模块私有 WeakMap；实际 SDK Express 流错误路径验证 stderr 不包含注入的敏感哨兵文本。
- 不再 chmod 既有目录；公开构造回归覆盖专用目录、非专用目录、根目录／home／共享临时目录，以及未知数据库权限与内容不变。
- 真实 runtime 的非 JSON 模型结果使用 invalid-output；外部 Agent 验证 FAILED、无 Artifact、Run 原因与重启后同一结果。
- 补请求字节／深度、输出超限、已终态订阅和暂存 A2A 模块／SDK CLI／原生 SQLite 回归；明确桌面入口组装待后续 transport 接入。
- 清理串讲状态和 TS 标签；既有 concurrency 哈希保留为历史证据，stagedFiles 逐项核对原始提交 c2ff07d，不能当作当前源码验收。未以更新哈希伪造旧测试覆盖当前代码。

## 实测 SDK 差异与限制

1. **data:null**：SDK 1.3.0 的 Part.fromJSON 把 null 当字段缺失。TaskStore 在公开 Kysely 结果插件中观察本次原始字段，SDK 解码后仅恢复显式 null，无额外 SQL 或私有导入。线上 ProtoJSON、持久化及重启后查询保留 null；官方 TS 高层 client 自身仍有此缺陷，外部验收借公开 fetchImpl 读取原始标准报文核验 null，并明确断言 typed client 的已知限制。0／false 直接由标准 typed client 验证。没有将上游 bug 伪称为已修复。
2. **迁移 API**：SDK 只公开 a2a-db CLI。初始化经包公开 bin 元数据执行 offline SQLite SQL 生成，在唯一 timeout=0 连接事务中应用；未复制 Task DDL 或导入私有迁移。平台路径校验使用 Node path.relative，避免 Windows 分隔符差异。
3. **生产接入**：WSS、网关委托／会话有效期、生产 HTTP 的认证和传输背压均未接入。临时 HTTP 验收宿主的通过不代表新增了生产 HTTP 服务，也不意味着全部可选能力启用。
4. **平台范围**：当前验证为 macOS arm64／Node 26.11.1；未声称 Windows 实机或完整安装包分发通过。Rust 和打包脚本检查不能替代跨平台安装包验收；未发布、签名或分发应用。
5. **副作用语义**：取消不回滚外部操作；强退后的非终态报告结果未知，不重放图、模型或 checkpoint，不承诺外部副作用恰好一次。

后续 WSS 应复用这里的任务回归，只新增传输、可信身份注入、版本／扩展协商、背压和连接清理验收。

## 文档与图形检查

OpenSpec 严格校验通过；串讲阅读页桌面／窄屏、图片和链接检查通过，6 项阅读／评论回归通过。关键类图的模型与原始 Archify HTML 通过工具交付校验；仓库 HTML／SVG 随后仅规范化行末空白及文件结尾，阅读页再经浏览器回归。工具原始 receipts 保留其原始字节哈希，不将其冒充规范化后文件的严格 provenance 证明；本模块的运行验收不依赖图形 receipts。
