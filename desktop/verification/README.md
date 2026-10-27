# Independent client verification peer

This test service runs in a separate Node 26.11.1 process. It accepts the desktop client's outbound WSS connection, sends standard A2A JSON-RPC, and commits terminal results to its own SQLite ledger before sending the delivery receipt. It is not a production identity service or Console.

Install the locked runtime dependencies with `npm --prefix desktop/runtime ci`. Then create an empty directory outside the repository and generate isolated fixtures:

```sh
node desktop/verification/init.mjs --directory /absolute/empty-directory
```

The command creates a two-day localhost TLS certificate, private test key, random token files, immutable Agent/Skill fixtures, `service.json` and `verify.json`. These generated files stay outside Git. OpenSSL must be available for this bootstrap command. It does not create an updater signing key or signed native packages.

For one command that starts the independent peer and the normal `main.ts` client:

```sh
node desktop/verification/verify.mjs --profile contract --config /absolute/empty-directory/verify.json
```

The contract profile checks its named subcases, including exact package downloads, JSON falsy output, durable deduplication, capacity rejection, cancellation, execution timeout, actual managed Chrome effects, network recovery, both process crash boundaries, and durable receipts. JSON and Markdown reports list every executed subcase. The credential IPC responder is an explicit test fixture; it does not prove system keychain integration. Unexecuted variants of the 45 complete requirement scenarios remain `not-run`, even when the declared contract scope passes.

`full` additionally runs the existing runtime, web, script, Rust and browser regression commands. Missing native installed-package, updater or complete requirement variants keep the full result `not-run`; a fake cannot satisfy those gates. `--merge` requires two matching complete full reports, one macOS ARM64 and one Windows x64:

```sh
node desktop/verification/verify.mjs --profile full --config /absolute/verify.json
node desktop/verification/verify.mjs --merge /absolute/mac.json /absolute/windows.json --output /absolute/summary
```

The Rust gates prefer an explicit absolute `CEF_PATH`. Otherwise they inspect the pinned SDK in the existing macOS `~/Library/Caches/tauri-cef` or Windows `desktop/.scratch/windows-cache/cef` cache. If that SDK is missing or invalid, the three CEF-dependent Cargo stages are explicitly `not-run`; the verifier does not trigger an implicit SDK download. Formatting and dependency-policy checks still execute.

To run only the peer, use `node desktop/verification/server.mjs --config /absolute/service.json`. Its one-line JSON ready record supplies the HTTPS/WSS origin, independent loopback control origin, fixture identity and local model/MCP/site fixture addresses. The bootstrap reserves a fixed localhost HTTPS port because the MCP URL is part of the immutable Agent package; a later collision fails explicitly. Auxiliary port zero choices are assigned once and retained in the service data root across restarts. Business calls use WSS; the control HTTP server only selects test stimuli and observes assertions. It requires its random control token and is never mounted on the public port.

For deployment to another machine, bootstrap with `--public-origin https://fixture-host:port`; this fixes the Agent's immutable MCP URL and generates a temporary certificate for that hostname. Provide a durable certificate valid for the hostname when required, and retain absolute fixture/config paths on the service machine. Explicitly trust the test CA in Node and the target OS where necessary; never disable TLS validation. The desktop uses `OMNIOPS_BOTS_PLATFORM_URL` and `OMNIOPS_BOTS_PLATFORM_TOKEN_FILE`; model configuration remains local. Forward the peer's loopback control port explicitly when operating a remote peer. Set the verifier's `peer.mode` to `external` with the public origin, forwarded loopback control origin and a local control-secret file. Do not expose the control listener publicly.

The service implements authorized version manifests/raw files/ZIP downloads, immutable drafts, atomic linked releases, diagnostic ZIP validation and durable receipts. Signed updater artifacts can be placed under the fixture root's `updates/`; the service only distributes them. The Agent connects to the actual MCP SDK endpoint over the fixed HTTPS origin. Model and browser site fixtures use a separate loopback HTTP listener for local runs; a remote deployment advertises them on the public HTTPS origin. The model can request the registered MCP lookup tool before browser operations. Faults are fixed, time-bounded stimuli such as corrupt packages, lost receipts, wrong handshake headers, storage failure and disconnection. Ordinary reports contain safe summaries and hashes, not credentials or raw model content.

Run the independent service/config/report behavior checks with:

```sh
node --test desktop/verification/*.test.mjs
```

After `make package-debug` on macOS, exercise the packaged native host, bundled Node, CEF shutdown, shared normal/diagnostic data-root lock and read-only diagnostic entry with fresh isolated directories:

```sh
node desktop/verification/native-smoke.mjs --executable /absolute/omniops-bots.app/Contents/MacOS/omniops-bots-desktop --directory /absolute/empty-native-smoke-directory
```

This debug-only check uses the existing smoke-exit setting and a temporary Node preload that records fixed lifecycle fields. It never opens the user's existing profile or data root. The competing diagnostic host is terminated by the test after proving it did not start Node while the normal host owns the lock. Successful normal and standalone runs must exit zero, and the standalone list/rejected execution requests must preserve source records, checkpoint bytes and any existing nonempty WAL. SQLite may create its read lock/index sidecars; the report lists them explicitly and permits a newly created WAL only when empty. Its report is separate evidence for these named subcases; it does not satisfy signed-update or Windows installation gates.

No product logs, spans or metrics are added. Persistent test ledgers and report assertions provide the evidence.
