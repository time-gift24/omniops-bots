# 实施与验证记录（2026-10-27）

本 change 已进入实施。`verification.md` 保留 2026-10-26 提案时的基线；本文件记录本轮实际结果。完成情况以 `tasks.md` 的逐项勾选及机器报告为准，不能将一次契约通过视作 45 组需求或双平台完整验收。

当前为 50／55 项已完成；Windows 实机与双平台合并 2 项按用户要求暂缓。其余 3 项为完整场景自动化验收、macOS 已签名旧版到新版交付验收、真实平台联调。

## 已落地的调用链

- `desktop/runtime/main.ts` 在本地 ready 后连接独立 HTTPS／WSS 对端，使用同一凭据快照核验 session 与 Upgrade，接入既有 A2AService、准入、精确版本装配、真实 LangGraph、MCP 与受管理 Chrome。任务执行、结果待交付与持久确认分别保存。
- 正式 Agent 两文件包与完整 Skill ZIP 受摘要、路径、容量和 origin 校验；Provider 在受理时固定，运行指纹记录实际非敏感参数。`historyRunId` 只从本机保存的 Run 选择可核验的正式组合，在新 thread 重新检查资源、模型及工具；未发布本地草稿不能冒充可恢复的正式版本。
- 完整工作副本可冻结上传草稿、预览并原子发布 Skill 和受影响 Agent；原键、原请求体及冻结字节跨重开保留。界面接入自有 interface／Tauri adapter，并按 session 权限开放。
- 诊断按 thread 租约和 SQLite 一致读事务逻辑导出全部 namespace、父关系与 pending writes；未知序列化、缺失材料和历史来源身份明确列为不完整。ZIP 可重新选择、校验及预览，截图须显式选择。上传需要知情确认，回执核对上传编号、thread 和包摘要。
- 原生壳增加同数据根 OS 文件锁、独立 `--diagnostics` 入口及标准签名 updater；未配置编译期更新地址／公钥时明确不可用。维护准入和关闭共用原有任务生命周期与总预算。

## 可复现的外部服务

实现及完整运行说明见 [`desktop/verification/README.md`](../../../desktop/verification/README.md)。服务为独立进程，有自己的 SQLite 账本，不挂载客户端数据根；控制面仅 loopback 且需要独立随机凭据。跨机部署支持公开 HTTPS origin、固定 MCP 地址及显式控制端口转发，TLS 校验始终开启。

```sh
npm --prefix desktop/runtime ci
node desktop/verification/init.mjs --directory /absolute/empty-directory
node desktop/verification/verify.mjs --profile contract --config /absolute/empty-directory/verify.json
node desktop/verification/verify.mjs --profile full --config /absolute/empty-directory/verify.json
```

`contract` 返回其实际执行子例的结果；`full` 继续运行既有代码、浏览器与原生源码检查。机器 JSON 和 Markdown 报告保留 passed／failed／not-run、源码与 dirty 摘要、fixture 摘要、命令、时间及证据。配置候选包时实际核验文件、包 SHA 和源码身份；双平台合并拒绝缺失或不匹配的证据。退出码 0／1／2 分别表示该声明范围通过／已执行失败／缺少完整执行条件。

## 本机实际检查

测试使用隔离临时目录、fixture 模型及短期测试证书，无付费模型调用。证书与凭据未写入仓库。

| 边界 | 本轮实际结果与证据 |
| --- | --- |
| 正常 `main.ts` 的外部契约 | 工作区入口与最终包内 Node 分别 32／32 子例通过；包内报告 `/private/tmp/omniops-client-verification-20261027/reports-packaged/report-1793083971962.json` 核实 Node 26.11.1／ABI 147。历次完整报告如实保留当时失败阶段 |
| Node 后端 | typecheck 通过；全套 195／195 测试通过，包含真实 Provider、SQLite、A2A、TLS/WSS、发布和诊断边界。背压新增用例验证暂停 TLS 消费、1013 封闭、任务持续执行及旧发送回调隔离，不宣称测量特定内核缓冲阈值 |
| 外部服务与报告工具 | 14／14 测试通过，包括真实 main 的重连互斥、待握手关闭、符号链接／超限凭据拒绝及严格报告合并 |
| 前端 | typecheck／lint／两种 edition build 通过；135／135 单测通过。35 个 HTML 页面分别在 user／operations 构建环境通过（70 阶段），生产构建布局回归通过；另有维护／发布及旧流程桌面、窄屏定向证据。修复聊天预加载、流式附件禁用与标签滚动退化，校准真实单词流边界断言和父页面双视口预算 |
| 打包脚本 | Node 6／6、Python 5／5 通过 |
| Rust 原生源码 | fmt／check／clippy／workspace lib+bins tests／deny 通过；26 项常规测试通过；另外显式执行隔离系统凭据写入、读取和清理测试通过。Collector 文档 1 项、runtime 集成 6 项通过，覆盖未初始化、遥测失败、网络／stderr 背压及总关闭预算。CEF 使用本机匹配版本缓存，未下载替代 SDK |
| macOS ARM64 包 | `make package-debug` 构建约 683 MiB 的 ad-hoc 签名 `.app`，`codesign --verify --deep --strict` 通过。修复 null shutdown 参数契约后重建，真实宿主／Node 均退出 0；共享数据根锁、锁释放后的独立诊断共 3／3 通过：`/private/tmp/omniops-native-final-smoke-20261027-r3/native-report.json`。CEF 隐藏页面、隔离和释放通过：`/private/tmp/omniops-cef-final-smoke-Ofa582/candidate-evidence.json`；两报告绑定相同宿主 SHA。独立诊断保持主数据库等原始材料字节，报告明确列出 SQLite 只读访问创建的 SHM 锁索引及空 WAL |

最终单入口执行于 2026-10-27 06:56:08～07:02:01 UTC：[完整机器报告](/private/tmp/omniops-client-verification-20261027/reports/report-1793084521305.json)。32 个契约子例与 87 个可执行检查阶段全部通过，失败数为 0。`full` 的最终结果为 `not-run`、退出码 2，对应尚未收齐正反子例的 45 组完整场景，不能改写为完整产品验收通过。历史失败报告保留。

## 仍不能宣称完成的验收

- 45 组需求中的全部正反边界尚未由单一 runner 全部执行。现有 `full` 会明确保留 not-run，不能作为完整验收通过结果。
- macOS 的真实签名旧版到新版安装、重启和数据保留需要已签名候选及更新站点；ad-hoc 调试包与源码单测不能替代。
- 用户于 2026-10-27 明确要求本轮暂不验证 Windows，因此 Windows 原生 ABI、凭据、CEF、安装与升级及双平台合并验收顺延；不计为通过，也不作为当前 macOS 范围的完成门槛。
- fixture 身份与自建验证服务不证明真实生产平台的登录、网关委托和物料 origin 已集成；需要实际平台环境执行 task 10.5。

本轮没有新增产品日志、span 或指标。现有安全错误边界、业务状态、持久回执与测试报告承载证据；测试 ledger 不视为产品遥测。
