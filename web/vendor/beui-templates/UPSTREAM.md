# beUI 模板来源与本地适配

本目录保存完整、可独立导入的 beUI 模板源码。产品现有 `src/` 业务组件未被本目录覆盖。

## 来源

- 本地镜像：`/Users/wanyaozhong/Projects/beui-templates`，其 README 标记提取于 2026-10-16。保留全部 772 个有效文件的相对路径、组件结构与原始 README；仅排除 `.DS_Store` 等操作系统元数据。
- 镜像缺少的基础组件：从项目已安装的真实 beUI 实现补齐 `components/motion/button/base.tsx`、`button/stateful.tsx`、`input.tsx`、`tabs.tsx`、`popover-morph.tsx`、`shared-layout-bg.tsx`，并补齐其所需的 `popover-position.ts` 与 `lib/hooks/use-hydrated.ts`。没有用业务页面或占位实现代替缺失组件。
- 其他公共模块：使用 `https://proxy.collectui.pro/api/r/beui/<name>.json` 的真实 registry 源码补齐 15 项直接依赖及响应中附带的本地源码，共增加 42 个文件；不覆盖镜像已有文件。每个 registry URL、外部包依赖、来源文件与校验值均见 `manifest.json`。

## 适配

- 用 TypeScript AST 将本地模块引用从 `@/` 改为 `@beui-template/`，覆盖静态导入、重导出、动态导入与类型导入；相对引用保持原样。产品可通过该命名空间导入本目录组件。
- 两处 `next/image` 在 Vite 中改用原生 `img`；保留 `src`、`alt`、宽高与样式，仅移除 Next 专用的 `unoptimized` 属性和导入，不引入 Next 框架。
- 28 个插画中的 `<style jsx[ global]>` 改为原生 `<style>`；逐个检查组件特定 class 和 keyframes 命名，无跨组件碰撞或 `:global` 语法，CSS 内容保留；IconMarquee 的减少动效规则补齐方向属性选择器，确保其优先级足以停止默认动画。
- 公共组件补齐模板实际使用的契约：NumberTicker 支持关闭初次滚动且保留后续数值动画；MorphPopover 支持四向定位、居中、空间翻转与视口约束。
- 其他兼容性修复包括 Vite 的开发环境标记、Effect options 构造类型、只读标题数组副本及过期 ESLint 注释移除；逐文件详情见 manifest。
- 外部 npm 依赖由宿主 Web 工程管理；本目录不包含模拟实现。
- 三个官方展示资产的 URL、原始与安装哈希在 manifest 的 `assets` 数组。工作台 WebP 保留原始来源记录，并缩放重编码以符合仓库 1 MiB 文件限制。

## 完整性

`manifest.json` 的 `files` 数组记录每个源码文件的相对路径、原始镜像 SHA-256（非镜像补件为 `null`）、来源 SHA-256、实际安装 SHA-256、来源与本地适配。生成的 manifest 与本说明不作为上游源码条目递归登记。后续源码兼容性修复须更新对应 `modifications` 与 `installedSha256`。

## 使用与验证

通过 `@beui-template/` 别名按需导入；例如：

```tsx
import { NumberTicker } from "@beui-template/components/motion/number-ticker";

export function Count({ value }: { value: number }) {
  return <NumberTicker value={value} animateOnMount={false} />;
}
```

宿主已配置 Tailwind 扫描、Vite／TypeScript 别名与全部外部依赖。`npm run beui:check` 校验来源与资产哈希、严格类型检查和全部 819 个模块的打包；`tests/beui-catalog.browser.html` 验证运行时适配。展示模板中的文案、业务数据、剪贴板等宿主操作需要在接入产品时按既有 interface／adapter 规则适配。
