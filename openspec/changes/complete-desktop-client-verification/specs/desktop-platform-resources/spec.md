## ADDED Requirements

### Requirement: Trusted platform session and resource authorization
客户端 SHALL 复用平台既有会话与 `GET /api/session`，只从已验证凭据和响应取得用户、组织、安装身份与权限；业务请求正文、自报角色、AgentCard 的 `tenant` 或内容摘要 SHALL NOT 代替身份与权限校验。官方读取、下载、草稿维护和发布 SHALL 分别使用对应授权范围，前端权限展示 SHALL NOT 代替服务端逐请求鉴权。此要求由 RES-02 验收。

#### Scenario: An ordinary user reads an official release
- **WHEN** 平台核验会话具有官方资源读取权限但没有维护权限
- **THEN** 客户端允许读取已授权发布版本，界面不提供官方维护入口，直接提交的官方写请求仍由服务端拒绝

#### Scenario: A session cannot be verified
- **WHEN** 身份核验失败、会话失效或下载请求不具备相应资源权限
- **THEN** 客户端报告安全的鉴权或授权失败，保留本地编辑与已有历史，不依据正文中的身份字段继续远端读取或写入

### Requirement: Immutable formal package identity
客户端 SHALL 将正式 Agent 保存为 `agents/releases/<agentId>/<contentId>/`，其中仅含 `agent.json` 和 `prompt.md`；正式 Skill SHALL 保存为 `skills/releases/<skillId>/<contentId>/` 的完整原始文件包。两类 `contentId` SHALL 使用既有 `packageContentId` 文件清单规则：保留相对路径和空目录，文件记录字节数与 SHA-256，按路径排序并对规范化清单计算 SHA-256。标签、上传者、时间与传输容器 SHALL 位于包外；传输容器摘要 SHALL NOT 冒充内容 ID。此要求由 SYNC-01、ASM-01 验收。

#### Scenario: Original Agent bytes are downloaded
- **WHEN** 已授权的正式 Agent 清单提供两个文件的原始字节与预期内容 ID
- **THEN** 客户端原样保存字节并独立重算包摘要，JSON 排版、Prompt 空格与换行均受摘要保护，不通过解析后重新序列化生成另一份文件

#### Scenario: A formal identity conflicts with existing content
- **WHEN** 服务端为相同内容 ID 返回不同字节，或将已有标签映射到另一个内容 ID
- **THEN** 客户端拒绝本次同步并报告完整性或版本冲突，保留已有完整包与原标签映射

### Requirement: Legacy local identities remain distinct
客户端 SHALL 区分当前本地 `agents/<agentId>.json` 的配置摘要、会话 `assemblyContentId`、正式 Agent 包内容 ID 和运行指纹。正式版本解析 SHALL 读取精确发布包，SHALL NOT 将旧配置摘要解释为正式包摘要；接入 SHALL 保留现有本地资源、历史 Run 与已固定会话的可读性，不为私有 Agent 强加正式标签。此要求由 ASM-01、FP-01 验收。

#### Scenario: A formal release and a legacy local Agent coexist
- **WHEN** 本机已有本地 Agent 与旧会话，同时同步同名官方 Agent 的正式发布包
- **THEN** 两者保持各自身份与保存位置，新远端任务只解析指定的官方发布包，旧会话继续按原快照读取，不改写旧摘要或历史记录

### Requirement: Exact version retrieval and bounded atomic caching
客户端 SHALL 按明确的 `agentId + contentId` 取得正式 Agent，再按 `agent.json.skills` 补齐精确 Skill 包；已有有效完整缓存 SHALL 复用，只下载缺失版本，SHALL NOT 回退旧版、跟随浮动最新版或镜像全部历史。下载、解包与校验 SHALL 在正式版本目录外暂存，复用现有路径校验与包容量约束，并对传输字节数、展开大小、文件数、深度和总装配大小设置有限上限；链接、特殊文件、路径穿越、重复路径、大小写冲突及超限内容 SHALL 被拒绝。校验原始字节、来源和摘要成功后 SHALL 原子提交；取消或失败 SHALL 清理本次暂存、保留原缓存，不启动模型或 Chrome。此要求由 SYNC-01、ASM-02 验收。

#### Scenario: A required package is missing
- **WHEN** 指定 Agent 已取得但部分 Skill 完整包不在缓存
- **THEN** 客户端只下载这些固定内容版本，独立验证后提交完整缓存，保留旧版本并继续本次装配

#### Scenario: A valid cache already exists
- **WHEN** 已核对的正式版本与全部关联完整包均已缓存且摘要有效
- **THEN** 客户端复用相同包，不重复下载、不改写原文件，并为本次会话固定独立快照

#### Scenario: A download or extraction fails
- **WHEN** 下载中断、取消、摘要错误、清单越界或解包遇到非法路径与超限内容
- **THEN** 本次准备明确失败，读者看不到半包，历史缓存与未同步编辑保留，模型和浏览器操作次数均为零

### Requirement: Complete assembly is frozen before execution
客户端 SHALL 在现有 `prepareSession` 与 runtime 准备生命周期中解析正式 Prompt、固定 Skill 引用、builtinTool 选择及包内完整非敏感 MCP 配置，捕获当前本地实验内容，保存完整只读会话快照后才构造执行图。正式 MCP 配置 SHALL NOT 经可变全局 MCP ID 重新解释。Skill SHALL 仅按本次固定挂载集合提供给图节点按需读取；图代码 SHALL NOT 保存第二份可独立发布的业务 Prompt。开始后编辑资源、更新发布标签或变更默认设置 SHALL NOT 改变该会话已经固定的资产。此要求由 ASM-01、RES-03 验收。

#### Scenario: An official Agent is assembled
- **WHEN** 精确 Agent 与 Skill 包验证成功，所需工具、MCP 和本地模型条件可用
- **THEN** 现有执行入口取得同一次装配的 Prompt、只读完整 Skill、确定的工具与 MCP 配置，保存快照后执行，不能搜索全部历史 Skill 来替代指定挂载

#### Scenario: New content is published during an existing session
- **WHEN** 已固定的手动会话继续输入，而官方 Agent 或本地工作副本已经改变
- **THEN** 该会话保持原资产快照，新内容只供明确开始的新会话或新任务选择

### Requirement: Missing assembly capabilities fail before effects
客户端 SHALL 检查所有指定 builtinTool、MCP、Skill、Provider、挂载路径及实际工具名称；缺少能力、冲突、快照保存失败或图构造失败 SHALL 结束本次准备，保留安全错误和已有材料，不静默删减能力、不代用其他版本、不自动重跑。失败与取消 SHALL 沿用现有唯一终态、取消传播、排空与容量释放机制，SHALL NOT 新建执行引擎或任务队列。此要求由 ASM-02 验收。

#### Scenario: A selected builtinTool is unavailable
- **WHEN** 当前桌面版本缺少至少一个 Agent 所选 builtinTool
- **THEN** 客户端列出缺失项并提示更新桌面，在模型与 Chrome 操作前失败，不尝试通过 Skill 下载工具实现

#### Scenario: Required MCP discovery or snapshot persistence fails
- **WHEN** 必需 MCP 连接、鉴权、工具发现失败，或完整快照无法保存
- **THEN** 客户端停止本次准备，关闭已经取得的连接与资源，排空后释放容量，并向原任务返回安全失败

### Requirement: Durable local Skill file operations
客户端 SHALL 经现有 Skill interface 与 adapter 支持真实文本和二进制内容、相对路径与目录结构的保存，在实际持久化完成后才显示已保存；官方发布包 SHALL 保持只读，复制为本地后允许独立编辑。同名上传 SHALL 由用户选择替换或跳过，批次逐项报告；目录失效 SHALL 停止对应写入，不改存根目录。保存失败 SHALL 保留原文件和未保存编辑，保存期间的新编辑 SHALL 保持未保存状态。此要求由 RES-01、RES-02 验收。

#### Scenario: A binary attachment is saved and reopened
- **WHEN** 运维向有效的本地 Skill 子目录上传文件，写入成功后重启客户端
- **THEN** 客户端读取相同相对路径和原始字节，保存的是实际内容而非临时浏览器 URL

#### Scenario: Replacing a colliding file fails
- **WHEN** 用户选择替换同名文件但持久化失败，或等待期间目标目录被移除
- **THEN** 客户端报告该项失败，原有可恢复内容与编辑保留，其他已成功项不撤销，不将失败内容标为已保存

#### Scenario: An official Skill is copied locally
- **WHEN** 用户明确提交复制已发布 Skill 并在成功后编辑副本
- **THEN** 本地副本保留完整包且可写，官方缓存及其他会话快照保持原字节

### Requirement: Unpublished draft experiments use complete snapshots
客户端 SHALL 允许在 Skill 页面选择现有 Agent，对尚未上传的已保存完整草稿发起独立实验；每次实验 SHALL 固定完整装配并只临时替换所选 Skill，不修改模板 Agent、正式包或标签。存在未完成写入或未处理保存失败时 SHALL NOT 将对应内容视为已保存。实验产物 SHALL 另存于运行记录与产物目录，不写回 Skill。此要求由 RES-03 验收。

#### Scenario: A local unpublished draft is tested
- **WHEN** 运维保存完整草稿、选择模板 Agent 并显式发送实验任务
- **THEN** 客户端用本次固定草稿运行，后续编辑不改变实验快照，原 Agent 与正式 Skill 保持不变，实验无需正式标签或先上传

#### Scenario: A file is still being saved
- **WHEN** 草稿文件存在进行中的写入或尚未处理的保存失败
- **THEN** 客户端阻止把该内容作为已保存版本进入实验、上传或发布，并保留编辑供继续处理

### Requirement: Draft uploads preserve immutable revisions and request identity
客户端 SHALL 在上传前捕获完整已保存包，并使用第 10 章既有草稿接口、`expectedRevision` 与 `Idempotency-Key` 提交；本次请求 SHALL 固定原始字节和摘要，后续编辑 SHALL NOT 改变已提交修订。仅在服务端完整持久保存后 SHALL 显示草稿上传成功；超时 SHALL 保留同一操作、授权范围、键与内容，以原键重试取得原结果，不用新键猜测是否成功。草稿保存 SHALL NOT 发布或联动 Agent。此要求由 REL-01 验收。

#### Scenario: Editing continues during an upload
- **WHEN** 运维上传已冻结的 Skill 或 Agent 完整包后继续编辑工作副本
- **THEN** 服务端修订对应原请求字节，客户端分别显示已上传修订与新的未同步编辑，模板与发布版本不变

#### Scenario: A draft response is lost
- **WHEN** 服务端已保存修订但客户端未收到响应
- **THEN** 客户端以相同幂等键与内容重试取得同一修订；若同键对应内容不同则显示 `idempotency-conflict`，本地工作副本仍保留

### Requirement: Linked releases are confirmed atomically
客户端 SHALL 基于确定草稿修订和既有发布预览取得受影响官方 Agent，要求运维手填 Skill 及全部受影响 Agent 的新标签后提交单次联动发布。标签 SHALL 使用 `v.1.0.0` 形式且不可重用、覆盖或改指向；发布 SHALL 仅在完整 Skill 包、全部新 Agent 包与标签均持久提交且可读取后报告成功。基线变化、权限失败或任一标签冲突 SHALL 不产生部分发布。提交表示本人确认，SHALL NOT 增加审核人或强制实验门槛；超时 SHALL 沿用原幂等身份恢复结果。此要求由 REL-02 验收。

#### Scenario: A Skill release updates its dependent Agents
- **WHEN** 运维提交确定修订、预览基线及 Skill 与全部受影响 Agent 的未占用标签
- **THEN** 服务端一次提交新的固定引用和内容 ID，客户端在完整结果确认后显示成功，已有标签、历史包及旧会话不变

#### Scenario: A release baseline or tag conflicts
- **WHEN** 受影响 Agent 已变化、漏交必要标签或其中一个标签已被使用
- **THEN** 整次发布失败，客户端保留本地材料和原请求信息，不显示部分成功，不创建替代标签或自动重发另一轮发布

### Requirement: MCP discovery and execution reflect actual capabilities
客户端 SHALL 复用现有 MCP SDK 与 `connectMcp`，按当次固定配置连接实际远端服务、发现能力并绑定工具调用；resources、prompts 与 tools SHALL 保持不同语义，SHALL NOT 自动把资源或提示词注册为工具或覆盖 Agent Prompt。工具名称冲突与发现失败 SHALL 明确失败；调用错误 SHALL 保留失败语义，取消 SHALL 关闭并排空相关连接。凭据 SHALL 仅经运行时引用取得，值不进入正式包、快照与交付摘要；MCP 服务实现 SHALL 不建立本项目发布版本。此要求由 MCP-01 验收。

#### Scenario: A real MCP service exposes tools resources and prompts
- **WHEN** 已配置服务返回三类能力且工具调用成功
- **THEN** 客户端将实际工具目录记录于运行快照并调用对应服务，资源与提示词仅保持可发现元数据，不成为额外工具或替代系统指令

#### Scenario: An MCP operation fails or is cancelled
- **WHEN** 远端返回工具错误、连接失败或调用期间收到取消
- **THEN** 客户端保留对应安全失败或取消结果，不伪造工具成功，已打开连接按现有执行生命周期清理且不触发任务重跑

### Requirement: Provider selection and credentials remain local
客户端 SHALL 复用既有 Provider 管理、默认模型与系统凭据边界；普通配置只存凭据引用，密钥 SHALL NOT 进入 Agent 包、快照、指纹组成或诊断材料。线上任务 SHALL 在准备时解析本机有效默认 Provider 与模型，不接受远端密钥或 Provider／模型覆盖。调试会话 SHALL 允许开始前改选，开始后固定；更改默认值 SHALL 只影响后续新任务。无鉴权配置与凭据引用不可读 SHALL 区别处理，后者在发送前失败，不降级为无鉴权或其他模型。此要求由 PRV-01、PRV-03 验收。

#### Scenario: A remote task attempts to override local models
- **WHEN** 远端任务携带 Key、Provider 或模型覆盖字段，或本机没有有效默认组合
- **THEN** 客户端拒绝覆盖或报告本地配置不可用，安全失败信息交付原任务，不替用户任意选用其他接入

#### Scenario: A default changes after a session starts
- **WHEN** 已开始的任务或调试会话固定了接入，运维随后更改全局默认值
- **THEN** 已固定会话不切换地址或模型，新会话采用新默认；原绑定或所需凭据不可用时明确失败，历史内容不被发往替代接入

#### Scenario: A credential reference cannot be read
- **WHEN** 配置包含系统凭据引用，但凭据缺失、锁定或访问被拒绝
- **THEN** 客户端在发送前失败，请求次数为零，不发送无认证替代请求，不回显密钥或原始认证头

### Requirement: Manual Provider tests are isolated from tasks
客户端 SHALL 仅在运维点击测试已保存模型后发送固定最小文本请求，准确使用配置的地址前缀与模型名，并保持 15 秒总超时；保存、打开页面或选择模型 SHALL NOT 自动测试。测试 SHALL 不读取会话或 Skill、不执行工具、不占用浏览器任务入口；取消、超时、上游拒绝或不完整响应 SHALL 明确失败且不自动重发，配置变化后旧结果 SHALL NOT 证明新配置有效。此要求由 PRV-02 验收。

#### Scenario: A model is tested manually
- **WHEN** 运维保存配置并显式测试所选模型
- **THEN** 客户端只发送固定最小文本到指定地址和模型，展示对应结果，不创建 Agent 会话、工具调用或 Chrome 页面

#### Scenario: A test is cancelled or the stream is incomplete
- **WHEN** 运维结束本地等待、15 秒超时到达或上游响应未正常完成
- **THEN** 测试不显示成功、不重发请求，客户端释放本地等待资源，并保持已有配置与会话不变

### Requirement: Runtime fingerprints identify fixed compositions
客户端 SHALL 在装配成功、执行开始前自动生成带格式版本的运行指纹，并保存可解释的完整组成清单。输入 SHALL 包含稳定 Agent 身份及正式内容 ID或本次不可变实验快照摘要、按固定顺序排列的 Skill 身份／内容 ID／挂载路径，以及实际 Provider 非敏感接入身份、模型、可取得的模型修订和明确有效参数；规范化 JSON SHALL 使用对象键排序与 SHA-256。展示名称、密钥及其轮换、runId、任务输入输出、时间、graph 编排和桌面工具实现 SHALL NOT 成为指纹输入；实际环境仍 SHALL 记录于运行快照供结果比较。此要求由 FP-01 验收。

#### Scenario: Equivalent compositions have different enumeration order
- **WHEN** 两次运行使用相同固定资产和模型参数，但对象键或 Skill 枚举顺序不同，或仅修改 Provider 展示名或轮换密钥
- **THEN** 两次生成相同完整指纹，保留各自独立 Run 与可解释组成清单

#### Scenario: A behavior configuration changes
- **WHEN** Skill 内容或挂载、Agent Prompt 版本、实际模型身份或有效推理参数改变
- **THEN** 新运行生成不同指纹；相同指纹不被宣称能够冻结外部模型、MCP 实现或应用代码行为

### Requirement: Rollback selects historical compositions explicitly
客户端 SHALL 允许从已保存指纹组成选择明确历史 Agent／Skill 版本与本地模型参数，并在新任务或新会话开始前重新检查物料可取得、模型可用及当前工具兼容性。回退 SHALL 不改写历史标签、不改变正在运行任务、不恢复旧 graph 或 MCP／builtinTool 实现、不自动重跑失败或取消请求，且不承诺撤销业务副作用。此要求由 FP-02 验收。

#### Scenario: A historical composition is selected
- **WHEN** 运维显式选择历史指纹对应的组合且所有资产与当前能力检查通过
- **THEN** 新会话按该确定组成固定快照并生成相应指纹，已有会话、旧标签与 Run 均保持原记录

#### Scenario: A historical model or asset cannot be restored
- **WHEN** 选中组合的包不可取得、模型不可用或所需工具不兼容
- **THEN** 本次准备明确失败，不替换版本或模型、不重跑历史任务，并保留选择与失败原因供运维处理
