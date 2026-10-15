# reqwest 流式分帧库选型

调研日期：2026-10-14（Asia/Shanghai）。用户已确认 HTTP 底层采用 `reqwest`；本次比较分帧库，不重新选择完整 LLM SDK。版本取 crates.io 当日发布记录，源码取相应 `.crate`，没有用 GitHub main 代替发布版；临时检查以 Rust 1.98.1 和 `reqwest = "=0.13.5"` 编译。

用户指定的 LaunchDarkly 库另见 [rust-eventsource-client 适配评估](rust-eventsource-client.md)：`0.18.1` 已能通过自写 `HttpTransport` 接 reqwest，但没有公开纯 decoder，需使用其连接管理客户端。本地 POST / 分块 / 重连检查已验证，默认 SSE 分帧候选仍保留 `sse-core`。

## 建议组合

| 协议 | 默认候选 | 接 reqwest 的方式 | provider 仍须处理 |
| --- | --- | --- | --- |
| SSE | `sse-core 0.2.3` | `bytes_stream()` → `SseStream`；features 仅 `std/stream` | JSON、原生事件、工具片段、终止标志；首个错误结束请求 |
| NDJSON | `tokio-util 0.7.20` | `bytes_stream()` → `StreamReader` → `FramedRead<LinesCodec>`；features `io/codec` | 每行 JSON、空行/末行策略、业务终止；配置行上限 |
| Amazon EventStream | `aws-smithy-eventstream 0.61.4` | `bytes_stream()` → 有界 byte buffer → 官方二进制 codec | EOF/缓冲预算、event/exception/error 映射、业务终止；认证另行实现 |

这是本次调研后的选型建议，尚未添加生产依赖。三个 decoder 都能与 reqwest 0.13.5 配合，不要求让 HTTP client 自动重发生成请求。通用分帧只还原完整事件或行；模型内容、工具聚合和错误语义由各 provider 解释。

## 测试数据从哪里来

**本次没有抓取线上模型响应，也没有调用真实 provider。** 数据来源和验证范围如下。

| 数据组 | 来源 | 实际验证范围 |
| --- | --- | --- |
| SSE | 按 [WHATWG 解析规则](https://html.spec.whatwg.org/multipage/server-sent-events.html#parsing-an-event-stream)手写 16 组 byte fixtures；预期输出也手工指定 | 多行/空 data、BOM、LF/CRLF/裸 CR、未知字段、Unicode、非法 UTF-8、EOF；固定 chunk 大小 `1..=输入长度`，块间强制 `Poll::Pending` |
| NDJSON | 按 [NDJSON 规范](https://github.com/ndjson/ndjson-spec/blob/master/README.md)构造 JSON 行；额外手写坏 JSON、非法 UTF-8、超长行及 `done` 示例 | byte 分块、行上限、空行/末行、错误传播、懒读取、取消后继续读取；`done` 示例只检查本地完成策略 |
| EventStream 上游向量 | AWS 发布的 [`aws-smithy-eventstream 0.61.4/test_data`](https://docs.rs/crate/aws-smithy-eventstream/0.61.4/source/test_data/) 原始二进制文件 | 全部 header 类型，以及损坏的 prelude/message CRC、header length/name/type/string length；本次用了其中 7 个文件，未声称运行整个上游测试集 |
| EventStream 补充数据 | 手工构造 `Message` 后用同库 `write_message_to` 编码；另手工构造/修改长度和 CRC | 任意固定 chunk 大小、所有 EOF 截断位置、异常/error frame、未知二进制 header；编码/解码 roundtrip 属于同库自检，不是独立正确性证明 |
| 本地 HTTP mock | NDJSON 与 EventStream harness 在 `127.0.0.1` 启动临时 TCP server，发送上述构造数据 | 真实 reqwest body 接入、HTTP metadata、Content-Length 未送完时的 body error；网络可能合并写入，所以 chunk 边界另用确定性 fixtures 检查 |

SSE 的 reqwest 接入只做了类型/`Send` 编译检查，本轮没有单独运行 SSE HTTP mock。上述检查支持分帧边界与错误处理的判断，不证明完整规范一致性、真实服务兼容性或性能；没有运行完整 conformance suite、fuzz、benchmark 或长时间压测。

可直接核对当前临时源码：[SSE fixtures](/tmp/cognacta-framing-sse/smoke/src/main.rs:52)、[NDJSON tests](/tmp/cognacta-framing-ndjson/src/lib.rs)、[EventStream tests](/tmp/cognacta-framing-eventstream/probe/src/main.rs:96)。这些目录在 `/tmp`，可能被清理；重跑命令见各节，EventStream 还需要同目录下解压的固定版本发布包。持久的一手来源链接保留在报告中。

## SSE：首选 sse-core，保留 sse-stream 作为严格解析备选

**默认建议 `sse-core 0.2.3`，关闭默认 feature，仅开 `std` / `stream`。** 它没有网络 I/O，不依赖 reqwest / HTTP 类型，直接接受 `Response::bytes_stream()`；`SseDecoder` 自带可调的缓冲大小限制，默认 512 KiB，省去自己再写一层保护。它随包提供重试配置工具，但 `SseStream` 不发请求、也不自动重连。[S1] [S2]

**需要严格 UTF-8 错误、区分显式 metadata 或保留 metadata-only blocks 时，选 `sse-stream 0.3.0` 的 `SseByteStream`。** 它也直接接受 reqwest byte stream，默认忽略未知字段，错误只返回一次并终止；但没有 hard frame-size 限制。其 64 KiB 是一次事件或缓冲行完成后保留的 scratch capacity 上限，不是输入大小上限。[S3] [S4]

这里的取舍是工程建议：优先采用已有大小限制、接口简单的 decoder；若项目后来要求严格拒绝无效 UTF-8，必须重新选择或补边界校验，不能把 `sse-core` 的 replacement 行为误认为严格验证。

### 当前发布版与依赖边界

| 库 | 最新版本；发布日 UTC | MSRV / 许可证 | 与 reqwest 的关系及定位 |
| --- | --- | --- | --- |
| `sse-core` | `0.2.3`；2026-07-31 | 声明 1.79.0；MIT OR Apache-2.0 | 无 HTTP 依赖；同步 `SseDecoder` + optional `SseStream`。默认 features 带 `fastrand/std/stream`；这里只需 `std/stream`。 |
| `sse-stream` | `0.3.0`；2026-09-18 | 未声明 MSRV；MIT OR Apache-2.0 | 纯 decoder/encoder；byte API 无 reqwest 版本耦合，crate 本身带 `http-body 1` / `http-body-util 0.1`。默认 `memchr/simdutf8`；勿开启 `strict-fields`，否则未知 SSE 字段报错。 |
| `sseer` | `0.3.0`；2026-05-31 | 未声明 MSRV，edition 2024；MIT OR Apache-2.0 | 默认无 features 的 `EventStream` 无 HTTP 依赖；`reqwest` feature 额外启用 reqwest 0.13 和带自动重连的 `EventSource`。 |
| `eventsource-stream` | `0.2.3`；2022-02-17 | 未声明 MSRV；MIT OR Apache-2.0 | 纯 `Stream<Result<AsRef<[u8]>, E>>` parser，无运行时 reqwest 依赖；当前发布版存在下述复现问题。 |
| `reqwest-sse` | `0.2.0`；2026-05-08 | 未声明 MSRV，edition 2024；MIT | 绑定 reqwest 0.13 的 `Response::events()`，不自动重连；但当前 parser 的规范边界不足。 |
| `reqwest-eventsource` | `0.6.0`；2024-03-29 | 未声明 MSRV；MIT OR Apache-2.0 | 绑定 reqwest 0.12，默认自动重连；底层依赖旧 `eventsource-stream 0.2.3`。 |

上表版本、features、依赖和许可证以发行元数据及发布 Cargo.toml 为依据；未声明 MSRV 不等于兼容任意旧 Rust。本地仅验证仓库使用的 1.98.1。上述 MIT / Apache-2.0 均在当前 `deny.toml` allow list。[S5] [S6] [S7] [S8] [S9] [S10]

### 关键语义：两个首选不是完全相同的接口

| 行为 | sse-core 0.2.3 | sse-stream 0.3.0 |
| --- | --- | --- |
| 多行 `data` / 空 `data` | LF 拼接；空 data 也产生 Message | LF 拼接；`data: None` 与 `Some("")` 区分 |
| BOM / LF / CRLF / 裸 CR / UTF-8 跨 chunk | 已通过本地 fixture | 已通过本地 fixture |
| 未知 field / comment | 跳过，长行不积攒 payload | 默认跳过；comment 默认不积攒，其他未知长行可进入 pending buffer |
| `event` / `id` | `event` 默认 message，id 跨消息继承；空 id 清除 | 只保留本 block 的显式值，不继承；显式空 event 是 `Some("")` |
| metadata-only block | 不产生 Message；有效 retry 独立产出 `Retry(u32)` | 产出 raw `Sse`，`data` 可为 None |
| 非法 UTF-8 | 按 SSE/WHATWG 解码语义替换为 `�` | recognized value 报 `Utf8Parse`；未知 field 默认仍忽略 |
| 上游错误 | `SseStreamError::Inner(E)` 保留原类型；之后仍可继续 poll | `Error::Body(Box<dyn Error + Send + Sync>)` 保留 source，可 downcast；报一次后终止 |
| 缓冲上限 | data、event name、id 各有独立 limit；默认各 512 KiB，可设 `NonZeroUsize` | 无 hard limit；完成后的 scratch capacity 最多各留 64 KiB |
| 超限 | 丢弃整个 offending event，返回错误，后续能恢复 | 无内置超限错误 |
| 不完整 EOF | 丢弃未完成 block，不自行报 truncated | 丢弃未完成 block，不自行报 truncated |

接口和状态行为依据发布源码。[S2] [S4] [S11] [S12]

SSE 分帧成功不等于模型响应完整：两者都会按 SSE 规则丢掉没有最后空行的 block。provider 仍应检查 `[DONE]`、`message_stop`、`response.completed` 等各协议终止标志；EOF 时未见预期终止事件，应报告截断，而不是当作成功。终止标志的具体选择留在对应 provider。

对 `sse-core`，收到任何 parser 或 transport 错误时，LLM provider 应通过 `?` / 显式 return 终止当前 generation；库允许恢复是 SSE 通用能力，不意味着我们应该跳过坏消息继续生成。`Retry` 也只是服务器提示，generation 路径忽略，不据此重新发送 POST。

comments heartbeat 不必全部透出业务事件。网络读超时可放在 reqwest 层，收到原始 bytes 就是活动；如果另外按“业务事件间隔”计 idle，注意丢弃的 comments / metadata-only blocks 不会重置那种计时。

### 实际验证

独立临时 harness 在 `/tmp/cognacta-framing-sse/smoke/`，精确锁四个版本和 reqwest 0.13.5。对每个 fixture 尝试固定 chunk 大小 `1..=输入长度`，每个 chunk 之间强制一次 `Poll::Pending`；没有依赖 socket 通常如何切包。另做 reqwest API 类型编译检查：`sse-core`、`sse-stream`、`sseer` 能接受 `Response::bytes_stream()`，且 adapter 为 `Send`；这些检查函数未实际发送 HTTP 请求。

| Fixture | sse-core | sse-stream | sseer | eventsource-stream |
| --- | --- | --- | --- | --- |
| 普通 / 多行含空行 / 空 data / 未知字段 | 通过 | 通过 | 通过 | 通过 |
| CRLF 跨 chunk / Unicode 跨 chunk | 通过 | 通过 | 通过 | 通过 |
| 完整事件以 `\r\r` 结束并 EOF | 通过 | 通过 | 通过 | 所有测试 chunk 大小丢失事件 |
| leading BOM，包括逐字节切块 | 通过 | 通过 | 通过 | 所有测试 chunk 大小 panic |
| `event: old\nevent\ndata: hi\n\n` | 清除旧类型 | raw 空类型，按 API 正确 | 错误保留 old | 清除旧类型 |
| `retry: +1` | 忽略 | 忽略 | 错误接受为 1 ms | 错误接受为 1 ms |
| 未结束 block EOF / comment heartbeat | 丢弃 / 忽略 | 丢弃 / 忽略 | 丢弃 / 忽略 | 丢弃 / 忽略 |
| metadata-only ping | 不产 Message | 返回 `data: None` 的 raw block | 不产事件 | 不产事件 |
| 无效 UTF-8 的 data | 替换字符 | 错误且终止 | 错误 | 最终 UTF-8 错误 |
| 无效 UTF-8 的未知字段，后接有效 data | 忽略未知字段，data 正常 | 忽略未知字段，data 正常 | 仍报 UTF-8 错误 | 仍报 UTF-8 错误 |

另用断言验证 `sse-core` 自定义 8-byte limit 拒绝 9-byte data；`sse-stream` 的源错误仍可 downcast，并且 next 立即为 None。对两个首选的规范 fixture 保留断言；旧候选缺陷输出用于比较，不将其不符合预期的行为当成通过。

重跑：

```sh
cargo run --offline --locked --manifest-path /tmp/cognacta-framing-sse/smoke/Cargo.toml
```

这是边界 fixture 和编译检查，没有真实 provider 联调、长时间 soak 或性能 benchmark；不据此宣称覆盖完整 WHATWG 测试集。

### 为什么不选几个更直观的名字

`eventsource-stream 0.2.3` 的 BOM 分支先判断 Unicode BOM，再做 `&string[1..]`；BOM 占 3 bytes，这个索引切在 UTF-8 字符中间，导致 panic。本次实际复现。它也将末尾裸 CR 留在 streaming parser，而 EOF 不补处理，导致已经完整的 CR 分隔事件丢失。[S13]

`sseer 0.3.0` 修好了 BOM 和裸 CR，但无 colon 的 `event` 被忽略而非置空，且 retry 使用整数 `parse()` 接受 `+1`；未知字段值也先做 UTF-8 验证。这些是发布版源码与 fixture 一致的行为。不是性能问题，暂不优先选它。[S14] [S15]

`reqwest-sse 0.2.0` 的 `Response::events()` 很方便，但逐行 `read_line` 后只去掉 `\n`，留下 `\r`，因此 CRLF 的“空行”无法触发 dispatch；也未处理 leading BOM，且通过 `data.is_empty()` 判断有无 data，把空 data 与缺少 data 混在一起。该结论来自发布源码，未单独运行其 HTTP fixture。[S16]

`reqwest-eventsource` 和 `sseer::EventSource` 的默认模式会克隆请求并重连。它们适合可恢复的订阅，但把 generation POST 再发一次可能启动另一笔生成；本次应直接选纯 decoder。`reqwest-sse` 虽不自动重连，也不能因此忽略上述解析边界。[S10] [S17]

### SSE 一手来源

- [S1] [sse-core 0.2.3 文档](https://docs.rs/sse-core/0.2.3/sse_core/)
- [S2] [sse-core 发布版 decode.rs：大小限制、UTF-8、字段状态](https://docs.rs/crate/sse-core/0.2.3/source/src/decode.rs)
- [S3] [sse-stream 0.3.0 文档](https://docs.rs/sse-stream/0.3.0/sse_stream/)
- [S4] [sse-stream 发布版 stream.rs：直接接 bytes stream、终止及源错误](https://docs.rs/crate/sse-stream/0.3.0/source/src/stream.rs)
- [S5] [sse-core crates.io 发布元数据](https://crates.io/api/v1/crates/sse-core/0.2.3)
- [S6] [sse-stream crates.io 发布元数据](https://crates.io/api/v1/crates/sse-stream/0.3.0)
- [S7] [sseer crates.io 发布元数据及 features](https://crates.io/api/v1/crates/sseer/0.3.0)
- [S8] [eventsource-stream crates.io 发布元数据](https://crates.io/api/v1/crates/eventsource-stream/0.2.3)
- [S9] [reqwest-sse 0.2.0 发布版 Cargo.toml](https://docs.rs/crate/reqwest-sse/0.2.0/source/Cargo.toml)
- [S10] [reqwest-eventsource 0.6.0 发布版 Cargo.toml](https://docs.rs/crate/reqwest-eventsource/0.6.0/source/Cargo.toml)
- [S11] [sse-core 发布版 Stream：原 transport 错误及恢复](https://docs.rs/crate/sse-core/0.2.3/source/src/stream.rs)
- [S12] [sse-stream 发布版 parser：raw block、字段、BOM、CR](https://docs.rs/crate/sse-stream/0.3.0/source/src/stream/parser.rs)
- [S13] [eventsource-stream 发布版 EventStream：BOM 字节切片](https://docs.rs/crate/eventsource-stream/0.2.3/source/src/event_stream.rs)
- [S14] [sseer 发布版 EventBuilder：colonless event 与 retry](https://docs.rs/crate/sseer/0.3.0/source/src/event_stream.rs)
- [S15] [sseer 发布版 parser：未知 field 值验证](https://docs.rs/crate/sseer/0.3.0/source/src/parser.rs)
- [S16] [reqwest-sse 发布版实现：read_line、data、dispatch](https://docs.rs/crate/reqwest-sse/0.2.0/source/src/lib.rs)
- [S17] [reqwest-eventsource 发布版默认 retry policy](https://docs.rs/crate/reqwest-eventsource/0.6.0/source/src/retry.rs)
- [S18] [WHATWG SSE 解析与解释规则](https://html.spec.whatwg.org/multipage/server-sent-events.html#parsing-an-event-stream)

## NDJSON：首选 tokio-util 的有界 LinesCodec

**用 `StreamReader + FramedRead + LinesCodec::new_with_max_length`，JSON 解码留在 provider。** `tokio-util 0.7.20` 只需 `io/codec` features，reqwest 开 `stream`。仓库已声明 Tokio，但尚未直接声明 tokio-util；这不是已有生产实现。[发布 manifest](https://github.com/tokio-rs/tokio/blob/5ec9e6b8d5a7111fe9cd35a637bd8b4e4eb1e483/tokio-util/Cargo.toml)、[StreamReader](https://github.com/tokio-rs/tokio/blob/5ec9e6b8d5a7111fe9cd35a637bd8b4e4eb1e483/tokio-util/src/io/stream_reader.rs)

在检查 HTTP status、保存所需 headers 并处理非成功 error body 后，连接方式为：

```rust
use futures_util::TryStreamExt;
use std::io;
use tokio_util::{
    codec::{FramedRead, LinesCodec},
    io::StreamReader,
};

let body = response.bytes_stream().map_err(io::Error::other);
let lines = FramedRead::new(
    StreamReader::new(body),
    LinesCodec::new_with_max_length(MAX_LINE_BYTES),
);
```

`MAX_LINE_BYTES` 是 provider 的配置/常量，具体值按响应需求确定。本段只是 API 连接示例，未写入生产代码。

### 候选比较

| 候选 | 当前版本 / MSRV / 许可证 | 取舍 |
| --- | --- | --- |
| `tokio-util` | 0.7.20 / 1.85 / MIT | 官方通用 codec；能设每行字节上限，JSON 与 transport 错误由调用方处理 |
| Tokio `AsyncBufReadExt::lines()` | Tokio 1.53.3 / 1.71 / MIT | 更少组合，但没有行上限；`next_line` 取消安全，单次 `read_line` 不取消安全 |
| `serde-jsonlines` | 0.7.0 / 1.74 / MIT | async API 包装 Tokio 行读取及 serde；无行上限，单次 `read()` 使用 `read_line` |
| `json-lines` | 0.1.2 / 未声明 / MIT OR Apache-2.0 | 无行上限；JSON 错误细节丢成 `DeserializeJson`，无 LF 末行报 trailing-bytes IO error |
| `ndjson-stream` | 0.1.0 / 未声明 / MIT OR Apache-2.0 | 无大小上限；默认 `parse_rest=false`，丢弃无 LF 末尾 |
| `reqwest-streams` | 0.20.0 / 1.85 / Apache-2.0 | `json_nl_stream(max_obj_len)` 是可用备选，支持 reqwest 0.13；底层同样包装 LinesCodec，只做 LLM 分帧时通用组合已足够 |

取舍依据：[Tokio lines](https://github.com/tokio-rs/tokio/blob/a85c3f5baa298a6b554fd3700daf0342289881af/tokio/src/io/util/lines.rs)、[serde-jsonlines async](https://github.com/jwodder/serde-jsonlines/blob/cbed1b8edb6be397794266101d53ba5b565d5c6f/src/asynclib.rs)、[json-lines codec](https://github.com/strawlab/json-lines/blob/27547ffa978c8443776862a11e7526324a6183f3/src/codec.rs)、[ndjson-stream config](https://github.com/florian1345/ndjson-stream/blob/ae2b042e75c873fef937e3b5327014733a8ffa7e/src/config.rs)、[reqwest-streams manifest](https://github.com/abdolence/reqwest-streams-rs/blob/a2cbd63f9549c0b1abee28b7d549af4992648bf5/Cargo.toml)、[其 JSONL codec](https://github.com/abdolence/http-streams-core-rs/blob/2a8aa60b3f3e6cdefff79992cd609d22f122dc25/src/json_nl_codec.rs)。

### 接入时的边界

LinesCodec 先用 bytes 找 LF，再把完整一行转成 UTF-8；中文跨 chunk、LF/CRLF、同块多行都已验证。空行输出空字符串，由 provider 明确选择拒绝或忽略。EOF 时无 LF 的末行仍输出；NDJSON 序列化规范要求 LF，是否容忍完整的无 LF JSON 是额外策略，不能把此行为当作规范保证。[LinesCodec 源码](https://github.com/tokio-rs/tokio/blob/5ec9e6b8d5a7111fe9cd35a637bd8b4e4eb1e483/tokio-util/src/codec/lines_codec.rs)、[NDJSON 规范](https://github.com/ndjson/ndjson-spec/blob/master/README.md)

大小上限按 bytes 计，排除 LF、包含去除前的 CR：max=5 时 `12345\n` 接受，`12345\r\n` 超限。它限制逻辑行，不代表整个进程内存上限，上游 chunk 和其他缓冲仍占内存。非法 UTF-8 返回 `LinesCodecError::Io(InvalidData)`，超长返回 `MaxLineLengthExceeded`。

`io::Error::other(reqwest_error)` 能保留原始 HTTP 错误，但 `LinesCodecError` 未实现透传 `source()`；provider 应 match `Io` 并保留内部错误，不能统一转字符串。JSON、UTF-8、超长和 transport 错误均应结束当前请求；不要用 `filter_map` 跳过坏行。[LinesCodec 错误实现](https://github.com/tokio-rs/tokio/blob/5ec9e6b8d5a7111fe9cd35a637bd8b4e4eb1e483/tokio-util/src/codec/lines_codec.rs)

FramedRead 懒拉取，缓存的下一行无需再读上游；保留同一 framed 对象时，取消 `next()` 后可继续收齐原行。drop 结束本地读取，不保证服务端停止生成。完整行边界上的 EOF 也不代表业务完成，例如构造的 `{"done":false}\n` 后 EOF 应判截断；真实 Ollama 需按其协议检查 `done`。[FramedRead 文档](https://github.com/tokio-rs/tokio/blob/5ec9e6b8d5a7111fe9cd35a637bd8b4e4eb1e483/tokio-util/src/codec/framed_read.rs)、[poll/EOF 实现](https://github.com/tokio-rs/tokio/blob/5ec9e6b8d5a7111fe9cd35a637bd8b4e4eb1e483/tokio-util/src/codec/framed_impl.rs)、[Ollama streaming 文档](https://docs.ollama.com/api/streaming)

### 实际验证

本地 7 tests 通过：固定 chunk 大小遍历、UTF-8/CRLF/空行/末行、坏 JSON/UTF-8、行上限、未完成业务 EOF、懒读取/drop、取消后继续读取，以及 reqwest 本地 HTTP body/提前断连。输入来源见前述溯源表。

```sh
cargo +1.98.1 test --manifest-path /tmp/cognacta-framing-ndjson/Cargo.toml --locked
```

## Amazon EventStream：复用 aws-smithy-eventstream 的独立 codec

**选 `aws-smithy-eventstream 0.61.4`，复用官方 CRC 和二进制 header 解码。** 它可独立接 reqwest，不要求完整 AWS SDK。MSRV 1.94.1，Apache-2.0；直接普通依赖是 `aws-smithy-types`、`bytes`、`crc32fast`，没有 reqwest/Tokio runtime 依赖。Smithy types 仍带时间、Base64、HTTP body 等类型支持；发布包 README 也说明这个 crate 通常不会直接使用，接入要注意版本变化。[发布 manifest](https://docs.rs/crate/aws-smithy-eventstream/0.61.4/source/Cargo.toml)、[README](https://docs.rs/crate/aws-smithy-eventstream/0.61.4/source/README.md)

`MessageFrameDecoder::decode_frame` 接 `bytes::Buf`，返回 `Complete(Message)` / `Incomplete`。调用方维护 byte buffer，收到 chunk 后反复解码直到 `Incomplete`，才能处理一块里多帧。`Message` 保留 typed headers 与原始 payload bytes，不解释 JSON/Base64；未知 header 名保留，header value 类型须属于规范固定集合。预导和整帧 CRC 错误、坏 header 返回错误；内部 ErrorKind 不公开，不能 match 具体 CRC 错误变体。[frame 源码](https://docs.rs/crate/aws-smithy-eventstream/0.61.4/source/src/frame.rs)、[error 源码](https://docs.rs/crate/aws-smithy-eventstream/0.61.4/source/src/error.rs)

### 必须补的少量接入逻辑

**EOF 不能只看 `buffer.is_empty()`。** 已实际复现：12-byte prelude 收齐后，decoder 吞下它，但剩余帧未到，外部 buffer 为空。该 API 没有 finish/pending-state 方法。若采用此 decoder，最少需记录外部 partial 状态：非空 input 到达时置 true；每个 Complete 后设为 `!buffer.is_empty()`；Incomplete 时不清零；正常 body EOF 若仍 true，报告截断。这组 bookkeeping 已遍历所有 EOF cut 验证。

**还需本地资源预算。** decoder 不限制 frame/buffer 大小，并在收到声明的完整帧后才验证 CRC。声明 `u32::MAX` 长度的 prelude，即使 CRC 损坏，也先返回 Incomplete；不能无条件按它 reserve/累计。简洁接法是外部先看前 4 bytes 长度、有界收齐整帧，然后调用公开 `read_message_from`，这样复用同一官方 CRC/header codec，同时容易判断半帧 EOF。采用 MessageFrameDecoder 则需在它吞 prelude 前另行保存并检查长度。[decoder 与 read_message_from](https://docs.rs/crate/aws-smithy-eventstream/0.61.4/source/src/frame.rs)

预算是应用的本地资源策略。Amazon EventStream 规范中的 payload 24 MiB / headers 128 KiB 是服务端限制，规范明确要求客户端不要验证这两项；不要把本地中止误报成违反服务端 wire limit。CRC 失败则应结束当前 stream。[官方格式与约束](https://smithy.io/2.0/aws/amazon-eventstream.html#message-format)

**合法二进制帧也可能代表服务错误。** `:message-type=exception` / `error` 都会解成 Complete。`parse_response_headers` 只支持 event/exception；unmodeled error 要从 raw headers 读 `:error-code` / `:error-message`，映射成 provider 错误。原生终止事件、HTTP status/headers、reqwest body error 也由 provider 处理。SigV4/凭证与这里的分帧是独立工作。[Smithy helper](https://docs.rs/crate/aws-smithy-eventstream/0.61.4/source/src/smithy.rs)、[unmodeled error 规范](https://smithy.io/2.0/aws/amazon-eventstream.html#unmodeled-error-events)

### 实际验证

| 检查 | 已观察结果 |
| --- | --- |
| 两帧 roundtrip，中文/emoji、未知二进制 header、exception；固定 chunksize 1..270 | header/payload 相同，多帧同块也通过 |
| 上游 valid_with_all_headers_and_payload | 10 类 header 和 `some payload` 正确 |
| 上游 6 个坏 CRC/header 文件 | 全部返回 codec Err |
| 单帧所有 EOF cut；两完整帧后第三帧所有 prefix | 外部 partial 状态检出中间截断，包括 12 bytes 后空 buffer |
| 大声明长度、坏 CRC、非法短长度/header length | 验证延后检查行为，完整坏帧报错 |
| 本地 HTTP 200 正常 body / Content-Length 未送完 | reqwest + codec 还原两帧并保留 HTTP metadata；提前断开返回 reqwest body error |
| 合法 exception/error frame | codec 返回 Complete，业务错误须另行解释 |

```sh
cargo run --locked --quiet --manifest-path /tmp/cognacta-framing-eventstream/probe/Cargo.toml
```

固定依赖 `aws-smithy-eventstream=0.61.4`、`aws-smithy-types=1.6.4`、`reqwest=0.13.5`；上游二进制文件来自同版本发布包。该包无 `.cargo_vcs_info.json`，因此引用固定版 docs.rs 源码；archive SHA256 为 `80c2051c2f1016fb8e6548dd07b8bc2ac9c3fe583721444b92f515e856d31609`。[发布包](https://crates.io/api/v1/crates/aws-smithy-eventstream/0.61.4/download)、[test_data](https://docs.rs/crate/aws-smithy-eventstream/0.61.4/source/test_data/)

[S1]: https://docs.rs/sse-core/0.2.3/sse_core/
[S2]: https://docs.rs/crate/sse-core/0.2.3/source/src/decode.rs
[S3]: https://docs.rs/sse-stream/0.3.0/sse_stream/
[S4]: https://docs.rs/crate/sse-stream/0.3.0/source/src/stream.rs
[S5]: https://crates.io/api/v1/crates/sse-core/0.2.3
[S6]: https://crates.io/api/v1/crates/sse-stream/0.3.0
[S7]: https://crates.io/api/v1/crates/sseer/0.3.0
[S8]: https://crates.io/api/v1/crates/eventsource-stream/0.2.3
[S9]: https://docs.rs/crate/reqwest-sse/0.2.0/source/Cargo.toml
[S10]: https://docs.rs/crate/reqwest-eventsource/0.6.0/source/Cargo.toml
[S11]: https://docs.rs/crate/sse-core/0.2.3/source/src/stream.rs
[S12]: https://docs.rs/crate/sse-stream/0.3.0/source/src/stream/parser.rs
[S13]: https://docs.rs/crate/eventsource-stream/0.2.3/source/src/event_stream.rs
[S14]: https://docs.rs/crate/sseer/0.3.0/source/src/event_stream.rs
[S15]: https://docs.rs/crate/sseer/0.3.0/source/src/parser.rs
[S16]: https://docs.rs/crate/reqwest-sse/0.2.0/source/src/lib.rs
[S17]: https://docs.rs/crate/reqwest-eventsource/0.6.0/source/src/retry.rs
[S18]: https://html.spec.whatwg.org/multipage/server-sent-events.html#parsing-an-event-stream
