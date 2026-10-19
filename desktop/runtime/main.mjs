import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createMcpCatalog, connectMcp } from './mcp.ts';
import readline from 'node:readline';
import { ChatOpenAI } from '@langchain/openai';
import { embeddedBrowserConfig } from './browser/browser-target.mjs';
import { createBrowserService } from './browser/browser.mjs';
import { createScriptWorkspace } from './browser/script-workspace.mjs';
import { openSqliteCheckpointer } from './execution/sqlite.ts';
import { createDesktopRuntime } from './runtime.mjs';
import { createResources } from './resources.mjs';
import { httpUrl } from './input.mjs';
import { invalid, RuntimeError, safeError } from './errors.mjs';

const dataDir = process.env.OMNIOPS_BOTS_DATA_DIR;
if (!dataDir) throw new Error('OMNIOPS_BOTS_DATA_DIR is required');
await mkdir(dataDir, { recursive: true, mode: 0o700 });
const modelFile = join(dataDir, 'model.env');
if (existsSync(modelFile)) process.loadEnvFile(modelFile);
const key = process.env.OPENAI_API_KEY;
const modelName = key && process.env.OMNIOPS_BOTS_MODEL || undefined;
const redact = value => String(value).replaceAll(key || '\0', '[redacted]');
const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
const browser = createBrowserService(embeddedBrowserConfig(process.env));
const localRoot = process.env.OMNIOPS_BOTS_LOCAL_ROOT || join(homedir(), '.omnimind-ops');
const runsDir = join(localRoot, 'runs');
const mcpCatalog = createMcpCatalog({ directory: join(localRoot, 'config') });
const resources = createResources({ skillsDir: join(localRoot, 'skills'), agentsDir: join(localRoot, 'agents'), runsDir, mcpCatalog });
const checkpoints = await openSqliteCheckpointer(join(localRoot, 'checkpoints.sqlite'));
const runtime = await createDesktopRuntime({
  browser, resources, runsDir, modelName, emit: send, redact, checkpointer: checkpoints.checkpointer,
  timeoutMs: process.env.OMNIOPS_BOTS_RUN_TIMEOUT_MS ? Number(process.env.OMNIOPS_BOTS_RUN_TIMEOUT_MS) : 300_000,
  workspaceFactory: session => createScriptWorkspace({ dataDir: session.directory, ensureBrowser: browser.ensure, signalEvent: send, redact }),
  modelFactory(model) {
    if (!key || !modelName) throw new RuntimeError('unavailable', '请配置本地模型后重启。');
    const baseURL = process.env.OPENAI_BASE_URL ? httpUrl(process.env.OPENAI_BASE_URL) : undefined;
    const deepseek = baseURL && new URL(baseURL).hostname === 'api.deepseek.com';
    return new ChatOpenAI({
      model, apiKey: key, ...(baseURL ? { configuration: { baseURL } } : {}),
      temperature: 0, useResponsesApi: false, timeout: 60_000, maxRetries: 0,
      modelKwargs: { parallel_tool_calls: false, ...(deepseek ? { thinking: { type: 'disabled' } } : {}) },
    });
  },
});

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let shutdown;
function close(id) {
  if (!shutdown) {
    const deadline = setTimeout(() => process.exit(1), 10_000);
    shutdown = Promise.resolve().then(async () => {
      input.close();
      try { await runtime.close(); }
      finally { await checkpoints.close(); }
      if (id !== undefined) send({ id, result: { stopped: true } });
      await new Promise(resolve => process.stdout.write(`${JSON.stringify({ event: 'exit' })}\n`, resolve));
      clearTimeout(deadline);
      process.exit(0);
    }).catch(() => { clearTimeout(deadline); process.exit(1); });
  }
  return shutdown;
}

input.on('line', line => {
  let request;
  try {
    if (Buffer.byteLength(line) > 40 * 1024 * 1024) throw invalid('请求超过大小限制。');
    request = JSON.parse(line);
    if (!request || !Number.isSafeInteger(request.id) || request.id < 0 || typeof request.method !== 'string') throw invalid('IPC 请求格式无效。');
  } catch (error) {
    send({ id: Number.isSafeInteger(request?.id) ? request.id : null, error: error instanceof RuntimeError ? safeError(error) : safeError(invalid('IPC 请求格式无效。')) });
    return;
  }
  const { id, method, params } = request;
  if (method === 'shutdown') { void close(id); return; }
  Promise.resolve().then(() => {
    if (shutdown) throw new RuntimeError('unavailable', '应用正在关闭。');
    if (method === 'mcp_save') return mcpCatalog.save(params?.server);
    if (method === 'mcp_remove') return mcpCatalog.remove(params?.id);
    if (method === 'mcp_test') return (async () => {
      const connection = await connectMcp([await mcpCatalog.get(params?.id)], { signal: AbortSignal.timeout(15_000), redact });
      try { return connection.capabilities[0].capabilities; }
      finally { await connection.close(); }
    })();
    return resources.hasMethod(method) ? resources.handle(method, params) : runtime.dispatch(method, params);
  }).then(result => send({ id, result }), error => send({ id, error: safeError(error) }));
});
input.on('close', () => { void close(); });
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => { void close(); });
process.stdout.on('error', () => { void close(); });
send({ event: 'ready', state: runtime.getState() });
