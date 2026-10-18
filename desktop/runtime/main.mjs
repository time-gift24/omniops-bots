import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import readline from 'node:readline';
import { ChatOpenAI } from '@langchain/openai';
import { embeddedBrowserConfig } from './browser-target.mjs';
import { createBrowserService } from './browser.mjs';
import { createScriptWorkspace } from './script-workspace.mjs';
import { createDesktopRuntime } from './runtime.mjs';
import { createResources } from './resources.mjs';
import { httpUrl } from './input.mjs';
import { invalid, RuntimeError, safeError } from './errors.mjs';

const dataDir = process.env.COGNACTA_DATA_DIR;
if (!dataDir) throw new Error('COGNACTA_DATA_DIR is required');
await mkdir(dataDir, { recursive: true, mode: 0o700 });
const modelFile = join(dataDir, 'model.env');
if (existsSync(modelFile)) process.loadEnvFile(modelFile);
const key = process.env.OPENAI_API_KEY;
const modelName = key && process.env.COGNACTA_MODEL || undefined;
const redact = value => String(value).replaceAll(key || '\0', '[redacted]');
const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
const browser = createBrowserService(embeddedBrowserConfig(process.env));
const workspace = await createScriptWorkspace({ dataDir, ensureBrowser: browser.ensure, signalEvent() {}, redact });
const resources = createResources();
const runtime = createDesktopRuntime({
  browser, workspace, modelName, emit: send, redact, getAgent: id => resources.getAgent(id),
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
      await runtime.close();
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
    return resources.hasMethod(method) ? resources.handle(method, params) : runtime.dispatch(method, params);
  }).then(result => send({ id, result }), error => send({ id, error: safeError(error) }));
});
input.on('close', () => { void close(); });
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => { void close(); });
process.stdout.on('error', () => { void close(); });
send({ event: 'ready', state: runtime.getState() });
