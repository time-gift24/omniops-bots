import type { ToolEvent } from './graphs/browser-agent.ts';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { invalid, RuntimeError } from './errors.ts';
import { writeJson } from './json-store.ts';
import type { GraphScope } from './execution/index.ts';

export type McpConfiguration = { id: string; name: string; description: string; url: string; credentialEnv?: string };
type Capability = { name: string; description: string; params?: string };
const serverSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/), name: z.string().trim().min(1).max(128),
  description: z.string().max(4096).default(''), url: z.string().url().max(2048),
  credentialEnv: z.string().regex(/^[A-Z_][A-Z0-9_]{0,127}$/).optional(),
}).strict();
export function validateMcp(value: unknown): McpConfiguration {
  const parsed = serverSchema.safeParse(value);
  if (!parsed.success) throw invalid('MCP 配置无效；凭据只能填写环境变量名称。');
  const url = new URL(parsed.data.url);
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password || url.search || url.hash) {
    throw invalid('MCP 地址必须为 HTTPS（本机测试允许 HTTP），且不能包含凭据、查询参数或片段。');
  }
  return { ...parsed.data, url: url.href };
}
export function createMcpCatalog({ directory }: { directory: string }) {
  const file = join(directory, 'mcp.json');
  let queue = Promise.resolve();
  async function list(): Promise<McpConfiguration[]> {
    try {
      const items: unknown = JSON.parse(await readFile(file, 'utf8'));
      if (!Array.isArray(items) || items.length > 64) throw invalid('本地 MCP 目录无效。');
      return items.map(validateMcp);
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  }
  async function get(id: string) {
    const config = (await list()).find(item => item.id === id);
    if (!config) throw invalid(`MCP ${id} 不存在，请检查 Agent 装配。`);
    return config;
  }
  function mutate(update: (items: McpConfiguration[]) => McpConfiguration[]) {
    const operation = queue.then(async () => {
      const next = update(await list());
      if (next.length > 64) throw invalid('最多配置 64 个 MCP 服务。');
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeJson(file, next);
    });
    queue = operation.catch(() => {});
    return operation;
  }
  return {
    list, get,
    save: (server: unknown) => { const config = validateMcp(server); return mutate(items => [...items.filter(item => item.id !== config.id), config]); },
    remove: (id: string) => mutate(items => items.filter(item => item.id !== id)),
  };
}

export async function connectMcp(configurations: readonly McpConfiguration[], {
  signal, scope, env = process.env, onTool = () => {}, redact = String,
}: { signal: AbortSignal; scope?: GraphScope; env?: NodeJS.ProcessEnv; onTool?: (event: ToolEvent) => void; redact?: (value: string) => string }) {
  const clients: Client[] = [];
  const tools: DynamicStructuredTool[] = [];
  const manifests: { id: string; url: string; tools: { name: string; sourceName: string; description?: string; inputSchema: Tool['inputSchema'] }[] }[] = [];
  const capabilities: { id: string; capabilities: { tools: Capability[]; resources: Capability[]; prompts: Capability[] } }[] = [];
  const names = new Set<string>();
  const options = { signal, timeout: 15_000 };
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    signal.removeEventListener('abort', abort);
    await Promise.allSettled(clients.map(client => client.close()));
  })();
  const abort = () => { void close(); };
  signal.addEventListener('abort', abort, { once: true });
  scope?.defer(close);
  try {
    for (const candidate of configurations) {
      signal.throwIfAborted();
      const config = validateMcp(candidate);
      const secret = config.credentialEnv ? env[config.credentialEnv] : undefined;
      const sanitized = <T>(value: T): T => JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'string' ? redact(secret ? item.replaceAll(secret, '[redacted]') : item) : item));
      const schemaMaps = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas', 'dependentRequired', 'dependencies']);
      const schemaMetadata = new Set(['description', 'title', '$comment', 'default', 'examples']);
      // Schema keywords, property names and validation literals are execution contracts.
      const sanitizedSchema = <T>(value: T, propertyMap = false): T => {
        if (Array.isArray(value)) return value.map(item => sanitizedSchema(item)) as T;
        if (!value || typeof value !== 'object') return value;
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
          !propertyMap && schemaMetadata.has(key) ? sanitized(item)
            : !propertyMap && ['const', 'enum'].includes(key) ? item
              : sanitizedSchema(item, !propertyMap && schemaMaps.has(key)),
        ])) as T;
      };
      if (config.credentialEnv && !secret) throw new RuntimeError('authentication', `MCP ${config.name} 缺少凭据环境变量 ${config.credentialEnv}。`);
      const client = new Client({ name: 'omniops-bots', version: '0.1.0' });
      clients.push(client);
      const transport = new StreamableHTTPClientTransport(new URL(config.url), {
        requestInit: { ...(secret ? { headers: { Authorization: `Bearer ${secret}` } } : {}), redirect: 'error' },
        fetch: (url, init) => fetch(url, { ...init, redirect: 'error', signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]) }),
      });
      try { await client.connect(transport, options); }
      catch { signal.throwIfAborted(); throw new RuntimeError('mcp-connection', `MCP ${config.name} 连接或认证失败，请检查地址和凭据。`); }
      const advertised = client.getServerCapabilities();
      const catalog: typeof capabilities[number] = { id: config.id, capabilities: { tools: [], resources: [], prompts: [] } };
      const manifest: typeof manifests[number] = { id: config.id, url: config.url, tools: [] };
      let cursor: string | undefined;
      const cursors = new Set<string>();
      do {
        let page;
        try { page = advertised?.tools ? await client.listTools(cursor ? { cursor } : {}, options) : { tools: [] }; }
        catch { signal.throwIfAborted(); throw new RuntimeError('mcp-discovery', `MCP ${config.name} 无法读取工具清单。`); }
        for (const definition of page.tools) {
          if (secret && definition.name.includes(secret)) throw invalid('MCP 工具名称包含敏感信息，请检查服务端配置。');
          const name = `mcp_${config.id}_${definition.name}`;
          if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name) || names.has(name)) throw invalid('MCP 工具名称无效或冲突。');
          names.add(name);
          if (names.size > 256) throw invalid('MCP 工具总数超过 256，请减少所选服务。');
          const description = definition.description === undefined ? undefined : sanitized(definition.description);
          const inputSchema = sanitizedSchema(definition.inputSchema);
          manifest.tools.push({ name, sourceName: definition.name, description, inputSchema });
          catalog.capabilities.tools.push({ name: definition.name, description: description ?? '', params: JSON.stringify(inputSchema) });
          tools.push(new DynamicStructuredTool({
            name, description: description || sanitized(`${config.name}: ${definition.name}`), schema: inputSchema,
            responseFormat: 'content_and_artifact',
            func: async (args, _manager, toolConfig) => {
              const nodeSignal = toolConfig?.signal ?? signal;
              const execute = async (operationSignal: AbortSignal) => {
                operationSignal.throwIfAborted();
                const call = { callId: (toolConfig as { toolCall?: { id?: string } })?.toolCall?.id, name, args: sanitized(args) };
                onTool({ type: 'start', ...call });
                try {
                  const result = await client.callTool({ name: definition.name, arguments: args }, undefined, { signal: operationSignal, timeout: 60_000 });
                  if (JSON.stringify(result).length > 2 * 1024 * 1024) throw new Error('oversized MCP result');
                  const safe = sanitized(result);
                  const error = result.isError ? `MCP ${config.name} 工具执行失败。` : undefined;
                  onTool({ type: 'end', ...call, result: safe, error });
                  operationSignal.throwIfAborted();
                  return [JSON.stringify(safe), { value: safe, executedArgs: call.args }];
                } catch {
                  operationSignal.throwIfAborted();
                  const error = `MCP ${config.name} 工具调用失败，请检查连接或服务状态。`;
                  onTool({ type: 'end', ...call, error });
                  return [JSON.stringify({ error }), { value: { error }, executedArgs: call.args }];
                }
              };
              return scope ? scope.operation(nodeSignal, execute) : execute(AbortSignal.any([signal, nodeSignal]));
            },
          }));
        }
        cursor = page.nextCursor;
        if (cursor && cursors.has(cursor)) throw invalid(`MCP ${config.name} 工具分页无效。`);
        if (cursor) cursors.add(cursor);
      } while (cursor);
      // Resources and prompts are discoverable metadata, never executable tools.
      for (const kind of ['resources', 'prompts'] as const) {
        if (!advertised?.[kind]) continue;
        cursor = undefined;
        cursors.clear();
        do {
          try {
            const input: { cursor?: string } = cursor ? { cursor } : {};
            if (kind === 'resources') {
              const page = await client.listResources(input, options);
              catalog.capabilities.resources.push(...page.resources.map(item => sanitized({ name: item.name, description: item.description ?? '', params: item.uri })));
              cursor = page.nextCursor;
            } else {
              const page = await client.listPrompts(input, options);
              catalog.capabilities.prompts.push(...page.prompts.map(item => ({ name: sanitized(item.name), description: sanitized(item.description ?? ''), params: JSON.stringify(sanitized(item.arguments ?? [])) })));
              cursor = page.nextCursor;
            }
          } catch { signal.throwIfAborted(); throw new RuntimeError('mcp-discovery', `MCP ${config.name} 无法读取${kind === 'resources' ? '资源' : '提示词'}清单。`); }
          if (catalog.capabilities[kind].length > 256 || (cursor && cursors.has(cursor))) throw invalid(`MCP ${config.name} 能力清单过大或分页无效。`);
          if (cursor) cursors.add(cursor);
        } while (cursor);
      }
      manifests.push(manifest);
      capabilities.push(catalog);
    }
    return { tools, manifests, capabilities, close };
  } catch (error) { await close(); throw error; }
}
