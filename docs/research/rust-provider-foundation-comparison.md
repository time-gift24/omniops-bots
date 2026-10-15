# Rust provider crates 底层选型：统一库、原生 SDK 与 reqwest

调研日期：2026-10-14（Asia/Shanghai）。比较多 provider Rust 库、各家原生协议 SDK 和直接 HTTP 实现。仓库目前是 workspace 骨架，尚无 Provider trait 或消息契约，不把下列验收假设当作已批准产品需求。沿用[前次 genai 调研](genai-provider-foundation.md)的范围：OpenAI / Anthropic / Gemini / Ollama、流式文本和工具、reasoning 回放、错误与传输配置。

## 已确认的选择

2026-10-14，用户确认以 `reqwest` 为 provider crates 的 HTTP 底层。各 provider 负责原生协议映射；流式分帧、AWS 签名等可复用独立库，具体依赖在实现对应功能时确定。以下保留调研阶段的候选比较与取舍依据。

后续[流式分帧专项调研](stream-framing-libraries.md)建议 SSE 用 `sse-core`、NDJSON 用 `tokio-util::LinesCodec`、Amazon EventStream 用 `aws-smithy-eventstream`。本篇曾验证的 `eventsource-stream 0.2.3` 在更完整的边界 fixtures 中复现 BOM panic 和裸 CR 末尾事件丢失，已不作为默认候选；本篇早期测试结果仅覆盖当时列出的输入。

## 调研建议

**对 Cognacta 的独立 provider crates，推荐以 `reqwest + 可靠的 SSE/NDJSON 分帧 + 私有原生协议映射` 为默认路线，并按 provider 复用 SDK；不强制所有 crates 依赖同一个统一 LLM 库。** 这是根据本次版本、源码和离线/mock 验证作出的工程判断。`reqwest` 只解决 HTTP，不能把它说成已经解决 tool assembly、reasoning 回放或错误语义。

**统一库中首选评估 Rig 0.44.0 的公开 Wire/Decoder。** 它确实比 genai 更接近可复用底层，而且通过了几个关键 fixture。如果首版希望快速覆盖主流文本/thinking/tools，且接受它的 history adaptation，私有复用 Rig 会明显减少协议工作；严格要求自有历史政策、原生字段和请求控制时，直接 HTTP 更合适。两条路线都应保持 Cognacta core 的公共 API 独立，不把第三方 DTO 或 HTTP 类型透出。[R1] [R12]

| 接入范围 | 当前优先选择 | 选择理由与边界 |
| --- | --- | --- |
| OpenAI Responses / Chat | `async-openai` DTO-only + 自有 reqwest；普通 typed API 也可使用完整 SDK | 可复用大量 native 类型；需要保存未知字段时仍保留原始 JSON。完整客户端默认重试，成功 headers 不直接暴露。 |
| Anthropic / Gemini Developer API / Ollama 的严格原生路径 | reqwest + 相应协议分帧/DTO | 当前社区 SDK 存在具体缺口；签名、原生块、错误和新字段由 provider 控制。 |
| 多家共用的成熟聊天/工具协议 | Rig 私有 Wire/Decoder 候选 | 省去已有 encoder/decoder；默认 driver 会改写 history，直接用 codec 时调用方承担 driver 和 Origin 校验。 |
| AWS Bedrock | 官方 `aws-sdk-bedrockruntime` | 复用凭证链、可选 SigV4、Amazon EventStream 和服务错误契约，避免手写这一整套。 |
| Google Cloud Vertex | 深度 Cloud/gRPC 用官方 SDK；少量 REST 用 reqwest + 官方 auth | 不与 Gemini Developer API 混为一套 SDK；复用 ADC/token refresh，不手写 OAuth。 |

三条路线的维护分工：

| 维度 | Rig 公开协议层 | 原生协议 SDK | 直接 reqwest |
| --- | --- | --- | --- |
| 我们实现什么 | core 类型转换、transport/driver 选择、history 政策验收 | core 类型转换、事件聚合、错误与 SDK 政策协调 | request/response DTO、分帧后的协议解析、事件聚合与历史回放 |
| 原生新字段 | Native/Opaque 或扩展 Wire；受 serializer/history 规则影响 | 取决于版本与闭集 enum，必要时 BYOT/raw JSON | 按需求增加映射；保留 raw JSON 仍须自己验证语义 |
| HTTP metadata/策略 | transport 可替换，默认成功结果不带完整 headers | 各 SDK 不同，可能需要 middleware/interceptor | 直接读取 status/headers，策略完全由 provider 定义 |
| 升级成本 | 跟随 Rig API 和映射变化 | 每家 SDK 单独升级，协议耦合较小 | 由我们跟进各家协议及 fixture |
| 当前最合适场景 | 接受其 common model/history，减少多家 codec 工作 | 单家类型覆盖成熟，或认证/二进制协议复杂 | 严格原生行为、新字段/metadata控制，以及简单协议 |

这张表描述工作归属，未测量工时、性能或包体积；不是“自写一定更便宜”的证明。

若首先只接一个 provider，就只引入其实际需要的实现。共享 HTTP/分帧辅助逻辑在出现实际复用后提取，不先建一个通用 SDK 框架。

## 已核实的统一库候选与版本

版本直接取 crates.io API 的非 yanked 发行记录；下载发行 `.crate` 并读取 `.cargo_vcs_info.json`，不以 GitHub main 或搜索结果里的 latest 为基准。这些候选的最新发行均为 stable，没有更晚的已发布 preview。[M1] [M2] [M3] [M4]

| 候选 | 当前 stable；发布日期 UTC | 发布 commit；crate 目录 | 原始定位 |
| --- | --- | --- | --- |
| `rig-core` | `0.44.0`；2026-10-07 | `2d1071e0e0c602f994e9d6cfd8cf5faea6f53650`；`crates/rig-core` | 应用框架，但新版也提供独立 wire / driver 层。 |
| `aisdk` | `0.5.2`；2026-02-25 | `dfc6bb1d83b00f751ef684d05e6eaf192ccd0334`；根目录 | Vercel AI SDK 风格的统一模型与自动工具循环。 |
| `llm`（graniet） | `1.3.8`；2026-04-19 | `b9a54beaf07d6168cf28a68cb96bfca314b2787b`；根目录 | 多 backend、CLI、chain/agent、resilience。 |
| `llmrust` | `0.1.4`；2026-09-12 | `4ee2b67af6ab9e4577db4d2cca6e6f4fbb6708da`；根目录 | 较新的统一 client / proxy；纳入边界筛选。 |

`async-llm 0.11.1` 已发布 Anthropic / OpenAI / Responses 分离模块，更接近原生 typed SDK，归入本次 SDK 部分，不按名称误判为统一多 provider 消息层。

## 统一库的整体判断

**在这些统一 Rust 库中，Rig 0.44.0 最值得作为底层候选验证。** 新版已经公开纯请求编码、同步 decoder、原生内容保存和独立 transport；不能沿用“Rig 只是 agent 框架，底层封闭”的旧判断。它与 genai 的封闭 Adapter 有实质差别。[R1] [R2] [R3]

但 Rig 的公共模型路径仍采用自己的统一消息、history 修复和能力规则。是否选它，取决于 Cognacta 是否愿意采用这些语义；它不能等同于透明原生 SDK。`aisdk` / `llm` / `llmrust` 在已核实的签名、原生历史或流式边界上更弱，暂不作为独立 provider 协议底座的优先方案。下面均将事实与工程推断分开。

| 检查项 | Rig 0.44.0 | aisdk 0.5.2 | llm 1.3.8 | llmrust 0.1.4 |
| --- | --- | --- | --- | --- |
| 外部可扩展入口 | 公开 `Wire` / `Decoder` / `Transport` / `Model<W,T>` | 公开 `LanguageModel`；底层 `LanguageModelClient` private | 公开 `ChatProvider`；Anthropic codec DTO private | 公开 `Provider`；原生解析多在 private 函数 |
| Tool streaming | `Part` index、Start、raw Arguments delta、End | `ToolCall(String)` 没有 index / call identity | 有 index、start / input delta / complete；无 reasoning chunk | final chunk 才提供 assembled calls，没有参数 delta |
| Native assistant 回放 | `Native` / `Opaque` + Origin + fingerprint | 部分 typed extension；redacted 回放有缺口 | 统一 ChatMessage 无 signed thinking / opaque blocks | Message 无 signed thinking / opaque blocks |
| 可复用传输 | 可注入 HTTP 或自己的 Transport；reqwest optional | 每次 send 新建 Client，无公开 client 注入 | Anthropic/Google 有 `with_client` | provider HTTP 辅助实现，仍走统一消息模型 |
| 每 provider Cargo feature | 无；transport / modality 可选 | 有 | 有；必须关默认 CLI | 无；proxy optional |
| 底层候选排序 | 优先做协议验收 | 当前不优先 | 当前不优先 | 当前不优先 |

表中源码依据对应下文，不代表所有 provider 都已做运行联调。

## Rig：公开底层是真的，但默认会改写历史

**分层事实：** `Wire::encode(request, Mode)` 是同步 pure API，返回 HTTP `Encoded` 或其他 payload；`Decoder::classify` 区分 Known / Unknown / Corrupt，`decode` 写入 `Out`，`eof` 默认将无 terminal 的结束判为 Truncated。`Model<W,T>` 的 wire / transport 字段公开，外部可以直接复用内置 wire，并注入 `Transport<W>`；内置 HTTP transport 另接 `HttpClientExt`。库不要求通过 Agent 才能调用模型。[R1] [R2]

**流式事实：** `StreamEvent` 明确区分 Part Start、Text、Reasoning、Arguments、End；Arguments 是每个 part 的原始 JSON 字符串片段，End 才带完成的 AssistantContent。Part 是统一 response choice 中的位置，**不保证等于 provider 原始 index / output_index**。未知 payload 经 `Item::Unknown` 到消费者；这是逃生口，不是已知事件的全量 raw 镜像。[R3]

**回放事实：** AssistantContent 包含 Text / ToolCall / Reasoning / Image / Opaque。Native 保存原生 JSON item 与 canonical fingerprint；Origin 标记 api / provider / 请求 model；Model 的 history adaptation 检查来源并移除不再匹配的 native，serializer 检查 canonical fingerprint。直接调用 Wire::encode 不会替调用方完成全部 Origin 校验。跨模型、改写 canonical 内容或 context 变化可能转为重建。Raw 使用 `serde_json::Value`，并不是 HTTP 原始字节；nonstream 的整个 document 与 stream 重建的 document 也需要区分。[R4] [R5] [R6]

| 路径 | 已检查实现 | 保真边界 |
| --- | --- | --- |
| Anthropic Messages | decoder 有 thinking、signature delta、redacted_thinking、Opaque 分支；signed thinking 和 redacted data 留在对应 Native item。encoder 使用仍有效的 native item。 | 无有效 native 的 thinking 转为普通文本，redacted block 不能由纯文本恢复；跨模型历史不能假设仍是 native replay。[R7] [R8] |
| Gemini GenerateContent | `GenerateContentDecoder` 将 thoughtSignature 跟对应 part 保存；`ThoughtReplay::All` 默认，另有 CurrentTurn。 | encoder 丢掉格式不合法的 base64 signature；CurrentTurn 主动去掉早期 signature；重建的 Gemini 3 call 使用 placeholder。不要表述成任何输入都无条件原样转发。[R9] [R10] |
| OpenAI Responses | 独立公开 `Responses` wire、streaming decoder、document reassembler；native output item / Opaque 路径可保留 provider 内容。 | 必须按真实需要验证 hosted tools / encrypted reasoning / continuations；本次没有将所有事件类判为已完成验收。[R11] |

**最重要的政策差异：** `Model::call` / `stream` 必经 `Completion::prepare`，自动检查 options 并调用 history adapt；它会处理失败 turn、工具匹配和 ID、缺失工具结果、跨模型内容、不支持的媒体。库定义 `No result provided` 等补位文本，并可能将 tool-result image 移到用户消息。若 Cognacta 自己拥有严格历史校验，此逻辑可能重复甚至冲突；未找到关闭 adaptation 或 strict-history 的公开 request 开关；`on_unsupported` 的 Error/Warn 只控制 generation 参数。直接调用公开 `Wire::encode` 可以绕过 driver 的 prepare，但后续发送、decoder 驱动及 Origin 校验由接入层负责；encoder 本身仍有各 provider 的序列化规则。这个边界属于 history 语义选择，而不是 genai 式的封闭扩展问题。[R12] [R6]

### Tool result 并不是“支持多模态”一句话

`ToolResult` 有 `is_error`，content **仅** Text / Json / Image；Audio / Document 是 UserContent，不能把它们说成 tool-result 支持。[R5]

| Provider 路径 | 实际 encoder 行为 |
| --- | --- |
| Anthropic | 输出 `tool_result` content 数组，Text / Json-as-text / Image；`is_error=true` 可发送。没有通用 tool-result PDF / audio。[R8] |
| Gemini | Text / Json 进入 `functionResponse.response`；错误用 `error` key；Image 进入 functionResponse.parts。history 的模型能力判断仍可能降级或移动图片。[R10] [R6] |
| OpenAI Responses | output 可为 string 或 input_text / input_image 数组；函数 output 没有统一 `is_error` wire 字段，错误需在输出内容里说清楚。该差异是协议约束，不能期望所有 native APIs 接受相同 error flag。[R13] |
| OpenAI Chat | tool message 的图片被编码成 content 数组；history / dialect 决定模型是否接收该形态，不能把 encoder 能生成 JSON 当作服务支持证明。[R14] [R6] |

### 传输、错误和依赖

Rig 0.44.0 拆出 `rig-http` 契约和 optional `rig-reqwest`；默认 features 是 derive / rustls，**reqwest 并非默认 feature**，各 provider 的无参数 transport 构造需要显式启用它。可经 connect / with_http 注入 transport，或直接 `Model::new(wire, transport)`。可经 transport 复用 HTTP client；超时/代理/连接池具体策略由所用 transport 决定。[R15] [R16]

HTTP failure 的 ProviderError 保留 status / body / headers / request id，并提供 retryable 分类；成功 CompletionResponse 有 provider_request_id 和 raw，**没有通用成功 headers 字段**。内置 HTTP driver 每次发送一次；retryable 信号不等于自动重试策略。stream 的暂停由停止 poll 实现、取消可 drop；正常结束必须存在 provider terminal。[R2] [R17] [R18]

没有 OpenAI / Anthropic / Gemini 级 Cargo features；`rig-core` 仍带 completion、tool、embedding、loader 等公共体系。可关 derive、HTTP transport 和 optional modality，但不能按 provider 单独切除源码。MIT 符合当前 deny.toml，MSRV 明确为 1.95.0，低于仓库固定 1.98.1。最近 stable 是 2026-10-07，维护活跃；此事实不等于 provider wire 正确性已经由发布时间证明。[M1] [R15]

### 运行验证

临时 harness 用 exact `rig-core = "=0.44.0"`、`default-features = false`，Rust 1.98.1，通过公开 Model + 自定义 Transport 直接喂 WireFrame，没有网络或 API key。编译、运行结果：

1. OpenAI Chat 同一个普通 frame 带 index 0/1 两个 calls：**2 Arguments + 2 End，final choice 含 2 calls**；前次 genai 的同帧丢 call 问题在此 fixture 下未出现。
2. Anthropic streamed thinking + signature、redacted_thinking：两块 Native 的 signature / data 保留，下一轮公开 Wire::encode 将两者重新送回 assistant content。
3. Anthropic unknown `future_event`：消费者收到 Item::Unknown，未知字段保持在 payload。

可重跑 `cargo run --quiet --manifest-path /tmp/cognacta-provider-libraries/rig-smoke/Cargo.toml`。此验证只覆盖这些边界，不证明 live API、全部 raw 重建、HTTP headers 或 Gemini 真实回放。没有更改生产 Cargo / Rust 代码。

## aisdk：feature 裁剪较好，但 client 与 stream contract 不适合协议底座

`LanguageModel` 公开，provider features 细分；底层 `LanguageModelClient`、请求 options 及许多 response/stream DTO 是 pub(crate)，不是可独立调用的 encoder/decoder 插件层。默认 request API 自带工具步骤循环；可以使用模型 trait 绕开循环，仍受到统一 response contract 限制。[A1] [A2] [A3]

Stream ToolCall 只是 String，既无 call id/index，也无 tool start/end。Anthropic 内部按 block index 累积，却没有把索引传给消费者；Google stream 内部只有一个 `accumulated_tool_call: Option`，每次 functionCall 覆盖它，结束 Done 只返回最后一个。因此它不适合先定义为通用并行 tool delta 的底层。[A4] [A5]

Anthropic 普通 thinking 用 extension 保存 signature，但 redacted_thinking 被转换为 Reasoning 文本 data + 空 extension，下一轮 converter 又当 thinking 输出，并在无签名时以 content 充 signature；无法从这个统一结果恢复原 redacted block。tool error converter 用 `unwrap_or_default()` 转 JSON 字符串，没有 Anthropic is_error 标志。Google 的 call signature extension 有实际回放实现，但不能据此称整个 native history 无损。[A6] [A7]

每次 send / send_and_stream 新建 reqwest Client，没有公开注入共享 client；常见超时/代理/TLS 策略不能由 provider settings 直接配置。非流请求默认固定 5 次 HTTP 重试、Retry-After 仅秒数且封顶 30 秒；connect/timeout 错误用 `?` 直接返回。统一 ApiError 只有 status + string details，headers/request id/source 未保留。MIT；未声明 MSRV；只做源码审查，未运行 mock。[A2] [A8] [M2]

## llm 与 llmrust：可用 client，但统一类型先限制了回放

`llm 1.3.8` 的 ChatProvider/ChatResponse 公开，tool stream 有 block index/start/input delta/complete，Anthropic 与 OpenAI 实现了相应入口；但 StreamChunk 没有 reasoning/signature 类型，ChatResponse 的 thinking 只是 String，ChatMessage 没有 Native/Opaque/signed thinking。Anthropic 完整请求及 stream DTO private，不能直接取来建自己的 parser；错误状态/source 大多转为 String。Anthropic/Google `with_client` 能复用 reqwest Client，比 aisdk 更灵活，仍需自己解决原生历史。[L1] [L2] [L3] [L4]

llm 有 per-provider features，默认却启用 CLI → full，包括 agent、API 和 AWS Bedrock 等依赖；作为库必须 `default-features=false` 并选择所需 provider/TLS。MIT；未声明 MSRV。它提供更多应用层功能，不等于更小的协议底层。[L5] [M3]

`llmrust 0.1.4` 暴露 Provider trait、流式 thinking 文本和 final assembled tool_calls；Message 仍只有 OpenAI 风格 content/calls，沒有 opaque history/signature 结构。Anthropic signature_delta 和 redacted_thinking 被当作 thinking_done 标记，不保留签名/data；nonstream thinking 主动返回 Unsupported。它对未支持能力有显式失败，优于静默假装支持，但不能承担本次 signed history 的底层。MIT OR Apache-2.0，MSRV 1.86，proxy 可选、没有 per-provider features。本次未测其 proxy/性能。[U1] [U2] [U3] [M4]

## 各家原生协议 SDK

“原生 SDK”在这里指各家协议客户端，不等于官方 Rust SDK。OpenAI 官方页把 async-openai 列在 Community libraries；Anthropic 的官方 SDK 列表没有 Rust；Google GenAI 官方语言列表也未列 Rust。Google Cloud Vertex 与 AWS SDK for Rust 则是官方 Rust 库。其他语言的官方 SDK 可作为协议参考，但通过 Python/Node 子进程调用会增加部署与 IPC 成本，本项目没有这个需求。[N1] [N2] [N3]

| 已审查的主要 SDK | 当前 stable；发布 UTC 日期 | 许可证 / 声明 MSRV | 适用判断 |
| --- | --- | --- | --- |
| [async-openai](https://crates.io/api/v1/crates/async-openai) | 0.42.2；2026-10-10 | MIT / 1.75 | OpenAI 首选社区候选；声明 MSRV 不等于完整依赖图的下界，reqwest 0.13 本身要求 1.85。 |
| [async-llm](https://crates.io/api/v1/crates/async-llm) | 0.11.1；2026-09-02 | MIT / 未声明 | 普通 Anthropic Messages 可用，native 类型覆盖仍不完整。 |
| [threatflux-anthropic-sdk](https://crates.io/api/v1/crates/threatflux-anthropic-sdk) | 0.4.1；2026-10-06 | MIT / **1.99.0** | 与本仓库固定 **1.98.1** 不兼容；暂不选最新发行。 |
| anthropic-rust-sdk（gaoyia） | 0.112.3；2026-07-20 | MIT / 未声明 | 原生 Value 类型较灵活，已复现两项 streaming 问题。 |
| [gemini-rust](https://crates.io/api/v1/crates/gemini-rust) | 2.1.0；2026-09-05 | MIT / 未声明 | GenerateContent/Interactions 均有实现，但缺未知 part 与部分签名/工具结果。 |
| genai-rs（不同于 genai） | 0.10.0；2026-08-16 | MIT / 1.88 | Interactions 专用候选，原生类型强于 transport 扩展能力。 |
| [ollama-rs](https://crates.io/api/v1/crates/ollama-rs) | 0.3.6；2026-07-24 | LICENSE.md 实为 MIT / 未声明 | 可复用 Client，但已复现跨 chunk UTF-8 输出丢失。 |
| [google-cloud-aiplatform-v1](https://crates.io/api/v1/crates/google-cloud-aiplatform-v1) | 1.17.0；2026-09-24 | Apache-2.0 / 1.91.0 | 官方 Vertex SDK，REST + gRPC；不是 Developer API SDK。 |
| [aws-sdk-bedrockruntime](https://crates.io/api/v1/crates/aws-sdk-bedrockruntime) | 1.148.0；2026-10-01 | Apache-2.0 / 1.94.1 | 官方 Bedrock SDK，独立 provider 内优先复用。 |

版本来自各包 crates.io API；源码使用固定发布版本。未声明 MSRV 不代表兼容任意旧 Rust；Ollama registry 的 non-standard 是 license-file 元数据，不能据此认定许可证不兼容。SDK 的主要证据见各节固定链接。

### OpenAI：async-openai，尤其是 DTO-only 这个中间选项

`async-openai 0.42.2` 提供 Responses 的 output items、stream events、output/content index、function argument delta，以及 Chat 的多 tool chunk 数组。ReasoningItem 保留 encrypted_content；FunctionCallOutput 支持 string 或 text/image/file 内容数组。这是 native 协议类型，比统一 text/tools DTO 更适合 OpenAI provider。[N4] [N5] [N19]

开启 `response-types` / `chat-completion-types` 并关闭 default features，可以只依赖 DTO，不带 reqwest/Tokio/tower。完整 SDK 可按 `responses` / `chat-completion` 裁剪，注入 reqwest 0.13 Client；BYOT 支持自有请求/响应类型，middleware 允许替换 HTTP service。这让“用 SDK”与“自己用 reqwest”之间存在可组合方案。[N6] [N7]

标准 enum 仍是闭集：实测未知 OutputItem / ResponseStreamEvent tag 反序列化失败，已知 struct 的新字段通常被忽略，不能靠 typed DTO 无损保存未来 payload。BYOT + Value 可以保留 JSON 数据，但不等于保存全部 SSE event/id/retry 元数据。自己的历史若需要 opaque replay，应保留原始 native JSON，再从中取得所需 typed 视图。[N4] [N5] [N7]

完整客户端默认对 429/5xx/部分连接错误额外重试三次；Retry-After 仅解析整数秒。公开 Chat/Responses 方法不返回成功 response headers，错误类型保留 status 而无完整 header map。需要统一重试、request-id/rate-limit headers 时，可用 middleware 捕获，或直接采用 **DTO-only + 自有 reqwest**；后者是本次默认推荐的 OpenAI 路线。stream 使用 spawned unbounded channel，也需要考虑消费速度与内存，不能仅因“支持 streaming”就认为有背压。[N7] [N8] [N9]

### Anthropic：目前社区候选都需要额外处理

| 候选 | 核实到的优点 | 对当前 provider 底层的限制 |
| --- | --- | --- |
| async-llm 0.11.1 | thinking/signature/input_json delta 和 block index；is_error、图片工具结果；reqwest 0.12 Client 注入 | 没有 redacted_thinking/adaptive/server-tool 类型；未知变体报错。合法 SSE error envelope 被误解码为 deserialize error，虽传播 Err 但丢 provider 分类。 |
| ThreatFlux 0.4.1 | signed/redacted、unknown raw blocks、extra fields、多模态 tool results；显式 error/unknown events | MSRV 1.99.0；内部创建 HTTP clients，不能注入现有池；非流 retry 与流路径不一致；较多应用级依赖。 |
| gaoyia 0.112.3 | type:String + flatten Value 保存原生 blocks；有 HTTP 错误 metadata | 已复现 error event 被白名单静默过滤，以及逐 HTTP chunk UTF-8 lossy 转换导致中文损坏。 |

证据：async-llm [DTO][N10]、[client][N11]；ThreatFlux [内容类型][N12]、[manifest][N13]、[HTTP][N14]；gaoyia [decoder][N15]、[stream filter][N16]。这些结论针对上述发布版本，不推断后来版本一定仍有问题。

另初筛 `anthropic-ai-sdk 0.2.27`：有 redacted/signature，但 ToolResult 只有字符串且无 is_error/多模态。`anthropic-sdk-rust 0.1.1` 与 `anthropic-rust-sdk` 是不同项目；`anthropic 0.0.8` 仍以 legacy Completions 为主，不列入现代 Messages 优先候选。[N17] [N18]

因此本项目的 Anthropic 原生实现更适合直接 reqwest，或在接受 Rig 的请求/history 语义时复用其 wire。不能只因社区包名字含 SDK，就让它替 provider crate 定义长期契约。

### Gemini Developer API：服务与 SDK 名字要分开

`gemini-rust 2.1.0` 的 GenerateContent 保留部分 thoughtSignature 和完整 candidates/parts，但没有未知 Part fallback，FunctionResponse 没有多模态 parts；Interactions 的 function call/result 缺 signature 字段。它接受 ClientBuilder/custom base URL，却重新建池，不能直接共享已存在的 reqwest Client。错误保留 code/body，没有完整 headers。库内把 GenerateContent 标为 deprecated，不代表 Google 服务已经停用该 API。[G1] [G2] [G3] [G11] [G12]

`genai-rs 0.10.0` 面向 Interactions：原生 Step 支持签名、call ID、is_error、文本/JSON/多模态结果，Unknown 类型可保留完整 JSON。它比简单统一 DTO 更接近 native；但 HTTP client/base URL 无公开注入入口，SSE 按每个 data 行单独解析 JSON，不合并标准多行 data event。适合专用 Interactions 候选，不能当成通用可替换 transport 的协议库。[G4] [G5] [G6]

`rs-genai 0.5.0` 等其他社区库只作初筛，未完成同等深度验收，不能把本报告的比较解释为“所有 Gemini Rust 库均不适用”。若当前只用 GenerateContent 的 chat/tools，reqwest + 原生 parts 映射更容易控制签名、新字段和连接策略；若以后改用 Interactions，独立评估该 API，不将两套 event/history 模型混用。[N3]

### Google Cloud Vertex：官方 SDK 或官方 auth 都有复用价值

`google-cloud-aiplatform-v1 1.17.0` 已有 generate_content 与 stream_generate_content；本版 nonstream 使用 reqwest，stream 使用 tonic/gRPC。Part 支持 thought_signature，FunctionResponse 支持多模态 parts；REST DTO 保存 unknown fields，但转为 gRPC/prost 时只复制已知字段，不能承诺未知流字段无损。可按 prediction-service 关闭其他管理 service features。[G7] [G8] [G9]

默认 ADC、projects/locations 资源与 aiplatform endpoint，属于 Vertex，不能把它改 URL 就当 Gemini Developer API SDK。若仅少量 REST chat，可用 **reqwest + 官方 google-cloud-auth 1.17.0**，经 Credentials::headers 复用 ADC、token refresh、WIF/impersonation；不为了手写几个 REST 请求而重写 OAuth 凭证流程。深度 Vertex/gRPC/Cloud 资源接入则更适合官方完整 SDK。[G7] [G10]

### Ollama：协议简单，但现成 SDK 的流边界必须验证

Ollama native chat 是 NDJSON，而非 SSE。`ollama-rs 0.3.6` 允许注入 Client，支持 thinking/tools/images；但工具结果缺 tool_name、tool function 缺 index，stream 错误为 Result<_,()>，JSON 坏帧被打印后跳过，HTTP 错误失去 status/headers。[O1] [O2]

**本地 HTTP mock 已复现：** 有效 NDJSON 的“你”UTF-8 bytes 分到两个 HTTP chunks 时，SDK 返回空 stream，未给出错误。原因是每个 chunk 单独 String::from_utf8，失败便丢掉 chunk。此问题使它不适合当前 chat streaming 的默认底座；若需要 Ollama 模型拉取/管理等额外 SDK 功能，可另行复用那些入口。[O1]

### AWS Bedrock：官方 SDK 优先于手写 reqwest

`aws-sdk-bedrockruntime 1.148.0` 原生 Converse DTO 支持 tool status、多模态结果、reasoning signature/redacted Blob，ConverseStream 保留 content block index、tool/signature delta。Smithy 负责的是 **binary Amazon EventStream**，包括分帧和异常事件，并非 SSE。官方 SDK 同时复用凭证链、region、SigV4、retry/timeout 和 typed service errors；这些成本足以支持独立 Bedrock provider 采用它。[B1] [B2] [B3]

服务现在也支持 API key/Bearer，SDK 有 token provider，不能写“Bedrock 必须 SigV4”。即使 Bearer 简化了认证，EventStream 与异常契约的复用价值仍在。SDK 走 Smithy HTTP client，现成 reqwest Client 不能直接注入；不为了统一连接池强行重造一个 Smithy adapter。[B4] [B5]

SDK 的 Unknown union variant 没有原 payload，不能称为无损保留未来变体；additional model fields 或 InvokeModel Blob + 自有 DTO 是按需的 native 出口。SDK/Smithy 类型留在 Bedrock crate 内，core 不依赖它们。本次仅源码审查，未编译完整 Google/AWS SDK 或做真实服务联调。[B1] [B3]

### Bedrock 也可以只复用底层组件

补充核实：**EventStream 和 SigV4 并不要求引入完整 Bedrock SDK。** 少数 chat 接口、已有共享 reqwest 且愿意维护 native DTO 时，可以采用下列组合；完整 SDK 的推荐应理解为省去整套服务接入维护的选择，而不是分帧/认证只能由它完成。[B6] [B7]

| 工作 | 可独立复用的官方 crate |
| --- | --- |
| HTTP 连接、发送、接收 | reqwest |
| Amazon EventStream 二进制分帧、headers/payload、CRC | aws-smithy-eventstream 0.61.4 |
| AWS SigV4 请求签名（使用 AWS credentials 时） | aws-sigv4 1.6.0 |
| AWS credentials/profile/role 等发现 | aws-config 1.12.0；按需处理凭证刷新与缓存 |

这些组件本次最新 stable 均声明 MSRV 1.94.1，低于项目固定工具链；此次只是 API/源码核实，未编译或联调这套组合。API key/Bearer 路线只需相应 Authorization header，调用时仍遵守 token 的有效期。[B4]

MessageFrameDecoder 提供 public new()/decode_frame，接 bytes::Buf，返回 Incomplete 或 Complete(Message)。reqwest 每个 chunk 的 bytes 追加到持续 buffer，循环 decode 到 Incomplete；不能每个 chunk 当一个完整帧。完整帧输出后仍需按 :message-type / :event-type / :exception-type 解释 Bedrock payload、工具参数 delta 和异常，且在 EOF 检查帧与模型回复是否完整。[B6]

因此：**Bearer + 少数 Bedrock chat API 可选择 reqwest + 官方 EventStream decoder；使用多种 AWS 身份、凭证刷新、typed service APIs 与完整 SDK 行为时，官方 Bedrock SDK 更省维护。** 两者都复用现成能力，不必自行实现签名算法、CRC 或二进制 framing。[B7] [B8]

## 直接 reqwest：控制最完整，但协议维护由我们承担

`reqwest 0.13.5` 的共享 Client 已有连接池，clone 复用内部状态，不需要再包一层自制连接池。status/headers 可以在消费 body 前读取，JSON 与 bytes_stream 分别用于普通响应和流。通过 ClientBuilder 选择 TLS、proxy、connect/read/total timeout；当前默认 timeout 为 None。0.13.5 声明 MSRV 1.85，MIT OR Apache-2.0，与本仓库工具链/许可范围兼容。[H1] [H2] [H3] [H11]

最小合理组合是 `reqwest + serde/serde_json + SSE decoder`；Ollama 用保留 byte buffer 的 NDJSON 分帧。**直接 HTTP 不意味着手写 TCP、TLS、连接池或 SSE 规范。** 本次采用 eventsource-stream 0.2.3 验证 byte stream 解码，它与 reqwest 版本无绑定；这是验证候选，并未为项目正式添加依赖。该 parser 的最近发行在 2022 年，不用发布日期替代兼容/正确性检查，也未测超大帧性能。[H4] [H9]

需要自己负责的工作：

- 每种协议的 request/response 与 native block 映射；保留所需 opaque signatures、未知字段和 parts 顺序，不能只抽出文本。
- SSE/NDJSON 的 chunk/UTF-8 边界，工具 call ID/index 聚合、JSON 参数校验、usage/finish 与 required terminal。HTTP 200 或 EOF 不等于成功生成完成。
- HTTP status、Retry-After/request-id headers、native error events、body 限制与取消；drop stream 只是本地停止，不保证服务端任务取消。
- 请求重试由一个明确位置负责；流中已输出后断开，不自动重发整个生成 POST。reqwest 自身默认只重试它判断安全的协议 NACK，不能当成 LLM 429/5xx 或断流续传策略。[H5]

`reqwest-eventsource 0.6.0` 依赖 reqwest 0.12，且默认在错误/EOF 后重连并克隆原请求，重试次数无上限；直接给生成 POST 套此默认行为可能重新发起生成。若使用它，需明确关闭重连并由 provider 定义失败处理，或只复用 `eventsource-stream` 的单次 body parser。[H6] [H7] [H10]

这条路线提高了字段、metadata、网络政策控制，但维护多个 native 协议是持续成本；不能宣称“几行 reqwest 就等价完整 SDK”。保留 native JSON 可减少因新字段而返工，却不替代业务层的明确字段验证。若大部分代码开始复制 Rig 的正确 encoder/decoder，优先复用而不是继续重写。

## 本次运行验证与未覆盖范围

| 临时 harness | 实际检查结果 |
| --- | --- |
| Rig exact 0.44.0 / 自定义 Transport | 同帧 2 tools 全保留；signed/redacted Anthropic 回放；unknown event 透传。 |
| async-openai exact 0.42.2 DTO-only | 两 tool chunk 保留；encrypted reasoning 与多模态工具结果可解析；unknown enum 拒绝、新字段忽略。 |
| async-llm exact 0.11.1 | signature/image/is_error 通过；redacted/adaptive 与正确 error envelope 暴露类型/解码缺口。 |
| anthropic-rust-sdk exact 0.112.3 | SSE error 被过滤；跨 chunk“中”变为“���”。 |
| ollama-rs exact 0.3.6 / 本地 HTTP chunked | 跨 chunk“你”被丢弃，实际返回 []。 |
| reqwest exact 0.13.5 + eventsource-stream exact 0.2.3 | 逐 byte 切分的 UTF-8/CRLF/multiline SSE 正确；同帧 2 calls、opaque 字段、事件名保留；HTTP 200 headers 与 429 Retry-After/body 保留。 |

全部已运行的 harness 使用 Rust 1.98.1；测试使用离线 fixtures 或本地 HTTP mock，未请求真实模型。直接 parser 的截断 final SSE block 在 EOF 被丢弃，符合 SSE framing 规则；因此 provider 仍须检查 terminal event。[H8]

可复跑的临时命令：

```sh
cargo run --quiet --manifest-path /tmp/cognacta-provider-libraries/rig-smoke/Cargo.toml
cargo run --locked --quiet --manifest-path /tmp/cognacta-native-sdk-smoke/Cargo.toml
cargo run --quiet --manifest-path /tmp/cognacta-ollama-probe/Cargo.toml
cargo run --quiet --manifest-path /tmp/cognacta-provider-comparison/direct-smoke/Cargo.toml
```

Google/AWS 与 aisdk/llm/llmrust 主要做源码审查；没有全 feature 编译、真实 API 历史回放、性能/包体积测量或维护工时估算。本次只增加调研文档，没有引入生产依赖、调整工具链或实现 provider crates。

## Sources

行内来源覆盖官方服务文档、crates.io 元数据与固定发布源码。Rig/OpenAI/Anthropic 等使用发布 commit；Ollama 发布包标记 dirty=true，因此使用 docs.rs 固定包源码，不假设其 Git commit 等于完整发布文件。

[M1]: https://crates.io/api/v1/crates/rig-core
[M2]: https://crates.io/api/v1/crates/aisdk
[M3]: https://crates.io/api/v1/crates/llm
[M4]: https://crates.io/api/v1/crates/llmrust
[R1]: https://github.com/0xPlaygrounds/rig/blob/2d1071e0e0c602f994e9d6cfd8cf5faea6f53650/crates/rig-core/src/wire.rs
[R2]: https://github.com/0xPlaygrounds/rig/blob/2d1071e0e0c602f994e9d6cfd8cf5faea6f53650/crates/rig-core/src/driver.rs
[R3]: https://github.com/0xPlaygrounds/rig/blob/2d1071e0e0c602f994e9d6cfd8cf5faea6f53650/crates/rig-core/src/streaming/event.rs
[R4]: https://github.com/0xPlaygrounds/rig/blob/2d1071e0e0c602f994e9d6cfd8cf5faea6f53650/crates/rig-core/src/completion/message/native.rs
[R5]: https://github.com/0xPlaygrounds/rig/blob/2d1071e0e0c602f994e9d6cfd8cf5faea6f53650/crates/rig-core/src/completion/message.rs
[R6]: https://github.com/0xPlaygrounds/rig/blob/2d1071e0e0c602f994e9d6cfd8cf5faea6f53650/crates/rig-core/src/completion/history.rs
[R7]: https://github.com/0xPlaygrounds/rig/blob/2d1071e0e0c602f994e9d6cfd8cf5faea6f53650/crates/rig-core/src/providers/anthropic/streaming.rs
[R8]: https://github.com/0xPlaygrounds/rig/blob/2d1071e0e0c602f994e9d6cfd8cf5faea6f53650/crates/rig-core/src/providers/anthropic/completion.rs
[R9]: https://github.com/0xPlaygrounds/rig/blob/2d1071e0e0c602f994e9d6cfd8cf5faea6f53650/crates/rig-core/src/providers/gemini/streaming.rs
[R10]: https://github.com/0xPlaygrounds/rig/blob/2d1071e0e0c602f994e9d6cfd8cf5faea6f53650/crates/rig-core/src/providers/gemini/completion.rs
[R11]: https://github.com/0xPlaygrounds/rig/blob/2d1071e0e0c602f994e9d6cfd8cf5faea6f53650/crates/rig-core/src/providers/openai/responses_api/streaming.rs
[R12]: https://github.com/0xPlaygrounds/rig/blob/2d1071e0e0c602f994e9d6cfd8cf5faea6f53650/crates/rig-core/src/operation/completion.rs
[R13]: https://github.com/0xPlaygrounds/rig/blob/2d1071e0e0c602f994e9d6cfd8cf5faea6f53650/crates/rig-core/src/providers/openai/responses_api/mod.rs
[R14]: https://github.com/0xPlaygrounds/rig/blob/2d1071e0e0c602f994e9d6cfd8cf5faea6f53650/crates/rig-core/src/providers/openai/wire/chat.rs
[R15]: https://github.com/0xPlaygrounds/rig/blob/2d1071e0e0c602f994e9d6cfd8cf5faea6f53650/crates/rig-core/Cargo.toml
[R16]: https://github.com/0xPlaygrounds/rig/blob/2d1071e0e0c602f994e9d6cfd8cf5faea6f53650/crates/rig-core/src/client/macros.rs
[R17]: https://github.com/0xPlaygrounds/rig/blob/2d1071e0e0c602f994e9d6cfd8cf5faea6f53650/crates/rig-core/src/error.rs
[R18]: https://github.com/0xPlaygrounds/rig/blob/2d1071e0e0c602f994e9d6cfd8cf5faea6f53650/crates/rig-core/src/completion/request.rs
[A1]: https://github.com/lazy-hq/aisdk/blob/dfc6bb1d83b00f751ef684d05e6eaf192ccd0334/src/core/language_model/mod.rs
[A2]: https://github.com/lazy-hq/aisdk/blob/dfc6bb1d83b00f751ef684d05e6eaf192ccd0334/src/core/client.rs
[A3]: https://github.com/lazy-hq/aisdk/blob/dfc6bb1d83b00f751ef684d05e6eaf192ccd0334/Cargo.toml
[A4]: https://github.com/lazy-hq/aisdk/blob/dfc6bb1d83b00f751ef684d05e6eaf192ccd0334/src/providers/anthropic/language_model.rs
[A5]: https://github.com/lazy-hq/aisdk/blob/dfc6bb1d83b00f751ef684d05e6eaf192ccd0334/src/providers/google/language_model.rs
[A6]: https://github.com/lazy-hq/aisdk/blob/dfc6bb1d83b00f751ef684d05e6eaf192ccd0334/src/providers/anthropic/conversions.rs
[A7]: https://github.com/lazy-hq/aisdk/blob/dfc6bb1d83b00f751ef684d05e6eaf192ccd0334/src/providers/google/conversions.rs
[A8]: https://github.com/lazy-hq/aisdk/blob/dfc6bb1d83b00f751ef684d05e6eaf192ccd0334/src/error.rs
[L1]: https://github.com/graniet/llm/blob/b9a54beaf07d6168cf28a68cb96bfca314b2787b/src/chat/traits.rs
[L2]: https://github.com/graniet/llm/blob/b9a54beaf07d6168cf28a68cb96bfca314b2787b/src/chat/stream.rs
[L3]: https://github.com/graniet/llm/blob/b9a54beaf07d6168cf28a68cb96bfca314b2787b/src/chat/message.rs
[L4]: https://github.com/graniet/llm/blob/b9a54beaf07d6168cf28a68cb96bfca314b2787b/src/backends/anthropic.rs
[L5]: https://github.com/graniet/llm/blob/b9a54beaf07d6168cf28a68cb96bfca314b2787b/Cargo.toml
[U1]: https://github.com/llmrust/llmrust/blob/4ee2b67af6ab9e4577db4d2cca6e6f4fbb6708da/src/types.rs
[U2]: https://github.com/llmrust/llmrust/blob/4ee2b67af6ab9e4577db4d2cca6e6f4fbb6708da/src/providers/anthropic.rs
[U3]: https://github.com/llmrust/llmrust/blob/4ee2b67af6ab9e4577db4d2cca6e6f4fbb6708da/src/providers/mod.rs

[N1]: https://developers.openai.com/api/docs/libraries
[N2]: https://platform.claude.com/docs/en/cli-sdks-libraries/overview
[N3]: https://ai.google.dev/gemini-api/docs/libraries
[N4]: https://github.com/64bit/async-openai/blob/c2deb8880566c3db35979654ea9dd45dc3deffd9/async-openai/src/types/responses/response.rs
[N5]: https://github.com/64bit/async-openai/blob/c2deb8880566c3db35979654ea9dd45dc3deffd9/async-openai/src/types/responses/stream.rs
[N6]: https://github.com/64bit/async-openai/blob/c2deb8880566c3db35979654ea9dd45dc3deffd9/async-openai/Cargo.toml
[N7]: https://github.com/64bit/async-openai/blob/c2deb8880566c3db35979654ea9dd45dc3deffd9/async-openai/src/client.rs
[N8]: https://github.com/64bit/async-openai/blob/c2deb8880566c3db35979654ea9dd45dc3deffd9/async-openai/src/middleware/retry/openai.rs
[N9]: https://github.com/64bit/async-openai/blob/c2deb8880566c3db35979654ea9dd45dc3deffd9/async-openai/src/error.rs
[N10]: https://github.com/blossomstack/async-llm/blob/0ae086c9ba1f5e37d0ee2674cb57678d4d365858/src/anthropic/types.rs
[N11]: https://github.com/blossomstack/async-llm/blob/0ae086c9ba1f5e37d0ee2674cb57678d4d365858/src/anthropic/client.rs
[N12]: https://github.com/ThreatFlux/anthropic_rust_sdk/blob/3abf3cf3fa58fe8afbe8f451f20b4bac1205fd94/src/models/common/content.rs
[N13]: https://github.com/ThreatFlux/anthropic_rust_sdk/blob/3abf3cf3fa58fe8afbe8f451f20b4bac1205fd94/Cargo.toml
[N14]: https://github.com/ThreatFlux/anthropic_rust_sdk/blob/3abf3cf3fa58fe8afbe8f451f20b4bac1205fd94/src/utils/http.rs
[N15]: https://github.com/gaoyia/anthropic-rust-sdk/blob/e75fc7eac5b60c63d25b70ecad033123396fcbf0/src/internal/sse.rs
[N16]: https://github.com/gaoyia/anthropic-rust-sdk/blob/e75fc7eac5b60c63d25b70ecad033123396fcbf0/src/core/streaming.rs
[N17]: https://github.com/katsuhirohonda/anthropic-sdk-rs/blob/4ff44832e08d811d1dbfa2fecefb1f5a249f130f/anthropic-ai-sdk/src/types/message.rs
[N18]: https://docs.rs/anthropic/0.0.8/anthropic/
[N19]: https://github.com/64bit/async-openai/blob/c2deb8880566c3db35979654ea9dd45dc3deffd9/async-openai/src/types/chat/chat_.rs
[G1]: https://docs.rs/crate/gemini-rust/2.1.0/source/src/models.rs
[G2]: https://docs.rs/crate/gemini-rust/2.1.0/source/src/tools/model.rs
[G3]: https://docs.rs/crate/gemini-rust/2.1.0/source/src/client.rs
[G4]: https://docs.rs/crate/genai-rs/0.10.0/source/src/steps.rs
[G5]: https://docs.rs/crate/genai-rs/0.10.0/source/src/client.rs
[G6]: https://docs.rs/crate/genai-rs/0.10.0/source/src/http/sse_parser.rs
[G7]: https://docs.rs/crate/google-cloud-aiplatform-v1/1.17.0/source/src/client.rs
[G8]: https://docs.rs/crate/google-cloud-aiplatform-v1/1.17.0/source/src/transport.rs
[G9]: https://docs.rs/crate/google-cloud-aiplatform-v1/1.17.0/source/src/convert.rs
[G10]: https://docs.rs/crate/google-cloud-auth/1.17.0/source/src/credentials.rs
[G11]: https://docs.rs/crate/gemini-rust/2.1.0/source/src/interactions/model.rs
[G12]: https://docs.rs/crate/gemini-rust/2.1.0/source/README.md
[O1]: https://docs.rs/crate/ollama-rs/0.3.6/source/src/generation/chat/mod.rs
[O2]: https://docs.ollama.com/api/streaming
[B1]: https://docs.rs/crate/aws-sdk-bedrockruntime/1.148.0/source/src/types/_content_block.rs
[B2]: https://docs.rs/crate/aws-sdk-bedrockruntime/1.148.0/source/src/types/_converse_stream_output.rs
[B3]: https://docs.rs/crate/aws-sdk-bedrockruntime/1.148.0/source/src/config.rs
[B4]: https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys-use.html
[B5]: https://docs.aws.amazon.com/sdk-for-rust/latest/dg/http.html
[H1]: https://docs.rs/reqwest/0.13.5/reqwest/struct.Client.html
[H2]: https://docs.rs/reqwest/0.13.5/reqwest/struct.ClientBuilder.html
[H3]: https://docs.rs/reqwest/0.13.5/reqwest/struct.Response.html
[H4]: https://github.com/jpopesculian/eventsource-stream/blob/3d46f1c758f9ee4681e9da0427556d24c53f9c01/src/lib.rs
[H5]: https://github.com/seanmonstar/reqwest/blob/de55373434f07f42926599dbb5a88550d8e55112/src/retry.rs
[H6]: https://github.com/jpopesculian/reqwest-eventsource/blob/ce0b972450fd16a417e2cfbe1cc522feef26545d/Cargo.toml
[H7]: https://github.com/jpopesculian/reqwest-eventsource/blob/ce0b972450fd16a417e2cfbe1cc522feef26545d/src/event_source.rs
[H8]: https://html.spec.whatwg.org/multipage/server-sent-events.html#parsing-an-event-stream
[H9]: https://crates.io/api/v1/crates/eventsource-stream
[H10]: https://github.com/jpopesculian/reqwest-eventsource/blob/ce0b972450fd16a417e2cfbe1cc522feef26545d/src/retry.rs
[H11]: https://github.com/seanmonstar/reqwest/blob/de55373434f07f42926599dbb5a88550d8e55112/Cargo.toml
[B6]: https://docs.rs/aws-smithy-eventstream/0.61.4/aws_smithy_eventstream/frame/index.html
[B7]: https://docs.rs/aws-sigv4/1.6.0/aws_sigv4/http_request/index.html
[B8]: https://docs.aws.amazon.com/sdk-for-rust/latest/dg/credproviders.html
