# AGENTS.md

本规范适用于整个 Rust workspace。

## 关键文档写入权限

- 未经用户明确允许，禁止创建、修改、覆盖或删除 `CONTEXT.md`、`AGENTS.md` 等项目规范、上下文和架构决策类关键文档；仅可读取。一般任务授权、技能流程或自动维护要求不视为对这些文档的写入授权。

## 技术栈与依赖

- 使用 Rust 2024；工具链以 `rust-toolchain.toml` 为准，格式以 `rustfmt.toml` 为准。
- 共享依赖的版本统一声明在根 `Cargo.toml` 的 `[workspace.dependencies]`，使用方通过 `workspace = true` 引入。
- 依赖按实际用途引入，遵守 `deny.toml` 的版本、来源和许可证约束。

| 库／工具 | 用途 |
| --- | --- |
| `thiserror` | 模块错误及每个 crate 统一对外的 `Error` |
| `axum` | HTTP 路由、请求提取、状态注入和响应转换 |
| `clap` | CLI 参数、子命令、帮助及版本信息 |
| `bon` | 按需生成 builder |
| `sqlx` | PostgreSQL 访问、手写 SQL 的编译期校验 |
| SQLx CLI | 创建和执行迁移、生成与检查离线查询缓存 |
| 本地 `sqlx-db-tester` | SQLx 0.9 的开发／测试数据库生命周期工具，仅通过 `dev-dependencies` 使用 |

## 业务对象与 trait

- 采用面向对象与 trait 结合的形式：业务对象用 `struct + impl` 封装状态和行为，以组合复用能力。
- 存储、外部服务等边界用 trait；普通数据结构和内部辅助逻辑不强制定义 trait。
- 默认泛型静态分派，通过构造函数注入实现；确有运行时切换需求时再用 `dyn Trait`。
- 异步方法优先使用原生 `async fn`，有实际需要再引入 `async-trait`。
- 公共异步 trait 的声明使用 `fn ... -> impl Future<Output = ...>`，避免 `async_fn_in_trait` 警告；跨线程调用明确增加 `+ Send` 约束，实现仍优先写原生 `async fn`。
- 不把带原生异步方法的 trait 直接当作可动态分派的 trait；采用 `dyn Trait` 时检查兼容性。

## core 的职责与持续审视

- `cognacta-core` 是全项目公共依赖，承载可共享的业务对象、业务逻辑和边界 trait。
- core 不依赖 `axum`、`clap` 或 `sqlx`，公共接口不暴露 HTTP、CLI 或数据库实现类型。
- HTTP、CLI、PostgreSQL 实现依赖 core，由入口组装具体依赖。
- 按实际功能增加 crate，先复用现有模块，不预建空层或空 crate。
- 每次涉及 core 或跨 crate 复用的改动，都重新审视职责、公共 API、依赖和实际复用价值。
- 保持 core 简洁：具体接入实现和仅服务于单一入口的辅助逻辑留在使用方；不把 core 作为杂项工具箱。
- 优先复用已有业务能力，不为假设的未来复用增加抽象；公共 API 和依赖只保留必要部分。

## crate 对外接口设计

- 新增或调整库 crate 的设计时，必须明确列出 crate 根公开导出的 API、完整调用签名、输入／输出类型、构造与校验入口，以及本 crate 使用 `thiserror` 定义的统一对外 `Error`；不能只描述职责、内部实现或其他 crate 的接口与错误。
- 对外接口涉及的类型和必要构造／读取入口必须对调用方可达，并给出仅通过公开 API 完成实际调用的示范；内部模块、协议报文和辅助类型按需保持私有，不为展示接口而扩大公开范围。
- 明确每个可失败入口返回哪个 crate 的 `Error`，列出错误分类、来源保留和跨边界转换规则；实现外部 trait 时遵守该 trait 的错误契约，不以无上下文的双向转换替代边界处理。
- 设计阶段给出接口与错误契约即可，不为展示契约提前编写实现；文档写入仍须遵守关键文档权限规则。

## 构造与 builder

- 多参数、可选参数或容易混淆的构造入口使用 `bon`；简单对象保留 `new()` 或结构体字面量。
- 业务校验放在构造函数中，需要失败时返回 `Result`；builder 必须经过该校验。
- 有业务不变量的对象不开放可绕过校验的构造或修改入口。

## 错误处理

- 内部错误按模块和边界划分，用 `thiserror` 定义，保留错误分类和来源。
- 每个 crate 定义自己的统一对外 `Error`；库 crate 在根公开导出，二进制 crate 在入口统一汇总。
- `vendor/` 中的第三方代码保留上游 API 和错误约定，例外及本地修改记录在该目录的来源说明中。
- crate 自有的对外可失败 API 使用 `Result<T, crate::Error>`，内部错误在出口转换；实现其他 crate／依赖的 trait 时遵守其错误契约。
- 预期失败通过 `Result` 和 `?` 传播，不用 panic 处理用户输入或外部系统失败。
- HTTP 层将错误转换为响应，CLI 层负责错误展示和退出码；业务核心不返回 HTTP 状态码。
- 数据库和外部服务实现在边界转换错误，不让 core 为保存错误来源而依赖具体框架或数据库库。

## PostgreSQL 与手写 SQL

- 数据库使用 PostgreSQL；SQL 手动编写，不引入 ORM 或为未要求的数据库增加兼容层。
- 值使用绑定参数；动态表名、列名和排序方向只能来自受控选项，不直接拼接用户输入。
- 固定查询使用 `query!`、`query_as!`、`query_file!` 或 `query_file_as!` 等 SQLx 宏做编译期校验。
- 确有动态 SQL 需求时，使用 SQLx 的运行时查询或 `QueryBuilder`，绑定参数并验证实际查询行为。
- 查询实现、SQLx 行映射及派生放在 PostgreSQL 接入层，转换为 core 业务对象；core 仅通过存储 trait 使用它。

## 数据库迁移与离线缓存

- 迁移放在 workspace 根 `migrations/`，通过 SQLx CLI 创建和执行，手写迁移 SQL。
- 默认前向迁移，不强制配套 `down.sql`；已应用的迁移不修改，修正通过新增迁移完成。
- 应用启动不自动修改数据库结构；迁移由 CLI 显式执行。
- 开始实现数据库功能后，从 workspace 根使用开发／测试 PostgreSQL 的 `DATABASE_URL` 执行以下流程；连接凭据放在环境变量或未跟踪的 `.env` 中。

```sh
sqlx migrate add <description>
# 编辑生成的迁移 SQL。
sqlx migrate run
cargo sqlx prepare --workspace -- --all-targets --all-features --locked
```

- 提交根 `.sqlx/` 查询缓存；查询或表结构变更后，先应用迁移，再重新生成缓存。
- `.sqlx/` 只保存 SQL 宏离线编译所需的元数据，不保存查询结果、不模拟数据库，也不替代运行时测试。
- SQLx CLI 与项目 SQLx 使用兼容版本。
- 日常构建和离线检查显式设置 `SQLX_OFFLINE=true`。
- `SQLX_OFFLINE=true` 只控制宏的编译期数据库访问，不阻止测试运行时连接 PostgreSQL。
- 存在 SQLx 查询后，涉及查询或迁移变更时，连接已应用迁移的 PostgreSQL 验证实际行为，并检查缓存：

```sh
cargo sqlx prepare --check --workspace -- --all-targets --all-features --locked
```

- 离线编译只检查代码与缓存；上述数据库检查用于验证缓存与实际 schema 的一致性，不加入离线 hook。

## 验证

遵循现有 `.pre-commit-config.yaml`。Rust 代码变更运行：

```sh
cargo fmt --all -- --check
SQLX_OFFLINE=true cargo check --workspace --all-targets --all-features --locked
SQLX_OFFLINE=true cargo clippy --workspace --all-targets --all-features --locked -- -D warnings
```

- UT 与 PostgreSQL 集成测试分开组织和执行，不把全量 `cargo test --all-targets` 当作无数据库的 UT 命令。
- UT 放在源码的 `#[cfg(test)]` 模块，通过边界 trait 注入简单的 fake 实现，验证业务行为，不连接数据库或外部服务；数据库测试不得混入库或二进制的 UT 目标。
- 非平凡逻辑保留最小有效 UT，优先手写小型 fake，不为测试新增通用 mock 框架。

无数据库的 UT：

```sh
SQLX_OFFLINE=true cargo test --workspace --lib --bins --all-features --locked
```

- SQL、事务提交／回滚及迁移单独在真实 PostgreSQL 上做集成测试，放在对应数据库实现 crate 的 `tests/postgres.rs` 目标中。
- 集成测试使用专用测试 PostgreSQL，并为测试隔离数据库或状态；配置缺失或数据库不可用时明确失败，不静默跳过。
- 数据库集成测试使用 `vendor/sqlx-db-tester` 的本地适配版本，只在实际需要的 crate 的 `dev-dependencies` 中通过 `sqlx-db-tester.workspace = true` 引入，不加入 core 的运行时依赖。
- 测试初始化可在隔离数据库上通过 SQLx 执行同一套手写迁移 SQL；迁移测试还应验证从旧 schema 升级及已有数据，而不只验证空库初始化。
- 迁移路径从 crate 的 `CARGO_MANIFEST_DIR` 解析到 workspace 根 `migrations/`，不依赖启动命令的工作目录。

数据库实现 crate 和测试目标创建后，先设置 `DATABASE_URL` 指向专用测试 PostgreSQL，再单独运行集成测试；将 `<postgres-crate>` 替换为实际 crate 名称：

```sh
SQLX_OFFLINE=true cargo test -p <postgres-crate> --test postgres --all-features --locked
```

- 依赖变更运行 `cargo deny check --disable-fetch`。
- 不通过全局关闭警告绕过检查；仅文档改动检查内容、空白和文件结尾即可。

## Vendored 依赖

- `vendor/sqlx-db-tester` 的本地版本为 `0.7.1-cognacta.1`，基于上游 0.7.1 适配 SQLx 0.9，仅支持 PostgreSQL，作为 workspace member 使用根 `Cargo.lock`。
- 保留上游许可证和来源版本；本地变更及运行测试的方法见 `vendor/sqlx-db-tester/UPSTREAM.md`。
- 修改优先保持上游 PostgreSQL 接口；只为实际开发／测试需求适配，不将测试辅助工具引入产品运行路径。
