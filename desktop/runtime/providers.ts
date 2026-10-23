import { randomUUID } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { ChatOpenAI } from '@langchain/openai';
import { RuntimeError, invalid } from './errors.ts';
import { httpUrl, identifier } from './input.ts';
import { writeJson } from './json-store.ts';

export type ProviderSelection = { provider: string; model: string };
export type ProviderBinding = ProviderSelection & { id: string; baseURL: string; protocol: string; revision: string; credentialRef: string | null };
type ProviderInput = { name: string; baseURL: string; models: string[] };
type StoredProvider = ProviderInput & { revision: string; credentialRef: string | null };
type StoredCatalog = { version: number; providers: StoredProvider[]; defaultModel: ProviderSelection | null };
type Credentials = { get(reference: string): Promise<string | null>; set(reference: string, secret: string): Promise<unknown>; delete(reference: string): Promise<unknown> };
type CatalogOptions = { file: string; credentials: Credentials; legacy?: { model?: string; baseURL?: string; apiKey?: string } };
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('Provider 配置无效。');
  return value as Record<string, unknown>;
};
const fields = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};
const PROTOCOL = 'openai-chat-completions';
const MAX_PROVIDERS = 32;
const MAX_MODELS = 100;
const MAX_FILE = 4 * 1024 * 1024;
const KEY_LIMIT = 2560;
const REQUEST_TIMEOUT = 60_000;
const TEST_TIMEOUT = 15_000;
const failure = (kind: string, message: string, cause?: unknown) => Object.assign(new RuntimeError(kind, message), cause ? { cause } : {});
const named = (value: unknown, field: string) => identifier(value, field).trim();
const modelId = (provider: string, model: string) => JSON.stringify([provider, model]);

function baseAddress(value: unknown) {
  if (typeof value !== 'string' || value.length > 2048) throw invalid('接入地址不能超过 2048 个字符。');
  const url = new URL(httpUrl(value));
  if (url.href.includes('?') || url.href.includes('#')) throw invalid('接入地址不能包含查询参数或片段。');
  return url.href.replace(/\/+$/, '');
}

function keyValue(value: unknown) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > KEY_LIMIT || /[\x00-\x1f\x7f]/.test(value)) throw invalid('API Key 格式无效或过长。');
  return value.trim();
}

function providerInput(input: unknown): ProviderInput {
  const value = record(input);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('Provider 配置无效。');
  const name = named(value.name, 'Provider 名称');
  if (name.length > 64) throw invalid('Provider 名称不能超过 64 个字符。');
  const baseURL = baseAddress(value.baseURL);
  if (!Array.isArray(value.models) || value.models.length > MAX_MODELS) throw invalid(`每个 Provider 最多支持 ${MAX_MODELS} 个模型。`);
  const models = value.models.map(model => named(model, '模型名称'));
  if (models.some(model => model.length > 128 || modelId(name, model).length > 256)) throw invalid('模型名不能超过 128 个字符，模型组合标识不能超过 256 个字符。');
  if (new Set(models).size !== models.length) throw invalid('同一个 Provider 的模型名称不能重复。');
  return { name, baseURL, models };
}

function selection(input: unknown): ProviderSelection {
  const value = record(input);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('请选择有效的 Provider 和模型。');
  return { provider: named(value.provider, 'Provider 名称'), model: named(value.model, '模型名称') };
}

function storedCatalog(input: unknown): StoredCatalog {
  const value = record(input);
  if (!value || value.version !== 1 || !Array.isArray(value.providers) || value.providers.length > MAX_PROVIDERS ||
      Object.keys(value).some(key => !['version', 'providers', 'defaultModel'].includes(key))) throw invalid('Provider 配置文件无效。');
  const providers = value.providers.map((item: unknown) => {
    const provider = record(item);
    if (Object.keys(provider).some(key => !['name', 'baseURL', 'models', 'revision', 'credentialRef'].includes(key))) throw invalid('Provider 配置字段无效。');
    const input = providerInput(provider);
    const revision = named(provider.revision, '配置修订');
    const credentialRef = provider.credentialRef === null ? null : named(provider.credentialRef, '凭据引用');
    if (credentialRef !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(credentialRef)) throw invalid('凭据引用无效。');
    return { ...input, revision, credentialRef };
  });
  if (new Set(providers.map(provider => provider.name)).size !== providers.length) throw invalid('Provider 名称不能重复。');
  const defaultModel = value.defaultModel === null ? null : selection(value.defaultModel);
  if (defaultModel && !providers.some(provider => provider.name === defaultModel.provider && provider.models.includes(defaultModel.model))) throw invalid('默认模型无法解析。');
  return { version: 1, providers, defaultModel };
}

function safeFailure(error: unknown, signal?: AbortSignal) {
  if (signal?.aborted) return failure(signal.reason?.name === 'TimeoutError' ? 'timeout' : 'aborted', signal.reason?.name === 'TimeoutError' ? '连接测试超时。' : '连接测试已停止。', error);
  for (let cause = error, depth = 0; cause && depth < 5; cause = fields(cause).cause, depth += 1) {
    if (cause instanceof RuntimeError) return cause;
    if (fields(cause).name === 'TimeoutError' || fields(cause).name === 'APIConnectionTimeoutError' || fields(cause).code === 'ETIMEDOUT') return failure('timeout', '模型请求超时。', error);
  }
  const status = fields(error).status;
  if (status === 401 || status === 403) return failure('authentication', '模型认证失败，请检查 API Key。', error);
  if (status === 429) return failure('rate-limited', '模型服务暂时限流，请稍后重试。', error);
  if (['model_not_found', 'model_not_available'].includes(String(fields(error).code ?? fields(fields(error).error).code))) return failure('model-unavailable', '所选模型不可用，请检查模型名称和权限。', error);
  if (Number.isInteger(status)) return failure('upstream', '模型服务拒绝了本次请求。', error);
  return failure('connection', '模型连接失败，请检查网络、证书和接入地址。', error);
}

/**
 * Local Provider boundary; no method logs keys, prompts, responses, or SDK errors.
 *
 * createProviderCatalog({ file: string, credentials: { get(ref): Promise<string|null>,
 * set(ref, secret): Promise<void>, delete(ref): Promise<void> },
 * legacy?: { model: string, baseURL?: string, apiKey?: string } }): Promise<Catalog>.
 * A missing file imports legacy once; an unreadable/invalid file stays retryable through read().
 *
 * Catalog.read/save/remove/setDefault -> Promise<{providers: Array<{name,baseURL,models,hasKey}>,
 * defaultModel: {provider,model}|null}>. save({originalName?,name,baseURL,models,apiKey?})
 * keeps undefined keys, clears null/empty keys, and replaces nonempty keys. Configuration writes
 * are atomic and serialized; failed writes preserve the previous configuration and key.
 * models() -> Promise<Array<{id,label,isDefault}>>; pin(id?) -> Promise<Binding>.
 * Binding = {id,provider,model,baseURL,protocol,revision,credentialRef}; it contains no key value.
 * createModel(binding) -> Promise<ChatOpenAI>; every request rechecks the pinned identity and key.
 * test({provider,model}, {signal}?) -> Promise<void>; fixed minimal text, no tools, 15 s deadline.
 * redact(string) -> string removes keys read/written by this instance. close() cancels tests and
 * requests and drains pending file/credential operations; callers must still close their graphs.
 * Failures use RuntimeError: invalid-request, storage, credentials, unavailable, authentication,
 * model-unavailable, rate-limited, upstream, connection, timeout, aborted, incomplete-response.
 *
 * @example
 * const catalog = await createProviderCatalog({file, credentials});
 * await catalog.save({name:'本地', baseURL:'http://localhost:8000/v1', models:['local']});
 * await catalog.setDefault({provider:'本地', model:'local'});
 * const model = await catalog.createModel(await catalog.pin());
 * await model.invoke('你好');
 * await catalog.close();
 */
export async function createProviderCatalog({ file, credentials, legacy }: CatalogOptions) {
  if (typeof file !== 'string' || !file || !credentials || (['get', 'set', 'delete'] as const).some(method => typeof credentials[method] !== 'function')) throw invalid('Provider 存储依赖无效。');
  let current: StoredCatalog | undefined, readError: RuntimeError | undefined, closing = false;
  let tail = Promise.resolve<unknown>(undefined);
  const secrets = new Set<string>();
  const garbage = new Set<string>();
  const lifetime = new AbortController();
  const remember = (secret: string) => {
    secrets.add(secret);
    if (secrets.size > 256) secrets.delete(secrets.values().next().value!);
  };
  const enqueue = <T>(work: () => T | Promise<T>): Promise<T> => {
    if (closing) return Promise.reject(failure('unavailable', 'Provider 管理正在关闭。'));
    const pending = tail.then(work);
    tail = pending.catch(() => {});
    return pending;
  };
  const configured = () => {
    if (readError) throw readError;
    if (!current) throw failure('storage', '请重新读取 Provider 配置。');
    return current;
  };
  const publicCatalog = () => ({
    providers: configured().providers.map(({ name, baseURL, models, credentialRef }) => ({ name, baseURL, models: [...models], hasKey: credentialRef !== null })),
    defaultModel: configured().defaultModel ? { ...configured().defaultModel! } : null,
  });
  const credential = async (method: 'get' | 'set', reference: string, secret?: string): Promise<string | null> => {
    try { if (method === 'get') return await credentials.get(reference); await credentials.set(reference, secret!); return null; }
    catch (cause) { throw failure('credentials', '操作系统凭据库不可用，请解锁或检查访问权限后重试。', cause); }
  };
  const cleanup = async (ref?: string | null) => {
    if (!ref) return;
    try { await credentials.delete(ref); garbage.delete(ref); }
    catch { if (garbage.size < MAX_PROVIDERS) garbage.add(ref); }
  };
  const writeCredential = async (ref: string, secret: string) => {
    remember(secret);
    try { await credential('set', ref, secret); }
    catch (error) { await cleanup(ref); throw error; }
  };
  const commit = async (next: StoredCatalog, newRef?: string | null) => {
    try { await writeJson(file, next); }
    catch (cause) {
      await cleanup(newRef);
      throw failure('storage', 'Provider 保存失败，原配置仍然有效，请重试。', cause);
    }
    current = next;
    readError = undefined;
    return publicCatalog();
  };
  const read = () => enqueue(async () => {
    try {
      let value: unknown;
      try {
        const stat = await lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE) throw new Error('Invalid provider file');
        value = JSON.parse(await readFile(file, 'utf8'));
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
        const initial: StoredCatalog = { version: 1, providers: [], defaultModel: null };
        value = initial;
        if (legacy?.model) {
          const provider = providerInput({ name: '默认接入', baseURL: legacy.baseURL || 'https://api.openai.com/v1', models: [legacy.model] });
          const secret = legacy.apiKey === undefined ? '' : keyValue(legacy.apiKey);
          const ref = secret ? randomUUID() : null;
          if (secret) await writeCredential(ref!, secret);
          initial.providers.push({ ...provider, revision: randomUUID(), credentialRef: ref });
          initial.defaultModel = { provider: provider.name, model: provider.models[0] };
          await commit(initial, ref);
        }
      }
      current = storedCatalog(value);
      readError = undefined;
      return publicCatalog();
    } catch (cause) {
      readError = cause instanceof RuntimeError && cause.kind === 'credentials' ? cause : failure('storage', '无法读取 Provider 配置，请检查本地文件后重试。', cause);
      throw readError;
    }
  });
  const find = (chosen: ProviderSelection) => {
    const provider = configured().providers.find(item => item.name === chosen.provider);
    if (!provider || !provider.models.includes(chosen.model)) throw failure('unavailable', '所选 Provider 或模型已不可用，请配置或选择有效模型。');
    return provider;
  };
  const pinSelection = (chosen: ProviderSelection): ProviderBinding => {
    const provider = find(chosen);
    return { id: modelId(provider.name, chosen.model), provider: provider.name, model: chosen.model, baseURL: provider.baseURL, protocol: PROTOCOL, revision: provider.revision, credentialRef: provider.credentialRef };
  };
  const pin = (id?: string) => enqueue(() => {
    let chosen = configured().defaultModel;
    if (id !== undefined) {
      try {
        const parsed = JSON.parse(identifier(id, '模型选择'));
        if (!Array.isArray(parsed) || parsed.length !== 2) throw new Error('Invalid model id');
        chosen = selection({ provider: parsed[0], model: parsed[1] });
      } catch { throw invalid('模型选择无效，请重新选择 Provider 和模型。'); }
    }
    if (!chosen) throw failure('unavailable', '请设置默认模型或明确选择 Provider 和模型。');
    return pinSelection(chosen);
  });
  const resolveBinding = (binding: ProviderBinding) => enqueue(async () => {
    if (!binding || typeof binding !== 'object') throw invalid('会话模型配置无效。');
    const fixed = pinSelection(selection(binding));
    if ((Object.keys(fixed) as (keyof ProviderBinding)[]).some(field => fixed[field] !== binding[field])) throw failure('unavailable', '此会话固定的 Provider 配置已不可用，请恢复原配置或开始新会话。');
    let secret: string | null = null;
    if (fixed.credentialRef) {
      secret = await credential('get', fixed.credentialRef);
      if (typeof secret !== 'string' || !secret.trim() || Buffer.byteLength(secret) > KEY_LIMIT || /[\x00-\x1f\x7f]/.test(secret)) throw failure('credentials', '此会话需要的 API Key 不可用，请检查操作系统凭据库。');
      remember(secret);
    }
    return { ...fixed, secret };
  });
  const createModel = async (binding: ProviderBinding, maxTokens?: number) => {
    const fixed = { ...binding };
    await resolveBinding(fixed);
    const target = `${fixed.baseURL}/chat/completions`;
    const secureFetch: typeof fetch = async (url, init = {}) => {
      const resolved = await resolveBinding(fixed);
      if (String(url) !== target) throw failure('unavailable', '模型请求地址与固定接入不一致。');
      // The SDK can inherit arbitrary OPENAI_CUSTOM_HEADERS; this boundary owns all auth.
      const headers = new Headers({ 'content-type': 'application/json', accept: 'application/json' });
      if (resolved.secret) headers.set('authorization', `Bearer ${resolved.secret}`);
      const signal = init.signal ? AbortSignal.any([init.signal, lifetime.signal]) : lifetime.signal;
      const response = await fetch(url, { ...init, headers, signal, redirect: 'error' });
      const streaming = JSON.parse(String(init.body)).stream === true;
      if (!response.ok || !streaming) return response;
      if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'text/event-stream' || !response.body) {
        await response.body?.cancel().catch(() => {});
        throw failure('incomplete-response', '模型没有返回兼容的流式响应。');
      }
      // The SDK accepts clean EOF without [DONE]; require the protocol terminator instead.
      let pending = '', complete = false;
      const choices = new Map<number, boolean>();
      const decoder = new TextDecoder();
      const inspectLine = (line: string) => {
        if (!line.startsWith('data:')) return;
        const data = line.slice(5).trim();
        if (data === '[DONE]') {
          // The SDK stops at this event, so flush() alone cannot enforce completion.
          if (!choices.size || [...choices.values()].some(terminal => !terminal)) throw failure('incomplete-response', '模型响应缺少完整的终止状态。');
          complete = true;
          return;
        }
        if (!data) return;
        let event;
        try { event = JSON.parse(data); }
        catch (cause) { throw failure('incomplete-response', '模型返回了无效的流式响应。', cause); }
        if (event?.choices === undefined) return; // The SDK classifies structured upstream errors.
        if (!Array.isArray(event.choices)) throw failure('incomplete-response', '模型返回了不兼容的流式响应。');
        for (const choice of event.choices) {
          if (!choice || !Number.isSafeInteger(choice.index) || choice.index < 0 || choice.index > 15 ||
              (choice.delta?.content != null && typeof choice.delta.content !== 'string')) throw failure('incomplete-response', '模型返回了不兼容的流式响应。');
          if (!choices.has(choice.index)) choices.set(choice.index, false);
          const finish = choice.finish_reason;
          if (finish === undefined || finish === null) continue;
          if (!['stop', 'tool_calls'].includes(finish)) throw failure('incomplete-response', '模型响应未完整完成，可能达到输出上限或被内容过滤。');
          choices.set(choice.index, true);
        }
      };
      const body = response.body.pipeThrough(new TransformStream({
        transform(chunk, controller) {
          pending += decoder.decode(chunk, { stream: true });
          if (pending.length > 2 * 1024 * 1024) throw failure('incomplete-response', '模型流式响应超过单条事件限制。');
          const lines = pending.split('\n');
          pending = lines.pop() ?? '';
          for (const line of lines) inspectLine(line);
          controller.enqueue(chunk);
        },
        flush() {
          inspectLine(pending + decoder.decode());
          if (!complete) throw failure('incomplete-response', '模型响应未完整结束，请手动重试。');
        },
      }));
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    };
    return new ChatOpenAI({
      model: fixed.model, apiKey: 'omniops-local-credential', temperature: 0, maxTokens,
      useResponsesApi: false, timeout: REQUEST_TIMEOUT, maxRetries: 0,
      modelKwargs: { parallel_tool_calls: false, ...(new URL(fixed.baseURL).hostname === 'api.deepseek.com' ? { thinking: { type: 'disabled' } } : {}) },
      configuration: { baseURL: fixed.baseURL, fetch: secureFetch, organization: null, project: null, adminAPIKey: null, logLevel: 'off', defaultHeaders: { Authorization: null } },
    });
  };
  await read().catch(() => {});
  return {
    read,
    save: (raw: unknown) => enqueue(async () => {
      const value = record(raw);
      configured();
      const input = providerInput(value);
      const originalName = value.originalName === undefined ? undefined : named(value.originalName, '原 Provider 名称');
      const existing = originalName === undefined ? undefined : configured().providers.find(provider => provider.name === originalName);
      if (originalName !== undefined && !existing) throw failure('unavailable', '原 Provider 已不可用，请重新读取配置。');
      if (configured().providers.some(provider => provider.name === input.name && provider !== existing)) throw invalid('Provider 名称已经存在。');
      if (!existing && configured().providers.length >= MAX_PROVIDERS) throw invalid(`最多支持 ${MAX_PROVIDERS} 个 Provider。`);
      const secret = value.apiKey === undefined ? undefined : value.apiKey === null ? '' : keyValue(value.apiKey);
      let credentialRef = existing?.credentialRef ?? null;
      let newRef: string | undefined;
      if (secret !== undefined) {
        credentialRef = secret ? randomUUID() : null;
        if (secret) { newRef = credentialRef!; await writeCredential(newRef, secret); }
      }
      const unchangedIdentity = existing && existing.name === input.name && existing.baseURL === input.baseURL && existing.credentialRef === credentialRef;
      const nextProvider = { ...input, credentialRef, revision: unchangedIdentity ? existing.revision : randomUUID() };
      let defaultModel = configured().defaultModel;
      if (existing && defaultModel?.provider === existing.name && (input.name !== existing.name || !input.models.includes(defaultModel.model))) defaultModel = null;
      const next = { version: 1, providers: existing ? configured().providers.map(provider => provider === existing ? nextProvider : provider) : [...configured().providers, nextProvider], defaultModel };
      const result = await commit(next, newRef);
      if (existing?.credentialRef !== credentialRef) await cleanup(existing?.credentialRef);
      return result;
    }),
    remove: (name: unknown) => enqueue(async () => {
      const providerName = named(name, 'Provider 名称');
      const existing = configured().providers.find(provider => provider.name === providerName);
      if (!existing) throw failure('unavailable', 'Provider 已不可用，请重新读取配置。');
      const result = await commit({ version: 1, providers: configured().providers.filter(provider => provider !== existing), defaultModel: configured().defaultModel?.provider === providerName ? null : configured().defaultModel });
      await cleanup(existing.credentialRef);
      return result;
    }),
    setDefault: (value: unknown) => enqueue(async () => {
      const chosen = selection(value);
      find(chosen);
      return commit({ ...configured(), defaultModel: chosen });
    }),
    models: () => enqueue(() => configured().providers.flatMap(provider => provider.models.map(model => ({
      id: modelId(provider.name, model), label: `${provider.name} / ${model}`,
      isDefault: configured().defaultModel?.provider === provider.name && configured().defaultModel?.model === model,
    })))),
    pin,
    createModel: (binding: ProviderBinding) => createModel(binding),
    async test(value: unknown, { signal }: { signal?: AbortSignal } = {}) {
      const chosen = selection(value);
      const boundSignal = AbortSignal.any([...(signal ? [signal] : []), lifetime.signal, AbortSignal.timeout(TEST_TIMEOUT)]);
      let listener: (() => void) | undefined;
      try {
        await Promise.race([
          (async () => {
            const binding = await pin(modelId(chosen.provider, chosen.model));
            const model = await createModel(binding, 8);
            boundSignal.throwIfAborted();
            let finish;
            for await (const chunk of await model.stream('Reply OK.', { signal: boundSignal })) finish = chunk.response_metadata?.finish_reason ?? finish;
            boundSignal.throwIfAborted();
            if (finish !== 'stop') throw failure('incomplete-response', '模型响应未正常完成，请检查模型兼容性。');
          })(),
          new Promise((_, reject) => {
            listener = () => reject(boundSignal.reason);
            if (boundSignal.aborted) listener();
            else boundSignal.addEventListener('abort', listener, { once: true });
          }),
        ]);
      } catch (error) { throw safeFailure(error, boundSignal); }
      finally { if (listener) boundSignal.removeEventListener('abort', listener); }
    },
    redact(value: unknown) {
      const pattern = new RegExp(['\\[redacted\\]', ...[...secrets].sort((a, b) => b.length - a.length).map(RegExp.escape)].join('|'), 'g');
      return String(value).replace(pattern, '[redacted]');
    },
    async close() {
      if (!closing) { closing = true; lifetime.abort(); }
      await tail;
      await Promise.all([...garbage].map(cleanup));
    },
  };
}
