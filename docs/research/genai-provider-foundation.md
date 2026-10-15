# `genai` 能否作为 Cognacta provider crates 的底层库

调研日期：2026-10-14（Asia/Shanghai）。对象是 Rust [`genai` / `jeremychone/rust-genai`][P1]，不是 Google 的 Python/JavaScript SDK。

## 判断

**可以作为私有的统一执行客户端候选，但不宜直接成为 provider crates 的公共类型体系或可扩展协议底座。** 如果近期只需要常规文本对话、JSON function tools，以及库已支持的 provider，封装整个 `genai::Client` 能省掉不少 HTTP/SSE 和协议映射代码；如果要求完整、无损地保存 reasoning、原生 content blocks、多模态工具结果，或让各 provider crate 独立扩展协议，当前公开 API 与数据映射不够。这个结论是结合下文源码及本地 mock 验证得到的工程判断，不是上游宣称。[R1] [R2] [R3] [R4]

**不要直接采用 stable 0.6.5 承载跨 provider 的 thinking + tools agent loop；也不要把最新 rc 当成已解决全部保真问题。** Stable 的 Anthropic thinking 签名回放明显缺失，rc.4 修了该路径，却仍存在已复现的 OpenAI Chat Completions 同帧多工具调用丢失，以及其他原生内容表示缺口。[S2] [S3] [R3] [R5]

## 仓库背景与版本边界

本仓库目前只有 `cognacta-core` 和 `cognacta-cli` 的 workspace 起点，没有 provider crates、Provider trait、PRD 或已有消息格式。因此这是未来接口的选型评估，不能声称已匹配一个现存 Provider contract。以下按 OpenAI / Anthropic / Gemini / Ollama、流式文本 + reasoning + tools、assistant 回放、usage / stop reason、可配置连接与错误处理评估；这些是评估假设，尚不是已确认的产品必须项。

| 对象 | crates.io 核实结果 | 本次源码基准 |
|---|---|---|
| 最新 stable | `0.6.5`，发布于 2026-06-07 07:03（UTC+8） | 发布包 `.cargo_vcs_info.json`：`660b752fa62b639311e9c89642cbd9ce90565eb7` |
| 最新已发布 prerelease | `0.7.0-rc.4`，发布于 2026-10-08 05:25（UTC+8） | 发布包 `.cargo_vcs_info.json`：`1996eae4e4a8fa80925836684b07a2a01758b102` |
| 最新 beta | `0.7.0-beta.24`，发布于 2026-09-23 08:57（UTC+8） | 已被 rc 超越，不作为“最新版本” |
| GitHub `main` | 检查时 package version 为 `0.7.0-rc.5-WIP` | 未发布，不能当成 rc.4 已有能力 |

来源：直接读取 [crates.io API][P2]、下载已发布 crate，并检查发布包源码及 VCS 信息。两版 license 均为 `MIT OR Apache-2.0`，registry `rust_version` 均为空；不能据此断言明确的 MSRV。[P2] [P3] [P4] 下文链接固定发布 commit，避免跟随 `main` 漂移。

## 1. 它提供完整客户端，不提供外部可插拔的 Adapter

**事实：** `genai` 已实现 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages、Gemini GenerateContent、Ollama native 等协议，以一个 `Client` 和统一请求/响应类型对外。请求可用显式 provider namespace 或 `ModelSpec` 指定目标；这是现成多 provider client 的收益。[R1] [R6]

**事实：** 两版内部 `Adapter` trait、具体 adapters 和 dispatcher 都是 private / `pub(crate)`，公开的 `AdapterKind` 是预定义枚举。外部 crate 不能实现并注册新的 native Adapter，也不能直接使用其各 provider 编解码器来搭建自己的 transport。rc 的 `Custom(u8)` 支持自定义 OpenAI-compatible endpoint，不等于可注册任意 native 协议。[S1] [R1]

**推断：** 若每个 `cognacta-provider-*` 都建立在 genai 上，这些 crate 实际只是整套统一 `Client` 的配置/转换包装，难以获得独立 provider 协议层。若“provider crates”本来就是业务侧独立可替换入口，这可接受；若它们需要拥有各自协议实现，genai 不适合作为那层基座。

| 需要的能力 | stable / rc 可用入口 | 边界 |
|---|---|---|
| 自定义 endpoint、auth、model | `ServiceTargetResolver`、`AuthResolver`、`ModelMapper`、`ModelSpec::Target` | 仍须选择一个内置协议；不是 codec 插件机制。[R6] |
| 每 provider 连接配置 | rc 增加 `append_provider_config` | 内置默认值 → provider config → resolver 覆盖；stable 用 resolver。[R6] [R20] |
| proxy、TLS、连接池、超时 | 注入 `reqwest::Client` / `WebConfig` | 需要与库的 reqwest 0.13 相容；库自己执行请求。[R6] [R21] |
| 自定义 headers / native 参数 | `ChatOptions.extra_headers` / `extra_body` | `extra_body` 是请求 escape hatch，各 adapter 支持情况不同；不能恢复已丢失响应。[R7] |
| 查看原始响应 | nonstream `capture_raw_body`；rc stream `ChatFrameSink` | sink 观察原始 frames，不替换 parser 或规范化事件；补全丢失语义需要自行解析。[R2] [R8] |

`with_adapter_kind` 是路由绑定；显式 `ModelSpec::Target` 等入口仍需结合实际调用约束审查，不能把它表述成 credentials 安全隔离边界。[R6]

### 构建与维护成本

- **没有按 provider 裁剪的 Cargo features。** TLS 可二选一，AWS SigV4 的依赖链可选，rc 另有 `otel`；没有 `openai` / `anthropic` / `gemini` features。独立 provider crate 包装 genai 能隔离业务 API 和配置，却不能隔离其 adapter 的编译。此处不推断最终二进制必然保留所有 adapter，尚未测量包体积或性能。[S8] [R22]
- **许可证适配本仓库，MSRV 没有声明。** 两版 edition 2024、`MIT OR Apache-2.0`，符合当前 `deny.toml` 的许可名单。未声明 `rust-version`；本地 Rust 1.98.1 的默认 features 编译通过，不代表验证了其他工具链或 optional AWS/TLS 组合。[S8] [R22]
- **正在维护，但 API 与发布集中度需计入成本。** 最近发布 rc.4；crates.io owner API 检查时只列 Jeremy Chone。0.7 移除 `Client::default()`，`new()` / `build()` 改为 `Result`，并改变公开字段、enum variants 和序列化行为。试用时精确固定版本、把类型留在私有实现内，升级需明确复查。[P2] [P5] [R23]
- **存在协议回放测试，CI 覆盖有限。** rc.4 workflow 在 Ubuntu + Rust stable 上跑 OpenAI Responses、Gemini、GitHub Copilot、Ollama Cloud、Ollama、AIHubMix 六个 replay targets；该 workflow 没有运行 Anthropic target，也没有 MSRV/TLS/AWS feature matrix。不能据此说库没有测试，也不能把 CI 成功当作所有 provider 正确性证明。[R24]

## 2. 流式输出：常规文本足够，tool chunk 并不是标准 delta contract

两版都有 `Start`、文本 `Chunk`、`ReasoningChunk`、`ThoughtSignatureChunk`、`ToolCallChunk`、`End`；rc 新增 Anthropic `Heartbeat`。`ToolChunk` 只有一个 `ToolCall`，没有公开 block index、tool begin/end 或参数 delta 类型；所有 capture 默认 `false`。[S3] [R2] [R9]

| 协议 | 已核实行为 | 对 Cognacta 的影响 |
|---|---|---|
| OpenAI Chat Completions | 开 `capture_tool_calls` 后 arguments 从字符串片段累积，End 尝试转 JSON；关 capture 时 chunk 可只是当次片段，后续 id/name 可能缺失。普通帧只取 `delta.tool_calls.first()`。[R5] | 不能无条件把 chunk 当可 append 的 delta；同帧并行多个调用会丢，详见运行验证。 |
| OpenAI Responses | 用 `output_index` 内部累计 function/custom tool input；公开 chunk 是累计字符串，End 尝试解析 function args。支持 reasoning text 与 reasoning summary，两者统一成 `ReasoningChunk`。[R10] | 输出方便，但 raw reasoning 与 summary 的语义被合并；没有公开 output item 全结构。 |
| Anthropic | `tool_use` start 发空字符串；`partial_json` 后发累计字符串；block stop 只完成最终 capture，不发布一个独立完成事件。[S2] [R3] | 显示进度可以用 chunk；执行应等待最终完整 calls 并校验 JSON，不能见 chunk 就执行。 |
| Gemini GenerateContent | 从各 response `functionCall` part 产生已解码 JSON 的 ToolCall；不是细粒度 JSON 参数文本流。流中 binary 明确被忽略。[R4] [R11] | 不存在所有 provider 统一的参数文本 delta / 多模态 stream。 |
| Ollama native | stable 同一 NDJSON 行的 thinking/content/tools 存在提前 return，且多个 calls 只发首个；rc 用 queue 发全部事件并保留最终 done 行。[S4] [R12] | 对 native Ollama agent stream，rc 是显著改善，stable 不能假设每行全部字段可见。 |

**推断：** 首次接入应把 UI 的“工具调用更新”定义成 snapshot/update，并在 End 从完整结果取得可执行调用。如果核心一定要按 index 的原生 argument deltas、content block 生命周期或提前执行，需要更底层协议实现；仅改类型名无法补回 genai 已丢掉的数据。

## 3. Assistant 回放与 tool result：版本差异比“支持 tools”更关键

### Stable 0.6.5 的明确缺口

- Anthropic nonstream `thinking` 只取 thinking text，不保留 signature；assistant request 映射忽略 `ThoughtSignature` / `ReasoningContent` / `Custom`；stream 虽向用户发 signature chunk，End 却 `captured_thought_signatures: None`。不能依靠统一结果安全回放 signed thinking。[S2] [S7]
- Anthropic stream 的 `event: error` 没有专门错误分支，仅落到 unknown-event warning；rc.4 已向调用方传播错误。Stable 的 client builder 另有 HTTP client 初始化 `expect`，rc 改为返回 `Result`。这两点使“稳定版”标签不足以作为 agent loop 选型依据。[S7] [S9] [R3] [R6]
- `StreamEnd::into_assistant_message_for_tool_use()` 只抽 signatures 和 tool calls，忽略 assistant text 等其他 parts，再附 reasoning text；使用这个 helper 会丢当轮 assistant 文本。[S3]
- Gemini 把所有 signatures 提到前方并挂到 first tool call，失去签名原 part 的关联；这不是完整签名回放，rc 修了多工具/文本与 call 配对。[S5] [R4]

这些缺口与 provider protocol 有关：Claude thinking/tools 要完整回传 thinking 与 redacted blocks；Gemini 要把 signature 放回收到的对应 part。签名不是可丢弃的 UI metadata。[O1] [O2]

### rc.4 的改善和剩余边界

| 项目 | rc.4 已核实支持 | 仍未覆盖 |
|---|---|---|
| Anthropic signed thinking | 逐 thinking block 累积 signature/text；启用 `capture_reasoning_content` 后保留配对 blocks；请求重建 signed thinking；新 `ChatResponse` helper 与修订后的 `StreamEnd` helper 保留整个 captured content。[R2] [R3] | streamer 没有 `redacted_thinking` 分支，未知 content start 仅警告跳过；nonstream 未知 blocks 作为 Custom 可回传，流/非流不对称。[R3] [R13] |
| Gemini signatures | nonstream 保留原 parts 顺序，每个 ToolCall 镜像其签名；assistant serializer 按 part/call 放回。[R4] | stream 聚合 text/thoughts，再由统一 End 重排，不是原始完整 parts；assistant Binary / Custom 被忽略。[R2] [R4] [R11] |
| OpenAI Responses continuity | stream 可捕获 encrypted reasoning，并用 `ThoughtSignature` 回传；支持 `response_id` / `previous_response_id` 和显式 `store`。[R10] [R14] | nonstream decoder 的 `reasoning_content` 固定为 None，output converter 只处理 Message / FunctionCall / CustomToolCall，reasoning item 不进入统一 content。[R14] [R15] |
| 全 assistant 原生内容 | 文本、calls、部分 reasoning 元数据有规范化表示 | Responses message phase / annotations / refusal / native tool items 不完整；Gemini binary stream/assistant 回放缺失；统一结果不是无损 wire history。[R4] [R11] [R15] |
| Tool result | `ToolResponse { call_id, fn_name?, content: String }`；`from_tool_call` 保留 name，适配 Gemini functionResponse。[R16] | 没有通用 `is_error`、图片/文件/多 content parts 的工具结果；JSON 输出也是 String。[R16] |

Anthropic rc 可以经 `ContentPart::Custom` 发送原生 `tool_result`（含 `is_error` 或多模态），但 Gemini / Responses 会在相关分支忽略 Custom；不能称为跨 provider 的通用 tool-result escape hatch。[R4] [R13] [R14]

**推断：** 自己的持久化历史若直接存 genai DTO，会继承以上丢失与版本变更；若本产品确实需要无损回放，core 应存原生 opaque blocks/continuation 信息，provider 负责映射，显示用 reasoning text 与下一轮必需的签名需分别处理。`extra_body`/raw sink 可以做局部补丁，但一旦需要自己重建多家完整 histories，使用 genai 节省的协议代码会变少。

### 停止原因、usage 与错误

`Usage` 统一 prompt/completion/total，以及部分 cache/reasoning details；`StopReason` 保留 provider 原字符串，但 Responses `incomplete` 一律映射 `MaxTokens`，没有 `incomplete_details` 的细分原因；tool execution 应查看 calls，而不是只凭 `StopReason::ToolCall`。[R17] [R10]

错误区分 HTTP、transport、JSON；provider stream error 的传播仍取决于 adapter 与版本。rc 增加 `status()` / `headers()`、stream HTTP failure headers、header/read timeouts；stable 的 stream HTTP error 没有 headers。成功 `ChatResponse` 没有 response headers，不能从统一响应取 request id / rate-limit headers。[R7] [R18] [R19] [R25] [S6]

库没有跨 provider 的自动重试/取消策略。应用可以处理状态/headers、约束重试，并通过取消消费/丢弃 stream 结束工作；已见部分输出之后重新请求不等同于续传。是否要补 retry/cancellation API，由真实使用需求决定。[R18] [R19]

## 4. 运行验证与证据限度

本次已在临时 harness 中用 Rust `1.98.1` 编译 crates.io exact `genai = "=0.7.0-rc.4"`，经本地 HTTP/SSE 服务验证公开 `Client::exec_chat_stream`，未使用外部 API key：

| mock 场景 | 预期 / 实际 |
|---|---|
| 单 call 两 frame，args 先 `{"x":` 再 `1}`，开启 capture | 第二个 ToolCallChunk arguments 是完整累计 String `{"x":1}`；End 是 JSON object。验证了 chunk snapshot 与最终 JSON 差异。 |
| 同一个普通 SSE frame 放 `index: 0 / call_a` 与 `index: 1 / call_b` | 预期 2 calls；公开 events 与 End captured calls 都只有 1，`call_b` 被丢弃。与 streamer 的 `.first()` 分支一致。[R5] |

该验证证明依赖在本仓库工具链可编译，并复现具体 parser 行为；不证明真实模型服务、network retry 或所有 provider 都已集成兼容。完整 harness 位于临时目录 `/tmp/cognacta-genai-evaluation/smoke`，不加入生产 workspace；可运行 `cargo run --quiet --manifest-path /tmp/cognacta-genai-evaluation/smoke/Cargo.toml` 重复本地验证。

## 5. 建议的最小接入决策

| 近期实际需求 | 选择 |
|---|---|
| 普通聊天、文本 streaming、单个 JSON tool call，接受库现有 provider 能力 | 值得用整套 Client 做一个私有 genai backend；不要给每家复制一套同样的壳。 |
| 多 provider thinking + tools、并行调用、恢复历史 | 先修/等待上述 parser 与回放缺口，再验证 rc 或后续 stable；不直接将 0.6.5 当通用基线。 |
| provider crate 要独立加原生协议、新 native events、完整多模态工具结果、无损 history | 直接拥有该 provider 的 native 适配更合适；genai 的 private Adapter 不能承担外部插件底座。 |

这些是条件化建议，不要求现在创建所有 provider crates。若决定试用，最小边界是：Cognacta 自有 request/event/result → 私有 genai mapper → `genai::Client`；genai 的 `ChatMessage`、`AdapterKind`、`Error` 等不进入 core 的公共接口。每种真实需要的能力再加一个明确检查，不先建完整 capability 框架。

接入前的最小验收范围应包含：一个并行 call 帧、text + tool + signed thinking 的下一轮请求、Anthropic redacted block、Gemini signature 配对、tool result 错误/多模态（若需要）、429 headers、midstream failure / incomplete。沿用一个可回放 fixture harness 足够，无需先加大型框架。流式 capture 显式打开 usage/content/reasoning/tools；最终工具参数校验后才执行，签名原样保存；凡数据缺口未被产品范围排除，都不能视为接入完成。[R9] [O1] [O2] [O3]

如果首版选择试用，候选依赖是 `genai = "=0.7.0-rc.4"`，且应先处理已复现的并行调用丢失。RC 的原始帧 sink 可以辅助诊断或局部适配，但若每家都需要自己重写解析与回放，就应重新评估直接采用各家原生协议实现的成本。本次只新增调研记录，没有修改 Cargo 或实现 provider。

## Sources

关键入口：[发行元数据][P2]、[内部 Adapter 边界][R1]、[Chat Completions 流解析][R5]、[工具结果类型][R16]、[0.6→0.7 迁移说明][R23]。其余行内链接对应固定发布 commit 的具体源码及 provider 官方协议文档。

[P1]: https://github.com/jeremychone/rust-genai
[P2]: https://crates.io/api/v1/crates/genai
[P3]: https://crates.io/crates/genai/0.6.5
[P4]: https://crates.io/crates/genai/0.7.0-rc.4
[P5]: https://crates.io/api/v1/crates/genai/owners
[S1]: https://github.com/jeremychone/rust-genai/blob/660b752fa62b639311e9c89642cbd9ce90565eb7/src/adapter/mod.rs
[S2]: https://github.com/jeremychone/rust-genai/blob/660b752fa62b639311e9c89642cbd9ce90565eb7/src/adapter/adapters/anthropic/adapter_shared.rs
[S3]: https://github.com/jeremychone/rust-genai/blob/660b752fa62b639311e9c89642cbd9ce90565eb7/src/chat/chat_stream.rs
[S4]: https://github.com/jeremychone/rust-genai/blob/660b752fa62b639311e9c89642cbd9ce90565eb7/src/adapter/adapters/ollama/streamer.rs
[S5]: https://github.com/jeremychone/rust-genai/blob/660b752fa62b639311e9c89642cbd9ce90565eb7/src/adapter/adapters/gemini/adapter_impl.rs
[S6]: https://github.com/jeremychone/rust-genai/blob/660b752fa62b639311e9c89642cbd9ce90565eb7/src/error.rs
[S7]: https://github.com/jeremychone/rust-genai/blob/660b752fa62b639311e9c89642cbd9ce90565eb7/src/adapter/adapters/anthropic/streamer.rs
[S8]: https://github.com/jeremychone/rust-genai/blob/660b752fa62b639311e9c89642cbd9ce90565eb7/Cargo.toml
[S9]: https://github.com/jeremychone/rust-genai/blob/660b752fa62b639311e9c89642cbd9ce90565eb7/src/client/builder.rs
[R1]: https://github.com/jeremychone/rust-genai/blob/1996eae4e4a8fa80925836684b07a2a01758b102/src/adapter/mod.rs
[R2]: https://github.com/jeremychone/rust-genai/blob/1996eae4e4a8fa80925836684b07a2a01758b102/src/chat/chat_stream.rs
[R3]: https://github.com/jeremychone/rust-genai/blob/1996eae4e4a8fa80925836684b07a2a01758b102/src/adapter/adapters/anthropic/streamer.rs
[R4]: https://github.com/jeremychone/rust-genai/blob/1996eae4e4a8fa80925836684b07a2a01758b102/src/adapter/adapters/gemini/adapter_impl.rs
[R5]: https://github.com/jeremychone/rust-genai/blob/1996eae4e4a8fa80925836684b07a2a01758b102/src/adapter/adapters/openai/streamer.rs
[R6]: https://github.com/jeremychone/rust-genai/blob/1996eae4e4a8fa80925836684b07a2a01758b102/src/client/builder.rs
[R7]: https://github.com/jeremychone/rust-genai/blob/1996eae4e4a8fa80925836684b07a2a01758b102/src/chat/chat_options.rs
[R8]: https://github.com/jeremychone/rust-genai/blob/1996eae4e4a8fa80925836684b07a2a01758b102/src/chat/frame_sink.rs
[R9]: https://github.com/jeremychone/rust-genai/blob/1996eae4e4a8fa80925836684b07a2a01758b102/src/adapter/adapters/support.rs
[R10]: https://github.com/jeremychone/rust-genai/blob/1996eae4e4a8fa80925836684b07a2a01758b102/src/adapter/adapters/openai_resp/streamer.rs
[R11]: https://github.com/jeremychone/rust-genai/blob/1996eae4e4a8fa80925836684b07a2a01758b102/src/adapter/adapters/gemini/streamer.rs
[R12]: https://github.com/jeremychone/rust-genai/blob/1996eae4e4a8fa80925836684b07a2a01758b102/src/adapter/adapters/ollama/streamer.rs
[R13]: https://github.com/jeremychone/rust-genai/blob/1996eae4e4a8fa80925836684b07a2a01758b102/src/adapter/adapters/anthropic/adapter_shared.rs
[R14]: https://github.com/jeremychone/rust-genai/blob/1996eae4e4a8fa80925836684b07a2a01758b102/src/adapter/adapters/openai_resp/adapter_impl.rs
[R15]: https://github.com/jeremychone/rust-genai/blob/1996eae4e4a8fa80925836684b07a2a01758b102/src/adapter/adapters/openai_resp/resp_types/resp_output_helper.rs
[R16]: https://github.com/jeremychone/rust-genai/blob/1996eae4e4a8fa80925836684b07a2a01758b102/src/chat/tool/tool_response.rs
[R17]: https://github.com/jeremychone/rust-genai/blob/1996eae4e4a8fa80925836684b07a2a01758b102/src/chat/chat_response.rs
[R18]: https://github.com/jeremychone/rust-genai/blob/1996eae4e4a8fa80925836684b07a2a01758b102/src/error.rs
[R19]: https://github.com/jeremychone/rust-genai/blob/1996eae4e4a8fa80925836684b07a2a01758b102/src/webc/error.rs
[R20]: https://github.com/jeremychone/rust-genai/blob/1996eae4e4a8fa80925836684b07a2a01758b102/src/client/config.rs
[R21]: https://github.com/jeremychone/rust-genai/blob/1996eae4e4a8fa80925836684b07a2a01758b102/src/client/web_config.rs
[R22]: https://github.com/jeremychone/rust-genai/blob/1996eae4e4a8fa80925836684b07a2a01758b102/Cargo.toml
[R23]: https://github.com/jeremychone/rust-genai/blob/1996eae4e4a8fa80925836684b07a2a01758b102/docs/migration/migration-v_0_6_to_0_7.md
[R24]: https://github.com/jeremychone/rust-genai/blob/1996eae4e4a8fa80925836684b07a2a01758b102/.github/workflows/yakbak-replay-tests.yml
[R25]: https://github.com/jeremychone/rust-genai/blob/1996eae4e4a8fa80925836684b07a2a01758b102/src/webc/web_client.rs
[O1]: https://platform.claude.com/docs/en/build-with-claude/thinking
[O2]: https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures
[O3]: https://developers.openai.com/api/docs/guides/reasoning
