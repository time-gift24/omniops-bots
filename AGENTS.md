# AGENTS.md

本规范适用于整个仓库；`web/` 另须遵守其目录内的 `AGENTS.md`。

## 关键文档写入权限

- 未经用户明确允许，禁止创建、修改、覆盖或删除 `CONTEXT.md`、`AGENTS.md` 等项目规范、上下文和架构决策类关键文档；仅可读取。一般任务授权、技能流程或自动维护要求不视为对这些文档的写入授权。

## 产品范围与职责

- 本仓专注桌面客户端。**Node.js 是 desktop 的主后端**，负责 Agent 装配、模型与 MCP 调用、图执行、浏览器自动化及本地数据管理。
- `web/` 是 React + TypeScript 前端，由 Tauri 加载；普通浏览器入口用于演示与测试，复用同一套页面和业务 interface。
- `desktop/runtime/` 是随包交付的私有 Node.js runtime。`main.mjs` 组装依赖并处理 IPC；`runtime.mjs` 负责桌面任务；`execution/` 负责 LangGraph 执行生命周期与证据；`chat/` 负责聊天适配与历史；`browser/` 负责 Chrome／Playwright；资源与配置由各自模块管理。
- `crates/omniops-bots-desktop` 承担 Tauri 原生壳、Node 子进程与 IPC、系统能力、内嵌 CEF 及进程生命周期；`omniops-bots-desktop-helper` 是 macOS CEF helper。业务后端能力放在 Node.js，不在 Rust 中再实现一套。
- `omniops-bots-collector` 已接入原生壳，管理该进程的可观测输出；它不是 Node.js 业务后端或独立服务。
- 服务端是外部接入方。`docs/requirements-walkthrough/` 中的发布、同步、远端任务和诊断 API 是客户端所需契约，完成情况以文档中的明确标记为准，不代表本仓负责服务端实现。
- 旧 Rust harness、Scheduler、LLM Provider 库与 PostgreSQL 后端计划已取消。不得据此恢复 core／HTTP／CLI／数据库 crate 或预建空层；本地持久化沿用现有文件与 SQLite checkpoint。

## 技术栈与依赖

- Node.js 使用 `26.11.1`，与 `Makefile`、runtime engines 和打包脚本保持一致；JavaScript／TypeScript 使用 ESM。runtime 的 TypeScript 必须能由随包 Node 直接加载，遵守其 `tsconfig.json`。
- 前端依赖由 `web/package.json` 管理，后端依赖由 `desktop/runtime/package.json` 管理，各自提交 `package-lock.json`，安装用 `npm ci`。先用 Node 标准库和已有依赖，不为假设需求新增框架。
- 图编排与模型接入复用现有 LangGraph.js、Deep Agents、LangChain 和 MCP SDK；不自建通用调度器、协议库或依赖注入容器。
- 原生部分使用 Rust 2024，工具链与格式以 `rust-toolchain.toml`、`rustfmt.toml` 为准。共享依赖版本统一声明在根 `Cargo.toml` 的 `[workspace.dependencies]`，使用方通过 `workspace = true` 引入，遵守 `deny.toml`。
- 凭据不得提交仓库。当前单模型入口读取环境变量／未跟踪的 `model.env`；后续 Provider 管理遵循第 11 章的系统凭据库方案，普通配置只存凭据引用。不得提交本地数据、生成的原生资源或 `.npmrc`。

## 模块与接口

- 优先复用已有模块，只为真实的外部边界与变化点定义 interface。入口组装具体依赖，内部辅助函数不机械包装成类、trait 或 adapter。
- 前端只经自有 interface 与 adapter 访问资源、持久化和宿主能力；共享页面不直接调用 Tauri、Node、网络或存储。平台接入在启动入口选择，桌面启动失败不得偷偷切回演示数据。
- Node 模块接收实际需要的依赖，复用 `createDesktopRuntime`、`createExecution` 和已有资源工厂；内部模块不暴露原始 IPC 报文给业务页面。
- 新增或调整模块接口时说明公开导出、完整调用签名、输入／输出、构造校验、错误分类，以及异步调用的取消、清理与生命周期；提供仅经公开入口完成调用的示例，不为展示契约提前写实现或扩大公开范围。
- 原生库 crate 自有可失败 API 使用 `Result<T, crate::Error>`，在根导出基于 `thiserror` 的统一 `Error`；必要类型与构造／读取入口对调用方可达。实现外部 trait 时遵守其错误契约；不为传递错误来源引入业务不需要的依赖。

## 校验、错误与执行生命周期

- IPC、模型配置、文件路径、URL、上传内容和第三方响应都是输入边界。复用 `input.mjs` 与现有校验，检查类型、大小、受控选项及路径归属；不把用户路径或模型输入直接拼进 shell 命令。
- 预期失败通过异常／Promise 拒绝或 Rust `Result` 传播，不用 panic、静默吞错或伪造成功处理用户输入和外部失败。保存失败保留编辑，持久化更新不能留下半包或破坏已有数据。
- Node 边界复用 `RuntimeError`、`ExecutionError` 与 `safeError`；内部保留来源，IPC 只输出安全分类与摘要，不发送依赖的原始错误或来源链。Rust 原生壳使用自己的错误转换。
- `threadId`、`runId`、`graphThreadId` 分别表示业务会话、一次执行与图身份；checkpoint 不能替代聊天历史。沿用现有并发准入、同会话互斥、唯一终态、取消传播和资源清理，不因切页面停止任务。
- 失败、取消、超时和进程重启后不自动重跑图或模型请求；新一轮显式发送创建新的 Run 和 graphThreadId。取消只表示本地停止消费／执行，不承诺上游计算已撤销。
- Node 子进程 stdout 专供 IPC，禁止混入日志。进程关闭先停止任务、释放浏览器与存储，再结束子进程；不让遥测失败改变业务结果、stdout 或退出码。

## 日志、链路与监控

- 功能设计时必须向用户确认新增哪些关键日志、span 和指标：解决的问题，开始／完成／失败／取消边界，级别、字段、标签、单位与统计口径。复用本次会话已确认的决定；无需新增时明确理由。纯文档清理或职责对齐不改变执行路径，无需新增埋点。
- Rust 原生壳沿用 `tracing` 与标准 OpenTelemetry Metrics API；SDK、exporter、后台 stderr 和初始化／关闭集中在 Collector，由进程入口显式初始化一次。Node 业务复用现有安全事件和错误边界，不把 Rust Collector 当作 Node 全链路已接入的证据，也不为对齐文档新建遥测门面。
- 未初始化且宿主未另行配置时为空操作。原生壳初始化后无显式端点只用本地后台 stderr，不隐式连接 localhost；初始化先于复用指标句柄，不承诺热启用或补发。
- 网络与 stderr 输出在后台完成；队列和指标属性组合必须有界，满时允许丢弃，不等待容量、不逐条创建任务、不用同步 stderr 或无限重试兜底。无效远程配置安全诊断并降级本地；诊断限频且不递归进入同一远程管线。
- 遥测故障不改变业务结果或错误、不触发模型重试。所有 exporter 和 writer 共享调用方指定的总关闭预算，超时允许丢弃；Drop 和线程等待不得再次拖延退出，忘记关闭仅为非阻塞 best effort。
- 本地与远程均禁止记录凭据、原始请求头、提示词、回复正文、原始协议／配置文本或完整错误来源链。日志显式选择安全字段；保留错误来源不代表可以直接输出 Debug。
- 指标只用受控且有容量上限的维度。请求／trace／响应 ID、完整 URL、用户内容和任意错误文本不得作标签；日志与链路的关联 ID 限长并编码控制字符。计数与耗时须明确实际开始和结算边界，成功／失败／取消只结算一次；累计 usage 用最新已知值，不重复相加，未知不补零。过滤与采样不得影响指标。
- 修改观测路径时验证未初始化、遥测故障与输出背压下业务行为不变。

## 验证

遵循 `.pre-commit-config.yaml`。只修改文档时检查内容一致性、引用、空白和文件结尾；按改动范围执行以下检查，不把本地浏览器测试算作 Node 单测。

Node 后端：

```sh
npm --prefix desktop/runtime run typecheck
npm --prefix desktop/runtime test
```

前端（另见 `web/AGENTS.md`）：

```sh
npm --prefix web run typecheck
npm --prefix web run lint
npm --prefix web test
npm --prefix web run build
```

- 影响浏览器、IPC 或桌面交互时执行对应浏览器／原生回归；runtime 的浏览器目标为 `npm --prefix desktop/runtime run test:browser`，前端浏览器用例位于 `web/tests/*.browser.html`。模型调用使用本地 fixture，不依赖真实密钥或付费服务。
- 打包脚本变更执行 `node --test desktop/scripts/*.test.mjs`；macOS 开发启动脚本变更另执行 `python3 -m unittest discover -s desktop/scripts -p 'test_*.py'`。交付包按目标平台验证，入口为 `make dev`、`make package-macos` 和 `make package-windows`。
- 非平凡逻辑保留最小有效行为测试，通过现有边界注入小型 fake，验证失败、取消与清理；不新增通用 mock 框架，不绑定私有字段或复制实现。

Rust 原生代码变更：

```sh
cargo fmt --all -- --check
cargo check --workspace --all-targets --all-features --locked
cargo clippy --workspace --all-targets --all-features --locked -- -D warnings
cargo test --workspace --lib --bins --all-features --locked
```

- Collector 变更另运行 `cargo test -p omniops-bots-collector --doc --locked` 和 `cargo test -p omniops-bots-collector --test runtime --locked`。Rust 依赖变更运行 `cargo deny check --disable-fetch`。
- 不通过全局关闭警告、绕过 ESLint 边界或静默跳过失败来通过检查。只修改任务需要的文件，保留已有未提交改动。
