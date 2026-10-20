# 前端开发规范

本文件适用于 `web/`。后续 agent 必须遵循；同时遵守仓库根 `AGENTS.md`。

## 目标与已确认范围

- 本仓聚焦 Tauri 桌面客户端，`desktop/runtime/` 的 Node.js 是主后端；`web/` 提供同一套桌面界面与浏览器演示／测试入口。共享页面、业务 module、hook 和内存状态不得因接入方式不同复制两份。
- 平台差异通过前端自有 interface 与 adapter 隔离，由启动入口选择具体实现。本目录不实现 Node.js 业务后端、Rust 原生壳或外部服务端。
- 桌面与浏览器演示的数据各自独立；前端内存实例与持久化缓存按接入身份隔离。
- 桌面已通过 adapter 接入 Node.js 的资源、设置、聊天历史与运行记录；具体持久化由所属 adapter／后端负责。前端的未发送输入、未保存编辑、工作区与会话目录沿用现有内存生命周期，不得借结构重构新增刷新恢复或跨端同步。

## interface 与 module

- 新能力先查找已有 interface、module 与实现，能复用就复用。只为实际变化的资源／持久化／宿主能力定义 interface，不为每个函数、展示 module 或计算缓存增加抽象。
- interface 和前端 DTO 归所属业务 module；具体接入、平台 SDK、存储对象和 mock 数据归 `src/adapters/`。展示图标与 React 类型留在展示侧。
- 只声明当前已有调用者需要的方法，不预建 CRUD、分页、动态容器、事件总线、通用缓存框架或新的状态框架。
- 契约除输入／输出类型外，必须说明失败、取消、订阅清理、身份范围与调用顺序。adapter 负责校验外部输入并提供调用方可理解的错误，不让页面按原始传输异常或报文字段分支。
- Skill 原始文件来源与本地草稿覆盖必须分开：保存写草稿；恢复原文只移除草稿覆盖，不能改写原始 Skill。
- 目录 adapter 返回已规范化的 `WorkspaceDirectory { path, name }`。共享 store 不解释 POSIX／Windows 路径；Workbench scope 携带已解析路径，不能要求 adapter 猜测前端随机 ID 对应的目录。
- 已选附件的文件／URL 等输入引用必须完整到达 Chat interface；消息视图与快照只保存展示元数据，原始文件仅用于内存中的发送与重试，不因此新增上传实现或持久化。
- `ThreadStore`、`ThreadStoreRegistry`、`WorkspaceStore` 已承担内存状态职责，优先复用。高亮、布局测量、memo、object URL 等内部渲染缓存留在原 module。

## 调用约定与依赖注入

- 外部资源、持久化及宿主操作使用 `Promise`；Chat 事件流使用 `AsyncIterable`；内存 `getState`、快照读取、订阅和取消订阅保持同步。
- 启动入口在 React render 外组装稳定依赖，通过 `AppDependenciesProvider` 注入。不同应用实例分别创建自己的 registry、workspace store 与有状态 adapter。
- 业务页面／功能 hook 通过 `useAppDependencies` 消费所需 interface；通用展示 module 优先通过 props 接收数据和回调。
- Context 只分发稳定依赖与已有内存实例，不塞入消息列表、每次按键、加载状态或编辑状态。不在 render 或页面内部创建具体 adapter，不提供偷偷回退到 mock 的全局默认实例。
- 具体实现只在入口／adapter 装配处选择；共享代码不得直接导入 mock 数据、具体 adapter 或平台 SDK，也不得绕过已定义 interface 直接执行网络、持久化或宿主操作。
- 正常 DOM 渲染能力仍留在 UI：焦点、布局、滚动、键盘、系统主题监听、标准文件输入、预览 URL 等无需机械包装。

## 生命周期与异步正确性

- 同一挂载周期的依赖与接入身份保持稳定。页面切换不得重建应用实例，也不得调用 Chat 的 `abort()`；保持现有“离开页面继续消费，用户显式停止才中止”的行为。
- 工厂构造保持无外部副作用；请求与监听在明确生命周期内启动并清理，兼容 StrictMode 的重复 setup／cleanup。
- 文件／变更查询及其加载 key 必须包含实际依赖的工作区、会话和文件身份，并考虑 adapter 实例变化。旧请求的结果不得覆盖新 scope 的状态。
- 异步草稿读取不能覆盖新编辑。保存以开始保存时的文件与文本为快照，成功仅确认该版本；等待期间的新编辑仍为未保存。
- 保存、删除失败保留当前内容，不显示成功；恢复原文须等待草稿删除成功。防止同一文件的重复保存／删除乱序。
- 主题初值在首次挂载前异步读取；两项偏好独立失败回退。用户后续切换立即更新内存，持久化失败不回滚选择。保留跨标签主题更新，平台事件由 adapter 转换。
- 缓存 namespace 由 adapter 在装配时绑定，页面不拼接接入身份。当前 `demo` 身份兼容原有存储 key；其他身份不得读取该旧数据。不得静默丢失已有草稿或让已删除草稿因旧 key 回退而复活。

## ESLint 与测试是交付要求

- 必须保留并遵守 `eslint.config.js` 的依赖与平台访问限制；不得用局部 disable、别名或中间转发 module 绕过架构规则。
- 新增／修改接入能力时，通过同一 interface 注入小型 fake 测行为。可用手动 resolve／reject 的 Promise 验证延迟与失败，不引入通用 mock 框架。
- 关键检查包括：两个应用实例独立、两个缓存身份不串数据、切换 scope 后忽略旧响应、保存失败不丢编辑、保存期间新编辑不被误标成功、主题失败降级与变更通知。
- 测试验证可观察结果，不依赖私有字段、具体传输或纯粹复制实现。展示测试需要显式 Provider，不能重新引入可变全局 registry。
- 从 `web/` 执行：

```sh
npm run typecheck
npm run lint
npm test
npm run build
```

- `npm test` 只执行 `.test.mjs`；影响浏览器交互时，还须执行对应 `tests/*.browser.html` 的回归，不能把 Node 测试通过当作浏览器验证完成。
- 只修改本任务需要的文件，保留已有未提交改动；不得顺手修改 Node.js 后端、Rust 原生壳或其他关键规范文档。新增业务行为的埋点决策继续遵守根规范，纯结构重构不机械增加埋点。
