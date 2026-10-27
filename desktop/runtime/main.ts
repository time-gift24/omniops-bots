import { constants, existsSync } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import { createMcpCatalog, connectMcp } from './mcp.ts';
import readline from 'node:readline';
import { createCredentialClient } from './credentials.ts';
import { createProviderCatalog } from './providers.ts';
import { createChromeHost } from './browser/chrome-host.ts';
import { createBrowserService, createOperationsBrowser } from './browser/browser.ts';
import { createScriptWorkspace } from './browser/script-workspace.ts';
import { openSqliteCheckpointer } from './execution/sqlite.ts';
import { createDesktopRuntime } from './runtime.ts';
import { createResources } from './resources.ts';
import { invalid, RuntimeError, safeError } from './errors.ts';
import { identifier } from './input.ts';
import { createPlatformClient } from './platform.ts';
import { createA2AService, type A2AService } from './a2a/index.ts';
import { connectA2AWss, DEFAULT_WSS_LIMITS, type A2AWssAdapter } from './a2a/wss.ts';
import { writeJson } from './json-store.ts';
import { runDiagnosticIpc } from './diagnostics-main.ts';
import { listSavedDiagnosticPackages, openSavedDiagnosticPackage, previewDiagnosticFile } from './diagnostics.ts';
import { createPublications } from './publication.ts';

if (process.env.OMNIOPS_BOTS_DIAGNOSTICS_ONLY === '1') {
  await runDiagnosticIpc(process.env.OMNIOPS_BOTS_LOCAL_ROOT || join(homedir(), '.omnimind-ops'));
  process.exit(0);
}

const dataDir = process.env.OMNIOPS_BOTS_DATA_DIR;
if (!dataDir) throw new Error('OMNIOPS_BOTS_DATA_DIR is required');
await mkdir(dataDir, { recursive: true, mode: 0o700 });
const modelFile = join(dataDir, 'model.env');
if (existsSync(modelFile)) process.loadEnvFile(modelFile);
const send = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);
const credentials = createCredentialClient({ send });
let providers: Awaited<ReturnType<typeof createProviderCatalog>> | undefined;
let runtime: Awaited<ReturnType<typeof createDesktopRuntime>> | undefined;
let service: A2AService | undefined, transport: A2AWssAdapter | undefined;
let startup: Promise<void> | undefined, retry: ReturnType<typeof setTimeout> | undefined;
let starting = false;
let maintenanceLease: { release(): void } | undefined;
let diagnosticReaders = 0;
const connecting = new AbortController();
let platform: ReturnType<typeof createPlatformClient> | undefined, platformError: unknown;
if (process.env.OMNIOPS_BOTS_PLATFORM_URL) {
  try {
    platform = createPlatformClient({
      baseUrl: process.env.OMNIOPS_BOTS_PLATFORM_URL,
      allowedDownloadOrigins: [new URL(process.env.OMNIOPS_BOTS_PLATFORM_URL).origin],
      getAuthorization: async ({ signal }) => {
        signal.throwIfAborted();
        const file = process.env.OMNIOPS_BOTS_PLATFORM_TOKEN_FILE;
        if (!file || !isAbsolute(file)) throw new RuntimeError('authentication', '请配置平台会话凭据来源。');
        const info = await lstat(file);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 8192) throw invalid('平台会话凭据文件无效。');
        const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const before = await handle.stat();
          if (!before.isFile() || before.size > 8192) throw invalid('平台会话凭据文件无效。');
          signal.throwIfAborted();
          const bytes = Buffer.alloc(8193);
          const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
          const after = await handle.stat();
          if (bytesRead > 8192 || bytesRead !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw invalid('平台会话凭据文件已变化，请重试。');
          const token = bytes.subarray(0, bytesRead).toString('utf8').trim();
          if (!token || token.length > 8000 || !/^[\x21-\x7e]+$/u.test(token)) throw invalid('平台会话凭据无效。');
          signal.throwIfAborted();
          return `Bearer ${token}`;
        } finally { await handle.close(); }
      },
    });
  } catch (error) { platformError = error; }
}
const redact = (value: string) => providers ? providers.redact(value) : String(value);
const browser = createBrowserService(createChromeHost({ directory: join(dataDir, 'chrome') }));
const operationsBrowser = createOperationsBrowser({
  endpoint: process.env.OMNIOPS_BOTS_MANUAL_BROWSER_CDP_ENDPOINT,
  targetId: process.env.OMNIOPS_BOTS_MANUAL_BROWSER_TARGET_ID,
});
const localRoot = process.env.OMNIOPS_BOTS_LOCAL_ROOT || join(homedir(), '.omnimind-ops');
const runsDir = join(localRoot, 'runs');
const mcpCatalog = createMcpCatalog({ directory: join(localRoot, 'config') });
const resources = createResources({ skillsDir: join(localRoot, 'skills'), agentsDir: join(localRoot, 'agents'), runsDir,
  ...(process.env.OMNIOPS_BOTS_LOCAL_ROOT ? { temporaryDir: join(localRoot, 'tmp') } : {}), mcpCatalog, ...(platform ? { platform } : {}) });
const publications = platform ? createPublications({ directory: join(localRoot, 'publications'), resources, platform }) : undefined;
const checkpoints = await openSqliteCheckpointer(join(localRoot, 'checkpoints.sqlite'));
type IpcRequest = { id: number; method: string; params?: Record<string, unknown> };
function validRequest(value: unknown): value is IpcRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  return typeof request.id === 'number' && Number.isSafeInteger(request.id) && request.id >= 0 && typeof request.method === 'string' &&
    (request.params === undefined || Boolean(request.params && typeof request.params === 'object' && !Array.isArray(request.params)));
}
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let shutdown: Promise<void> | undefined;
function close(id?: number) {
  if (!shutdown) {
    const deadline = performance.now() + 10_000;
    const forceExit = setTimeout(() => process.exit(1), Math.max(0, deadline - performance.now()));
    shutdown = Promise.resolve().then(async () => {
      connecting.abort();
      clearTimeout(retry);
      const failures: unknown[] = [];
      for (const cleanup of [
        async () => { await transport?.close({ deadline }); },
        async () => { await startup?.catch(() => {}); await service?.close({ deadline }); },
        async () => { await publications?.close({ deadline }); },
        async () => { await platform?.close({ deadline }); },
        async () => { if (runtime) await runtime.close({ deadline }); else await providers?.close(); },
        async () => { credentials.close(); await checkpoints.close(); },
      ]) {
        try { await cleanup(); } catch (error) { failures.push(error); }
      }
      if (failures.length) throw Object.assign(new RuntimeError('unavailable', '部分资源未在关闭期限内完成清理。'), { cause: new AggregateError(failures) });
      input.close();
      if (id !== undefined) send({ id, result: { stopped: true } });
      await new Promise(resolve => process.stdout.write(`${JSON.stringify({ event: 'exit' })}\n`, resolve));
      clearTimeout(forceExit);
      process.exit(0);
    }).catch(async error => {
      if (id !== undefined) await new Promise<void>(resolve => process.stdout.write(`${JSON.stringify({ id, error: safeError(error) })}\n`, () => resolve()));
      clearTimeout(forceExit);
      process.exit(1);
    });
  }
  return shutdown;
}

input.on('line', line => {
  let request: unknown;
  try {
    if (Buffer.byteLength(line) > 40 * 1024 * 1024) throw invalid('请求超过大小限制。');
    request = JSON.parse(line);
    if (credentials.receive(request)) return;
    if (!validRequest(request)) throw invalid('IPC 请求格式无效。');
  } catch (error) {
    send({ id: validRequest(request) ? request.id : null, error: error instanceof RuntimeError ? safeError(error) : safeError(invalid('IPC 请求格式无效。')) });
    return;
  }
  if (!validRequest(request)) return;
  const { id, method, params } = request;
  if (method === 'shutdown') { void close(id); return; }
  Promise.resolve().then<unknown>(async () => {
    if (shutdown) throw new RuntimeError('unavailable', '应用正在关闭。');
    if (!runtime) throw new RuntimeError('unavailable', '客户端正在初始化，请稍后重试。');
    if (publications?.hasMethod(method)) return publications.handle(method, params, { signal: connecting.signal });
    if (method === 'maintenance_begin') {
      if (maintenanceLease) throw new RuntimeError('busy', '应用正在准备安装。');
      maintenanceLease = runtime.beginMaintenance(); return { prepared: true };
    }
    if (method === 'maintenance_end') { maintenanceLease?.release(); maintenanceLease = undefined; return { released: true }; }
    if (method === 'runs_list' || method === 'run_get') {
      const value = await runtime.dispatch(method, params);
      const records = (Array.isArray(value) ? value : [value]) as { runId: string; delivery?: unknown }[];
      if (service) for (let index = 0; index < records.length; index += 1000) {
        const delivery = await service.deliveriesForRuns(records.slice(index, index + 1000).map(r => r.runId));
        for (const record of records.slice(index, index + 1000)) {
          const match = delivery.find(d => d.runId === record.runId); if (match) record.delivery = match;
        }
      }
      return Array.isArray(value) ? records : records[0];
    }
    if (method === 'platform_session') {
      if (!platform) throw new RuntimeError('unavailable', '平台连接尚未配置。');
      return platform.session();
    }
    if (method === 'platform_reconnect') {
      if (!platform || !service) throw new RuntimeError('unavailable', '平台连接当前无法重建。');
      if (starting) throw new RuntimeError('busy', '平台连接正在建立，请稍后重试。');
      starting = true;
      clearTimeout(retry);
      try {
        await transport?.close({ deadline: performance.now() + 3000 }); transport = undefined;
        startup = connectRemote().finally(() => { starting = false; });
        return { connecting: true };
      } catch (error) { starting = false; throw error; }
    }
    if (method === 'diagnostic_export') {
      const result = await runtime.dispatch(method, params) as import('./diagnostics.ts').DiagnosticExport;
      await writeJson(join(localRoot, 'diagnostics', `${result.uploadId}.json`), result);
      return result;
    }
    if (['diagnostic_saved_packages', 'diagnostic_open_package', 'diagnostic_preview_file'].includes(method)) {
      if (diagnosticReaders >= 2) throw new RuntimeError('resource-limit', '诊断材料读取过多，请稍后重试。');
      diagnosticReaders++;
      try {
        if (method === 'diagnostic_saved_packages') return await listSavedDiagnosticPackages(localRoot, { signal: connecting.signal });
        const uploadId = identifier(params?.uploadId, 'uploadId');
        if (method === 'diagnostic_open_package') return await openSavedDiagnosticPackage(localRoot, uploadId, { signal: connecting.signal });
        return await previewDiagnosticFile(localRoot, uploadId, identifier(params?.path, 'path'), { signal: connecting.signal });
      } finally { diagnosticReaders--; }
    }
    if (method === 'diagnostic_upload' || method === 'diagnostic_upload_status') {
      if (!platform) throw new RuntimeError('unavailable', '平台连接尚未配置。');
      const uploadId = identifier(params?.uploadId, 'uploadId');
      if (!/^[a-f0-9-]{36}$/u.test(uploadId)) throw invalid('诊断上传编号无效。');
      const saved = await openSavedDiagnosticPackage(localRoot, uploadId, { signal: connecting.signal });
      if (method === 'diagnostic_upload_status') {
        const result = await platform.diagnosticStatus(uploadId);
        if (result.state === 'received' && (result.bundleSha256 !== saved.bundleSha256 || result.threadId !== saved.threadId)) throw new RuntimeError('integrity', '诊断包接收回执不匹配。');
        return result;
      }
      if (params?.consent !== true) throw invalid('上传诊断材料需要知情确认。');
      const session = await platform.session();
      if (!session.permissions.some(p => ['diagnostic-own', 'diagnostic-read'].includes(p))) throw new RuntimeError('forbidden', '当前账号没有诊断上传权限。');
      return platform.uploadDiagnostic({ uploadId, packageFile: saved.packageFile, bundleSha256: saved.bundleSha256 });
    }
    if (method === 'mcp_save') return mcpCatalog.save(params?.server);
    if (method === 'mcp_remove') return mcpCatalog.remove(identifier(params?.id, 'MCP ID'));
    if (method === 'mcp_test') return (async () => {
      const connection = await connectMcp([await mcpCatalog.get(identifier(params?.id, 'MCP ID'))], { signal: AbortSignal.timeout(15_000), redact });
      try { return connection.capabilities[0].capabilities; }
      finally { await connection.close(); }
    })();
    return resources.hasMethod(method) ? resources.handle(method, params) : runtime.dispatch(method, params);
  }).then(result => send({ id, result }), error => send({ id, error: safeError(error) }));
});
input.on('close', () => { void close(); });
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => { void close(); });
process.stdout.on('error', () => { void close(); });
// The credential reply listener must be installed before importing legacy keys.
providers = await createProviderCatalog({ file: join(dataDir, 'providers.json'), credentials,
  ...(process.env.OMNIOPS_BOTS_MODEL ? { legacy: {
    model: process.env.OMNIOPS_BOTS_MODEL, baseURL: process.env.OPENAI_BASE_URL, apiKey: process.env.OPENAI_API_KEY,
  } } : {}),
});
if (shutdown) await close();
runtime = await createDesktopRuntime({
  browser, operationsBrowser, resources, runsDir, providers, emit: send, redact, checkpointer: checkpoints.checkpointer,
  timeoutMs: process.env.OMNIOPS_BOTS_RUN_TIMEOUT_MS ? Number(process.env.OMNIOPS_BOTS_RUN_TIMEOUT_MS) : 300_000,
  maxConcurrentRuns: process.env.OMNIOPS_BOTS_MAX_CONCURRENT_RUNS ? Number(process.env.OMNIOPS_BOTS_MAX_CONCURRENT_RUNS) : 4,
  settingsFile: join(dataDir, 'settings.json'),
  workspaceFactory: (session, boundBrowser) => createScriptWorkspace({ dataDir: session.workingDirectory, ensureBrowser: boundBrowser.ensure, signalEvent: send, redact }),
});
send({ event: 'ready', state: runtime.getState() });

async function connectRemote() {
  if (!platform || !service || connecting.signal.aborted) return;
  runtime!.setConnection({ state: 'connecting', permissions: [] });
  let permissions: string[] = [];
  let account: string | undefined;
  try {
    const url = new URL('/api/clients/connect', process.env.OMNIOPS_BOTS_PLATFORM_URL!); url.protocol = 'wss:';
    const adapter = await connectA2AWss({ url: url.href, service, limits: DEFAULT_WSS_LIMITS,
      getCredentials: async ({ origin, signal }) => {
        if (origin !== new URL(process.env.OMNIOPS_BOTS_PLATFORM_URL!).origin) throw invalid('平台连接来源不匹配。');
        const verified = await platform!.credentials({ signal });
        permissions = [...verified.session.permissions];
        account = verified.session.callerId;
        return { authorization: verified.authorization, principal: { organizationId: verified.session.organizationId, callerId: verified.session.callerId, installationId: verified.session.installationId }, expiresAt: verified.session.expiresAt };
      },
    }, { signal: connecting.signal });
    if (connecting.signal.aborted) { await adapter.close({ deadline: performance.now() + 1000 }); return; }
    transport = adapter;
    const update = () => { const status = adapter.getStatus(); runtime!.setConnection({ ...status, destination: new URL(process.env.OMNIOPS_BOTS_PLATFORM_URL!).origin, ...(account ? { account } : {}), permissions: status.state === 'blocked' || status.state === 'closed' ? [] : permissions }); };
    adapter.subscribe(update); update();
  } catch (error) {
    if (connecting.signal.aborted) return;
    const kind = safeError(error).kind;
    const permanent = ['authentication', 'forbidden', 'protocol', 'invalid-request'].includes(kind);
    runtime!.setConnection({ state: permanent ? 'blocked' : 'reconnecting', reason: permanent ? kind === 'invalid-request' ? 'protocol' : kind : 'network', permissions: [] });
    if (!permanent) retry = setTimeout(() => {
      starting = true;
      startup = connectRemote().finally(() => { starting = false; });
    }, 1000);
  }
}
if (platformError) runtime.setConnection({ state: 'blocked', reason: 'protocol', permissions: [] });
if (platform) {
  starting = true;
  startup = (async () => {
    service = await createA2AService({ directory: join(localRoot, 'a2a'), runtime: runtime!, resolveEndpoint: (context, tenant, options) => platform!.resolveEndpoint(context, tenant, options), limits: { maxRequestBytes: 256 * 1024, maxTaskBytes: 1024 * 1024, maxJsonDepth: 32, maxWaiters: 64, maxSubscriptions: 16 } }, { signal: connecting.signal });
    const confirm = service.confirmTaskDelivery;
    service.confirmTaskDelivery = async (...args) => { const result = await confirm(...args); send({ event: 'delivery_changed' }); return result; };
    await connectRemote();
  })().catch(() => { if (!connecting.signal.aborted) runtime!.setConnection({ state: 'blocked', reason: 'unknown', permissions: [] }); }).finally(() => { starting = false; });
}
