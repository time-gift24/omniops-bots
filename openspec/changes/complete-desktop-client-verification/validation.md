# 本次设计交付校验

日期：2026-10-26。范围：本 change 的规划文档；没有新增产品实现、启动外部验证服务或执行产品全量验收。

| 检查 | 实际结果 |
| --- | --- |
| OpenSpec artifact 状态 | proposal、design、specs、tasks，4/4 完成，apply-ready |
| OpenSpec 严格校验 | `validate complete-desktop-client-verification --strict --json`：valid=true，issues=[] |
| 能力与规格对应 | proposal 中 5 个能力与 5 份 spec 一一对应 |
| 规格格式与可验证性 | 47 项 SHALL 要求、106 个 WHEN／THEN 场景；每项要求至少一个四级 Scenario |
| 需求来源覆盖 | 串讲目录全部 17 份正文＋3 份版本布局／加载补充均在追踪矩阵中引用 |
| 验收矩阵 | 45 个唯一场景 ID，分列现有资产、刺激、断言、证据层级与待实施边界 |
| 实施任务 | 55 个唯一编号，全部未完成，未将设计生成计作产品实施 |
| 本地引用 | 新文档相对文件引用全部可解析，无断链 |
| 文件规则 | 无尾随空白、冲突标记或超限文件，每文件单一末尾换行 |
| 交叉复核 | 已修正认证快照竞争、受理时模型固定、包限制与下游一致、首次发布空基线、诊断公开入口、无远端退订及实际模型参数核对 |

CLI 不在当前 PATH；实际通过本机已安装入口运行：

```sh
node /Users/wanyaozhong/.local/share/fnm/node-versions/v24.3.0/installation/lib/node_modules/@fission-ai/openspec/bin/openspec.js validate complete-desktop-client-verification --strict --json
```

文件、链接、来源覆盖、唯一 ID、规格结构和任务状态另以 Python 标准库检查完成。当前 Node 为 26.11.1，CLI 所在目录名称不代表本次使用 Node 24 执行。

本次只新增该 change 目录，不覆盖原有未提交修改，不修改 AGENTS.md、CONTEXT.md、PRODUCT.md 或 DESIGN.md。外部 WS／HTTPS 服务、客户端接入与验收脚本仍须按 [任务清单](tasks.md) 实施；目标协议与接口见 [设计](design.md)，逐项验收见 [验证矩阵](verification.md)。Windows 实机、签名更新和生产平台真实身份缺少证据时不能给出完整通过结论。
