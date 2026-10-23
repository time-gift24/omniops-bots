import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
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

const dataDir = process.env.OMNIOPS_BOTS_DATA_DIR;
if (!dataDir) throw new Error('OMNIOPS_BOTS_DATA_DIR is required');
await mkdir(dataDir, { recursive: true, mode: 0o700 });
const modelFile = join(dataDir, 'model.env');
if (existsSync(modelFile)) process.loadEnvFile(modelFile);
const send = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);
const credentials = createCredentialClient({ send });
let providers: Awaited<ReturnType<typeof createProviderCatalog>> | undefined;
let runtime: Awaited<ReturnType<typeof createDesktopRuntime>> | undefined;
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
  ...(process.env.OMNIOPS_BOTS_LOCAL_ROOT ? { temporaryDir: join(localRoot, 'tmp') } : {}), mcpCatalog });
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
      try {
        if (runtime) await runtime.close({ deadline });
        else await providers?.close();
      } finally { credentials.close(); await checkpoints.close(); }
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
  Promise.resolve().then<unknown>(() => {
    if (shutdown) throw new RuntimeError('unavailable', '应用正在关闭。');
    if (!runtime) throw new RuntimeError('unavailable', '客户端正在初始化，请稍后重试。');
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
