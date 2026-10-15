# LaunchDarkly rust-eventsource-client 与 reqwest 的适配评估

调研日期：2026-10-14（Asia/Shanghai）。对象是用户指定的 [launchdarkly/rust-eventsource-client](https://github.com/launchdarkly/rust-eventsource-client)。以 crates.io 当前发布版 `eventsource-client 0.18.1` 的源码为准，发布 SHA 为 `62e62cae988ae71090f9c0b7bddf4dbe33786e36`，crate 位于仓库 `eventsource-client/`；没有用 main 的 API 或过期 latest 页面推断发布行为。[R1] [R2]

## 结论

**它能搭配 reqwest，但不适合作为我们只负责分帧的基本 eventsource 库。** `0.18.1` 已公开 `build_with_transport`，可以注入 reqwest transport，不能简单说“它只能使用 Hyper”。问题是纯 parser 没有公开：外部无法把已拿到的 `reqwest::Response::bytes_stream()` 直接交给它；需要进入整套请求、连接和重连管理。[R3] [R4]

对 Cognacta 目前确定的路线，仍建议：`reqwest` 发请求并检查响应，`sse-core` 处理 SSE，再由 provider 映射原生事件；其他协议沿用[分帧专项报告](stream-framing-libraries.md)的组合。若实际需要可自动恢复的长连接订阅，LaunchDarkly 这个库的完整客户端才更有价值。这里是接入成本和职责的判断。

## 版本、依赖和公开接口

| 项目 | 已核实的发布版事实 |
| --- | --- |
| 最新版 | `0.18.1`，2026-10-07 UTC 发布；stable，未 yanked。 |
| 工具链 / 许可证 | MSRV `1.97.0`，edition 2021，Apache-2.0；与项目固定 Rust 1.98.1 及当前许可证 allow list 匹配。 |
| 默认 features | `hyper`；可用 `default-features = false` 关闭。其他 features 为 `hyper-rustls-native-roots` / `hyper-rustls-webpki-roots` / `native-tls`，均委托给 `launchdarkly-sdk-transport`。 |
| 传输边界 | `launchdarkly-sdk-transport ^0.1.0` 的 `HttpTransport`；当前 probe 锁 `0.1.4`，并关闭其默认 features。 |
| 网络版本耦合 | crate 自身不依赖 reqwest；用 `http 1` 请求 / 响应类型，transport 和输出流要求 `Send + Sync`。仍固定依赖 Tokio 的 sync/time、futures、rand 等。 |
| 纯 parser | `mod event_parser` 为私有；只导出 `Event` / `SSE`，未导出内部 `EventParser`。 |
| Client API | `ClientBuilder::for_url(...).build_with_transport(...)`；`Client` trait sealed，调用方可以换 transport，不能另实现它的 Client。 |
| POST / JSON body | `.method("POST".into())` / `.body(json_string)`；body 是 String，不是公开的任意 byte body 或 reqwest RequestBuilder。Content-Type 等通过 `.header()` 设置。 |

版本 / features / MSRV / dependencies 来自发行元数据与 Cargo.toml；API 来自固定 SHA 源码。`lib.rs` 的文档示例提到 reqwest，但发布包仅包含 Hyper 的 `tail.rs` 示例，且文档隐藏代码中的 `Request<Option<String>>` 已不符合实际 transport 的 `Request<Option<Bytes>>` 签名。应以 trait 源码为准。[R1] [R2] [R3] [R4] [R5]

关闭 default features 裁掉的是 LaunchDarkly 额外的 Hyper transport；reqwest 自身仍可能使用 Hyper。transport crate `0.1.4` 的 MSRV 是 1.94.0、许可证 Apache-2.0、默认 features 为空，也没有内置 reqwest 实现。[R13]

两条接入链的差别：

```text
eventsource-client:
  Provider → ClientBuilder → 自写 HttpTransport → reqwest
           ← 连接状态机 + 私有 SSE parser ← response bytes

sse-core:
  Provider → reqwest → Response/status/headers → bytes_stream → SSE decoder
```

前者不是额外包一层 `bytes_stream` 就完成；`HttpTransport::request` 接收 `http::Request<Option<Bytes>>`，返回 boxed future，再转换 status、headers 和 boxed `ByteStream`。可复用同一个 reqwest Client，但需承担请求和错误转换。trait 明确要求 transport 不重试、不跟随重定向，这些留给消费者管理。[R5]

## 生成请求需要关闭的行为

默认 `retry_initial = false`、`reconnect = true`：首次连接失败不自动重试，连上后发生 EOF、parser 错误或 body 错误会安排重连。基准延迟 1 秒，倍数 2，最大 60 秒；实现带 jitter，实际等待区间是当前延迟的一半到全部。客户端会重新发送同一个方法、body 和 headers，并按已发出的 Event.id 设置 Last-Event-ID。[R4] [R6] [R7]

生成 POST 若只应执行一次，至少这样关闭 reconnect：

```rust
let reconnect = eventsource_client::ReconnectOptions::reconnect(false)
    .retry_initial(false)
    .build();
```

将其交给 `ClientBuilder::reconnect(reconnect)`。如同时不需要客户端跟随 301 / 307，也设 `.redirect_limit(0)`；默认 redirect limit 为 16。reqwest transport 本身另外使用 `redirect(Policy::none())` 和 `retry(reqwest::retry::never())`，避免两层控制同一请求；reqwest 0.13 的默认 retry 针对 protocol NACK，不能把关闭上层 reconnect 当作关闭所有下层 retry。[R4] [R5] [R8]

**关闭 reconnect 不意味着每个错误之后库都会立即返回 None。** 发布代码的 body transport-error 分支未在 `reconnect=false` 时设 `StreamClosed`，与 parser-error / EOF 分支不同。因此 provider 在任一错误时都应终止当前响应，不能靠“继续 poll 看它是否结束”处理失败。[R4]

## metadata 和 parser 边界

| 检查项 | 发布源码行为 |
| --- | --- |
| 成功响应 metadata | 先发 `SSE::Connected`；可读 status、header keys、单值 / 多值 header。 |
| 失败 HTTP metadata | `Error::UnexpectedResponse(Response, ErrorBody)` 保存 status / headers / 流式 error body；可用 `into_stream()` 读取 body。 |
| 状态 / MIME 验证 | 任意 2xx 都进入 Connected；没有验证 Content-Type 为 `text/event-stream`，204 也不专门停止 reconnect。 |
| Comment heartbeat | `SSE::Comment(String)` 直接透出；无需 data block 才产生。 |
| 分帧基本规则 | 支持 leading BOM、LF / CRLF / 裸 CR、跨 byte chunk 的完整行拼接和多行 data。未知 ASCII 字段会忽略，字段名大小写敏感。 |
| Unicode | 完整行才解析 UTF-8，能接跨 chunk 的多字节字符；无效 UTF-8 在 key/value 报 InvalidLine，连未知字段值也先验证。 |
| 空 data / 无 data | 显式空 data 可以产生 data 为空字符串的 Event；一般 metadata-only block 不产生 Event。 |
| id | 常规事件间继承；空值清除、包含 NULL 的值忽略。 |
| retry | `parse::<u64>()` 也接受 `+1`；retry-only block 不发 Event，连接层仅从已发 Event 的 retry 更新延迟。 |
| 大小限制 | parser 对 line、event data、complete-lines queue 和输出 queue 没有配置的 hard limit。 |
| EOF | 总是产出 `Eof` 或 `UnexpectedEof` 错误，随后按 reconnect 策略处理；不是普通 decoder 的 None。`was_processing()` 没检查 pending `event_data`，不能完全据错误变体判断事件是否截断。 |

成功 / 失败 response 字段来自 response.rs；客户端验证及 EOF / retry 行为来自 client.rs；分帧和缓冲行为来自 event_parser.rs。[R4] [R9] [R10]

错误保留也需要区分：`TransportError` 内部保留具体源错误，`eventsource_client::Error` 提供固有 `source()` 方法；但它的 `std::error::Error` 实现未重写 trait 的 `source()`。作为 dyn Error 或被其他 error 包装时，标准 source 链不会自动穿透这一层。provider 出口应匹配错误变体、保留需要的源，而不是只保存字符串。[R5] [R11]

这些行为不替 provider 处理模型完成：即便收到完整 SSE block，也仍需检查各协议的终止事件。收到业务完成事件后应结束消费；若直到 Eof 仍缺预期终止，则报告响应截断，不能将所有 Eof 一概归为成功或失败。模型的工具参数聚合和 native history / signature 回放不属于这个客户端的职责。

## 本地验证

独立 probe 精确锁 `eventsource-client = "=0.18.1"`、`launchdarkly-sdk-transport = "=0.1.4"`、`reqwest = "=0.13.5"`，三者关闭默认 features；Rust 1.98.1，5 个测试通过。只使用发布版公共 API，自写短小的 reqwest `HttpTransport` 适配，没有复制或公开私有 parser。

| 验证 | 实际结果 |
| --- | --- |
| localhost HTTP + POST JSON | 请求方法、原始 body 正确；收到 Connected、两个 data Event，然后 `Err(Eof)`，下一次 poll 为 None。 |
| 手写 fake transport，chunk 大小 `1..=输入长度` | split BOM、Unicode / emoji、CRLF、多行 data 均正确；逐字节裸 CR 完整事件也正确。 |
| 未完成事件 | `data: hi\n` 被丢弃并报 Eof；`data: hi` 报 UnexpectedEof，印证不能只靠错误变体判完整性。 |
| 字段边界 | 未知 ASCII field 正常忽略；非法 UTF-8 报 InvalidLine；`event:\n\n` / `retry: bad\n\n` 这种无 data block 实际报 InvalidEvent；`retry: +1` 被接受为 1 ms。 |
| 关闭 reconnect 后的 body error | synthetic TransportError 后继续 poll 仍能获得之后的 Event，请求次数为 1；关重连与错误终止不是同一件事。 |
| 开启 reconnect | fake transport 记录到两次相同 POST 方法与 body，证明会重复发生成请求。 |
| 导入公开 decoder | `use eventsource_client::event_parser::EventParser` 编译报 E0603：模块私有。 |

字段边界与 WHATWG 不一致处是本次复现结果，未将库能继续运行当作符合规范。[R12] 测试材料为手写协议 fixture，没有真实 provider 录制；本地 HTTP 只验证 transport 和 POST，fake transport 验证精确 chunk 切分与重连。没有真实模型联调、性能 benchmark 或长时间运行测试。可核对[测试源码](/tmp/cognacta-eventsource-client-probe/src/lib.rs)及[私有 parser 导入检查](/tmp/cognacta-eventsource-client-probe/check-private-parser.py)；这些是临时目录中的调研材料。

可复跑：

```sh
cargo +1.98.1 test --manifest-path /tmp/cognacta-eventsource-client-probe/Cargo.toml --locked
python3 /tmp/cognacta-eventsource-client-probe/check-private-parser.py
```

## 对先设计统一 provider 接口的建议

先确定业务 request、流式 event 和 error，再用 OpenAI、Anthropic 等代表性映射验证接口，然后逐一扩展 provider。工具调用必须能表达 call id / index、参数片段与完成；history 必须能携带回放需要的原生内容及 signature，不能提前压成只有文本的消息。

统一接口留在 core，reqwest、SSE 类型和 native DTO 留在 provider 内部。流式分帧不必成为 core 公共接口，也不先建一个抽象 transport crate；出现实际复用后再提取共享实现。`eventsource-client` 的连接管理不应决定业务流式事件的形态。

## 一手来源

- [R1] [crates.io eventsource-client 发布记录](https://crates.io/api/v1/crates/eventsource-client)；本次采用 0.18.1。
- [R2] [0.18.1 发布 Cargo.toml](https://docs.rs/crate/eventsource-client/0.18.1/source/Cargo.toml)；[发布 vcs_info](https://docs.rs/crate/eventsource-client/0.18.1/source/.cargo_vcs_info.json)。
- [R3] [固定 SHA lib.rs：私有 parser 与导出](https://github.com/launchdarkly/rust-eventsource-client/blob/62e62cae988ae71090f9c0b7bddf4dbe33786e36/eventsource-client/src/lib.rs)。
- [R4] [固定 SHA client.rs：builder、请求、状态机](https://github.com/launchdarkly/rust-eventsource-client/blob/62e62cae988ae71090f9c0b7bddf4dbe33786e36/eventsource-client/src/client.rs)。
- [R5] [launchdarkly-sdk-transport 0.1.4 发布 transport.rs](https://docs.rs/crate/launchdarkly-sdk-transport/0.1.4/source/src/transport.rs)。
- [R6] [固定 SHA config.rs：默认 reconnect 参数](https://github.com/launchdarkly/rust-eventsource-client/blob/62e62cae988ae71090f9c0b7bddf4dbe33786e36/eventsource-client/src/config.rs)。
- [R7] [固定 SHA retry.rs：jitter 与 backoff](https://github.com/launchdarkly/rust-eventsource-client/blob/62e62cae988ae71090f9c0b7bddf4dbe33786e36/eventsource-client/src/retry.rs)。
- [R8] [reqwest 0.13.5 retry::never](https://docs.rs/reqwest/0.13.5/reqwest/retry/fn.never.html)。
- [R9] [固定 SHA response.rs：metadata 与错误 body](https://github.com/launchdarkly/rust-eventsource-client/blob/62e62cae988ae71090f9c0b7bddf4dbe33786e36/eventsource-client/src/response.rs)。
- [R10] [固定 SHA event_parser.rs：字段、BOM、缓冲和 EOF 检查](https://github.com/launchdarkly/rust-eventsource-client/blob/62e62cae988ae71090f9c0b7bddf4dbe33786e36/eventsource-client/src/event_parser.rs)。
- [R11] [固定 SHA error.rs：源错误链](https://github.com/launchdarkly/rust-eventsource-client/blob/62e62cae988ae71090f9c0b7bddf4dbe33786e36/eventsource-client/src/error.rs)。
- [R12] [WHATWG SSE 解释规则](https://html.spec.whatwg.org/multipage/server-sent-events.html#interpreting-an-event-stream)。
- [R13] [launchdarkly-sdk-transport 0.1.4 Cargo.toml](https://docs.rs/crate/launchdarkly-sdk-transport/0.1.4/source/Cargo.toml)。

[R1]: https://crates.io/api/v1/crates/eventsource-client
[R2]: https://docs.rs/crate/eventsource-client/0.18.1/source/Cargo.toml
[R3]: https://github.com/launchdarkly/rust-eventsource-client/blob/62e62cae988ae71090f9c0b7bddf4dbe33786e36/eventsource-client/src/lib.rs
[R4]: https://github.com/launchdarkly/rust-eventsource-client/blob/62e62cae988ae71090f9c0b7bddf4dbe33786e36/eventsource-client/src/client.rs
[R5]: https://docs.rs/crate/launchdarkly-sdk-transport/0.1.4/source/src/transport.rs
[R6]: https://github.com/launchdarkly/rust-eventsource-client/blob/62e62cae988ae71090f9c0b7bddf4dbe33786e36/eventsource-client/src/config.rs
[R7]: https://github.com/launchdarkly/rust-eventsource-client/blob/62e62cae988ae71090f9c0b7bddf4dbe33786e36/eventsource-client/src/retry.rs
[R8]: https://docs.rs/reqwest/0.13.5/reqwest/retry/fn.never.html
[R9]: https://github.com/launchdarkly/rust-eventsource-client/blob/62e62cae988ae71090f9c0b7bddf4dbe33786e36/eventsource-client/src/response.rs
[R10]: https://github.com/launchdarkly/rust-eventsource-client/blob/62e62cae988ae71090f9c0b7bddf4dbe33786e36/eventsource-client/src/event_parser.rs
[R11]: https://github.com/launchdarkly/rust-eventsource-client/blob/62e62cae988ae71090f9c0b7bddf4dbe33786e36/eventsource-client/src/error.rs
[R12]: https://html.spec.whatwg.org/multipage/server-sent-events.html#interpreting-an-event-stream
[R13]: https://docs.rs/crate/launchdarkly-sdk-transport/0.1.4/source/Cargo.toml
