import { createHash, randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import WebSocket from 'ws';
import { canonicalize } from 'json-canonicalize';
import { A2A_VERSION_HEADER, HTTP_EXTENSION_HEADER, Extensions, StreamResponse, TaskState } from '@a2a-js/sdk';
import { JsonRpcTransportHandler, ServerCallContext, validateVersion } from '@a2a-js/sdk/server';
import {
  A2AError, A2A_ERROR_CODE, RequestMalformedError, TaskNotFoundError, TaskNotCancelableError,
  UnsupportedOperationError, ContentTypeNotSupportedError, PushNotificationNotSupportedError,
  ExtensionSupportRequiredError, VersionNotSupportedError, ExtendedAgentCardNotConfiguredError,
  InvalidAgentResponseError, JsonRpcRequestMalformedError, JsonRpcTransportError, fromJsonRpcErrorResponse,
} from '@a2a-js/sdk/errors';
import { identifier } from '../input.ts';
import { RuntimeError } from '../errors.ts';
import type { A2APrincipal, A2AService, CallOptions, CloseOptions } from './index.ts';

export const WSS_BINDING = 'urn:omniops:a2a:binding:wss-jsonrpc:v1';
export const DELIVERY_RECEIPT_EXTENSION = 'urn:omniops:a2a:extension:delivery-receipt:v1';
export type WssCredentials = Readonly<{ authorization: string; principal: A2APrincipal; expiresAt: string }>;
export type WssLimits = Readonly<{
  maxMessageBytes: number; maxHeaderBytes: number; maxInFlightRequests: number; maxStreams: number;
  maxOutboundMessages: number; maxOutboundBytes: number; connectTimeoutMs: number; callTimeoutMs: number;
  heartbeatIntervalMs: number; pongTimeoutMs: number; reconnectMinMs: number; reconnectMaxMs: number; closeTimeoutMs: number;
}>;
export const DEFAULT_WSS_LIMITS: WssLimits = Object.freeze({
  maxMessageBytes: 2 * 1024 * 1024, maxHeaderBytes: 8 * 1024,
  maxInFlightRequests: 32, maxStreams: 16, maxOutboundMessages: 32, maxOutboundBytes: 8 * 1024 * 1024,
  connectTimeoutMs: 10_000, callTimeoutMs: 120_000, heartbeatIntervalMs: 20_000,
  pongTimeoutMs: 10_000, reconnectMinMs: 500, reconnectMaxMs: 30_000, closeTimeoutMs: 3000,
});
export type WssStatus = Readonly<{
  state: 'connected' | 'reconnecting' | 'blocked' | 'closing' | 'closed';
  reason?: 'network' | 'authentication' | 'forbidden' | 'protocol' | 'backpressure' | 'unknown';
}>;
export type A2AWssOptions = Readonly<{
  url: string; service: A2AService;
  getCredentials: (options: Readonly<{ origin: string; signal: AbortSignal }>) => Promise<WssCredentials>;
  limits: WssLimits;
}>;
export interface A2AWssAdapter {
  getStatus(): WssStatus;
  subscribe(listener: (status: WssStatus) => void): () => void;
  close(options: CloseOptions): Promise<void>;
}

type Wire = { jsonrpc: string; id: string | number | null; result?: unknown; error?: unknown };
type Request = Record<string, unknown> & { jsonrpc: '2.0'; id: string | number; method: string; params: Record<string, unknown> };
type Reason = NonNullable<WssStatus['reason']>;
type Job = { controller: AbortController; work: Promise<void>; timer: ReturnType<typeof setTimeout>; iterator?: AsyncGenerator<Wire, void, undefined> };
type Send = {
  text: string; bytes: number; resolve: () => void; reject: (error: unknown) => void;
  signal?: AbortSignal; abort?: () => void; started: boolean; settled: boolean;
};
type Connection = {
  ws: WebSocket; controller: AbortController; principal: A2APrincipal; expiresAt: number;
  ready: boolean; ended: boolean; jobs: Map<string | number, Job>; streams: number;
  queue: Send[]; outboundBytes: number; sending: boolean;
  heartbeat?: ReturnType<typeof setTimeout>; pong?: ReturnType<typeof setTimeout>;
  expiry?: ReturnType<typeof setTimeout>; termination?: ReturnType<typeof setTimeout>; ping?: string;
  closed: Promise<void>; cleanup?: Promise<void>;
};
const terminalStates = new Set([TaskState.TASK_STATE_COMPLETED, TaskState.TASK_STATE_FAILED, TaskState.TASK_STATE_CANCELED, TaskState.TASK_STATE_REJECTED]);
const categories = new Set(['authentication', 'forbidden', 'storage', 'resource-limit', 'unavailable', 'aborted', 'unknown']);
const certificateCodes = new Set(['ERR_TLS_CERT_ALTNAME_INVALID', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_TLS_CERT_SIGNATURE_ALGORITHM_UNSUPPORTED']);
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype);
function failure(kind: string, cause?: unknown): RuntimeError {
  return Object.assign(new RuntimeError(kind, kind === 'aborted' ? 'WSS 等待已结束。' : 'WSS 任务通道不可用。'), cause === undefined ? {} : { cause });
}
function validIdentifier(value: unknown): string {
  const result = identifier(value, 'A2A identifier');
  if (!result.isWellFormed()) throw failure('invalid-request');
  return result;
}
function safeProtocolError(error: unknown): A2AError {
  if (error instanceof RuntimeError && error.kind === 'invalid-request') return new RequestMalformedError();
  if (error instanceof A2AError && 'envelopeCode' in error && error.envelopeCode === A2A_ERROR_CODE.METHOD_NOT_FOUND) {
    return new JsonRpcTransportError({ jsonrpc: '2.0', id: null, error: { code: A2A_ERROR_CODE.METHOD_NOT_FOUND, message: 'Invalid method.' } });
  }
  for (const Type of [RequestMalformedError, TaskNotFoundError, TaskNotCancelableError, UnsupportedOperationError,
    ContentTypeNotSupportedError, PushNotificationNotSupportedError, ExtensionSupportRequiredError,
    VersionNotSupportedError, ExtendedAgentCardNotConfiguredError, InvalidAgentResponseError]) {
    if (error instanceof Type) {
      if (error instanceof RequestMalformedError && 'envelopeCode' in error &&
          [A2A_ERROR_CODE.PARSE_ERROR, A2A_ERROR_CODE.INVALID_REQUEST].includes(error.envelopeCode as -32700 | -32600)) {
        return new JsonRpcRequestMalformedError({ envelopeCode: error.envelopeCode as number, message: 'Invalid JSON-RPC request.' });
      }
      return new Type();
    }
  }
  const detail = error instanceof JsonRpcTransportError && Array.isArray(error.data)
    ? error.data.find(value => object(value) && value['@type'] === 'type.googleapis.com/google.rpc.ErrorInfo' && value.domain === 'a2a-protocol.org') : undefined;
  const category = error instanceof RuntimeError ? error.kind : error instanceof A2AError
    ? error.metadata?.category ?? (object(detail) && object(detail.metadata) && typeof detail.metadata.category === 'string' ? detail.metadata.category : undefined) : undefined;
  return new A2AError({ message: 'A2A request cannot be completed.', metadata: { category: category && categories.has(category) ? category : 'unknown' } });
}
function errorWire(id: Wire['id'], error: unknown): Wire {
  return { jsonrpc: '2.0', id, error: JsonRpcTransportHandler.mapToJSONRPCError(safeProtocolError(error)) };
}
function safeWire(wire: Wire): Wire {
  if (!object(wire.error)) return wire;
  const raw = wire.error;
  if (typeof raw.code !== 'number') return errorWire(wire.id, undefined);
  try {
    return errorWire(wire.id, fromJsonRpcErrorResponse({ jsonrpc: '2.0', id: wire.id, error: { code: raw.code, message: typeof raw.message === 'string' ? raw.message : '', data: Array.isArray(raw.data) ? raw.data : undefined } }));
  } catch { return errorWire(wire.id, undefined); }
}
function signalOption(value: unknown): asserts value is AbortSignal | undefined {
  if (value !== undefined && !(value instanceof AbortSignal)) throw failure('invalid-request');
}
function wait<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(failure('aborted', signal.reason)); };
    if (signal.aborted) { void work.catch(() => {}); abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    void work.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}
function deadline<T>(work: Promise<T>, at: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(failure('timeout')), Math.max(0, Math.min(at - performance.now(), 2_147_483_647)));
    void work.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}
function checkJson(value: unknown, depth = 0): void {
  if (depth > 32) throw new RequestMalformedError();
  if (typeof value === 'string') { if (!value.isWellFormed()) throw new RequestMalformedError(); return; }
  if (value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return;
  if (!Array.isArray(value) && !object(value)) throw new RequestMalformedError();
  for (const [key, child] of Object.entries(value)) {
    if (!key.isWellFormed()) throw new RequestMalformedError();
    checkJson(child, depth + 1);
  }
}
function params(request: Request): void {
  const p = request.params;
  validIdentifier(p.tenant);
  const str = (o: Record<string, unknown>, key: string) => { if (o[key] !== undefined && typeof o[key] !== 'string') throw new RequestMalformedError(); };
  const bool = (o: Record<string, unknown>, key: string) => { if (o[key] !== undefined && typeof o[key] !== 'boolean') throw new RequestMalformedError(); };
  const integer = (o: Record<string, unknown>, key: string) => { if (o[key] !== undefined && (!Number.isSafeInteger(o[key]) || (o[key] as number) < 0)) throw new RequestMalformedError(); };
  const strings = (o: Record<string, unknown>, key: string) => { if (o[key] !== undefined && (!Array.isArray(o[key]) || !o[key].every(item => typeof item === 'string'))) throw new RequestMalformedError(); };
  const map = (o: Record<string, unknown>, key: string) => { if (o[key] !== undefined && !object(o[key])) throw new RequestMalformedError(); };
  for (const key of ['id', 'taskId', 'contextId', 'pageToken', 'statusTimestampAfter']) str(p, key);
  for (const key of ['historyLength', 'pageSize']) integer(p, key);
  bool(p, 'includeArtifacts'); map(p, 'metadata');
  if (request.method === 'SendMessage' || request.method === 'SendStreamingMessage') {
    if (!object(p.message)) throw new RequestMalformedError();
    const m = p.message;
    validIdentifier(m.messageId);
    for (const key of ['contextId', 'taskId']) str(m, key);
    if (m.role !== 'ROLE_USER' && m.role !== 1) throw new RequestMalformedError();
    strings(m, 'referenceTaskIds'); strings(m, 'extensions'); map(m, 'metadata');
    if (!Array.isArray(m.parts) || m.parts.length !== 1 || !object(m.parts[0]) || !object(m.parts[0].data)) throw new RequestMalformedError();
    const part = m.parts[0];
    if (Object.keys(part).some(key => !['data', 'mediaType', 'metadata', 'filename'].includes(key))) throw new RequestMalformedError();
    str(part, 'mediaType'); str(part, 'filename'); map(part, 'metadata');
    if (p.configuration !== undefined) {
      if (!object(p.configuration)) throw new RequestMalformedError();
      strings(p.configuration, 'acceptedOutputModes'); integer(p.configuration, 'historyLength');
      bool(p.configuration, 'returnImmediately'); map(p.configuration, 'taskPushNotificationConfig');
    }
  }
  if (request.method === 'ListTasks' && p.status !== undefined &&
      !(typeof p.status === 'string' && /^TASK_STATE_(UNSPECIFIED|SUBMITTED|WORKING|COMPLETED|FAILED|CANCELED|INPUT_REQUIRED|REJECTED|AUTH_REQUIRED)$/.test(p.status)) &&
      !(Number.isSafeInteger(p.status) && (p.status as number) >= 0 && (p.status as number) <= 8)) throw new RequestMalformedError();
}
function negotiated(response: IncomingMessage, maxBytes: number): void {
  const headers = new Map<string, string[]>();
  let all = 0, project = 0;
  for (let n = 0; n < response.rawHeaders.length; n += 2) {
    const name = response.rawHeaders[n].toLowerCase(), value = response.rawHeaders[n + 1];
    const size = Buffer.byteLength(name) + Buffer.byteLength(value) + 4;
    all += size;
    if (name !== A2A_VERSION_HEADER.toLowerCase() && name !== HTTP_EXTENSION_HEADER.toLowerCase()) continue;
    project += size;
    if (!/^[\x20-\x7e]*$/.test(value)) throw failure('protocol');
    headers.set(name, [...headers.get(name) ?? [], value]);
  }
  if (all > 16 * 1024 || project > maxBytes) throw failure('protocol');
  const versions = headers.get(A2A_VERSION_HEADER.toLowerCase()) ?? [];
  if (versions.length !== 1 || versions[0].trim() !== '1.0') throw failure('protocol');
  const offered = Extensions.parseServiceParameter((headers.get(HTTP_EXTENSION_HEADER.toLowerCase()) ?? []).join(','));
  if (offered.length !== 1 || offered[0] !== DELIVERY_RECEIPT_EXTENSION) throw failure('protocol');
}

/**
 * Connects a WSS A2A server binding without owning the borrowed A2AService.
 * Credentials must come from one verified session/header snapshot. Construction
 * has one timeout and rejects safely; later network loss reconnects with fresh
 * credentials. close is idempotent, owns only transport resources, and uses the
 * caller's absolute performance.now deadline. RuntimeError keeps private cause.
 *
 * const channel = await connectA2AWss({ url, service, getCredentials, limits: DEFAULT_WSS_LIMITS });
 * const unsubscribe = channel.subscribe(status => showConnection(status));
 * unsubscribe(); await channel.close({ deadline: performance.now() + 3000 });
 */
export async function connectA2AWss(options: A2AWssOptions, callOptions: CallOptions = {}): Promise<A2AWssAdapter> {
  if (!options || !options.service || typeof options.service.protocolFor !== 'function' || typeof options.service.confirmTaskDelivery !== 'function' || typeof options.getCredentials !== 'function') throw failure('invalid-request');
  if (!object(callOptions)) throw failure('invalid-request');
  signalOption(callOptions.signal);
  let url: URL;
  try { url = new URL(options.url); } catch (error) { throw failure('invalid-request', error); }
  if (url.protocol !== 'wss:' || url.pathname !== '/api/clients/connect' || url.username || url.password || url.search || url.hash) throw failure('invalid-request');
  const origin = new URL(url); origin.protocol = 'https:'; origin.pathname = '/';
  const limits = { ...options.limits };
  for (const key of Object.keys(DEFAULT_WSS_LIMITS) as Array<keyof WssLimits>) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] <= 0 || limits[key] > 2_147_483_647) throw failure('invalid-request');
  }
  if (limits.maxStreams >= limits.maxInFlightRequests || limits.reconnectMinMs > limits.reconnectMaxMs ||
      limits.maxMessageBytes < 1024 * 1024 + 8192 || limits.maxOutboundBytes < limits.maxMessageBytes + 14 || limits.maxHeaderBytes > 8192) throw failure('invalid-request');
  const shutdown = new AbortController();
  const listeners = new Set<(status: WssStatus) => void>();
  const cleanups = new Set<Promise<void>>();
  let status: WssStatus = { state: 'reconnecting', reason: 'network' };
  let current: Connection | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let attemptController: AbortController | undefined;
  let attempting: Promise<void> | undefined;
  let delay = limits.reconnectMinMs;
  let closing = false;
  let transportFault = false;
  let closeWork: Promise<void> | undefined;
  const publish = (value: WssStatus) => {
    status = Object.freeze({ ...value });
    for (const listener of listeners) { try { listener({ ...status }); } catch { /* UI observers cannot change task or transport results. */ } }
  };
  const settle = (item: Send, error?: unknown) => {
    if (item.settled) return;
    item.settled = true;
    if (item.abort) item.signal?.removeEventListener('abort', item.abort);
    if (error) item.reject(error); else item.resolve();
  };
  function schedule(reason: Reason) {
    if (closing || transportFault || retry) return;
    publish({ state: 'reconnecting', reason });
    const ms = Math.min(limits.reconnectMaxMs, delay + Math.floor(Math.random() * Math.max(1, delay / 4)));
    delay = Math.min(limits.reconnectMaxMs, delay * 2);
    retry = setTimeout(() => {
      retry = undefined;
      attempting = attempt().catch(error => {
        if (closing) return;
        if (error instanceof RuntimeError && ['authentication', 'forbidden', 'protocol'].includes(error.kind)) publish({ state: 'blocked', reason: error.kind as Reason });
        else { attempting = undefined; schedule('network'); }
      }).finally(() => { attempting = undefined; });
    }, ms);
  }
  function end(connection: Connection, reason: Reason, reconnect: boolean, code = 1011) {
    if (connection.ended) return;
    connection.ended = true;
    const wasReady = connection.ready;
    connection.ready = false;
    connection.controller.abort(failure(reason === 'network' ? 'unavailable' : reason));
    clearTimeout(connection.heartbeat); clearTimeout(connection.pong); clearTimeout(connection.expiry);
    for (const job of connection.jobs.values()) job.controller.abort(failure('aborted'));
    for (const item of connection.queue) settle(item, failure('unavailable'));
    connection.queue = []; connection.outboundBytes = 0;
    if (connection.ws.readyState === WebSocket.OPEN) {
      connection.ws.close(code, 'Channel closed');
      connection.termination = setTimeout(() => connection.ws.terminate(), limits.closeTimeoutMs);
    } else if (connection.ws.readyState !== WebSocket.CLOSED) connection.ws.terminate();
    const cleanup = (async () => {
      const results = await Promise.allSettled([...connection.jobs.values()].map(job => job.work));
      await connection.closed;
      clearTimeout(connection.termination);
      connection.ws.removeAllListeners();
      if (results.some(result => result.status === 'rejected')) throw failure('unavailable');
    })();
    connection.cleanup = cleanup;
    cleanups.add(cleanup);
    void cleanup.then(() => cleanups.delete(cleanup), () => {
      // A failed old generation still owns resources: don't accumulate more generations.
      transportFault = true;
      clearTimeout(retry); retry = undefined; attemptController?.abort();
      if (current && current !== connection) end(current, 'unknown', false);
      if (!closing) publish({ state: 'blocked', reason: 'unknown' });
    });
    if (current !== connection || closing || !wasReady) return;
    if (reconnect) schedule(reason); else publish({ state: 'blocked', reason });
  }
  function pump(connection: Connection) {
    if (connection.sending || connection.ended) return;
    const item = connection.queue[0];
    if (!item) return;
    if (connection.ws.readyState !== WebSocket.OPEN || connection.ws.bufferedAmount + item.bytes + 14 > limits.maxOutboundBytes) {
      end(connection, 'backpressure', true, 1013); return;
    }
    connection.sending = true; item.started = true;
    connection.ws.send(item.text, error => {
      connection.sending = false;
      if (connection.ended) { settle(item, failure('unavailable', error)); return; }
      if (connection.queue[0] === item) { connection.queue.shift(); connection.outboundBytes -= item.bytes; }
      if (error) { settle(item, failure('unavailable', error)); end(connection, 'network', true); return; }
      settle(item);
      pump(connection);
    });
  }
  function send(connection: Connection, wire: Wire, signal?: AbortSignal): Promise<void> {
    if (connection.ended || !connection.ready || signal?.aborted) return Promise.reject(failure('aborted'));
    let text: string;
    try { text = JSON.stringify(safeWire(wire)); } catch (error) { return Promise.reject(failure('unavailable', error)); }
    const bytes = Buffer.byteLength(text) + 14;
    if (bytes - 14 > limits.maxMessageBytes) return Promise.reject(failure('resource-limit'));
    if (connection.queue.length >= limits.maxOutboundMessages || connection.outboundBytes + bytes > limits.maxOutboundBytes || connection.ws.bufferedAmount + bytes > limits.maxOutboundBytes) {
      end(connection, 'backpressure', true, 1013); return Promise.reject(failure('resource-limit'));
    }
    return new Promise((resolve, reject) => {
      const item: Send = { text, bytes, resolve, reject, signal, started: false, settled: false };
      if (signal) {
        item.abort = () => {
          if (!item.started) {
            const index = connection.queue.indexOf(item);
            if (index >= 0) { connection.queue.splice(index, 1); connection.outboundBytes -= bytes; }
          }
          settle(item, failure('aborted'));
        };
        signal.addEventListener('abort', item.abort, { once: true });
      }
      connection.queue.push(item); connection.outboundBytes += bytes;
      pump(connection);
    });
  }
  async function sendFailure(connection: Connection, id: Wire['id'], error: unknown) {
    if (connection.ended) return;
    try { await deadline(send(connection, errorWire(id, error)), performance.now() + limits.closeTimeoutMs); }
    catch { end(connection, 'backpressure', true, 1013); }
  }
  async function dispatch(connection: Connection, request: Request, job: Job) {
    const signal = AbortSignal.any([connection.controller.signal, job.controller.signal]);
    let stream = false, terminal = false;
    try {
      params(request);
      const principal = connection.principal;
      const owner = 'omniops-v1:' + createHash('sha256').update(canonicalize([principal.organizationId, principal.callerId, principal.installationId])).digest('hex');
      const context = new ServerCallContext({ user: { isAuthenticated: true, userName: owner }, requestedVersion: '1.0', requestedExtensions: [DELIVERY_RECEIPT_EXTENSION],
        state: new Map<string, unknown>([['omniops.principal', principal], ['omniops.waitSignal', signal]]) });
      const tenant = request.params.tenant as string;
      const handler = await wait(options.service.protocolFor(context, tenant, { signal }), signal);
      const card = await wait(handler.getAgentCard(), signal);
      validateVersion('1.0', card, WSS_BINDING);
      if (!card.supportedInterfaces.some(entry => entry.protocolBinding === WSS_BINDING && entry.tenant === tenant && entry.protocolVersion === '1.0')) throw new VersionNotSupportedError();
      if (request.method === 'omniops/ConfirmTaskDelivery') {
        context.setTenant(tenant);
        const p = request.params;
        const result = await wait(options.service.confirmTaskDelivery({ tenant, taskId: validIdentifier(p.taskId),
          resultSha256: typeof p.resultSha256 === 'string' ? p.resultSha256 : '', receivedAt: typeof p.receivedAt === 'string' ? p.receivedAt : '' }, context, { signal }), signal);
        await send(connection, { jsonrpc: '2.0', id: request.id, result }, signal);
        return;
      }
      const response = await wait(new JsonRpcTransportHandler(handler).handle(request, context), signal);
      if (!('next' in response)) { await send(connection, response, signal); return; }
      job.iterator = response;
      if (connection.streams >= limits.maxStreams) throw failure('resource-limit');
      connection.streams++; stream = true;
      let first = true;
      while (!terminal) {
        const next = await wait(response.next(), signal);
        if (next.done) throw failure('unavailable');
        if (next.value.error) { await send(connection, next.value, signal); terminal = true; break; }
        if (!object(next.value.result) || Object.keys(next.value.result).length !== 1) throw failure('unavailable');
        const event = StreamResponse.fromJSON(next.value.result).payload;
        if (!event || first && event.$case !== 'task' || !first && !['artifactUpdate', 'statusUpdate'].includes(event.$case)) throw failure('unavailable');
        const last = (event.$case === 'task' || event.$case === 'statusUpdate') && terminalStates.has(event.value.status?.state ?? 0);
        await send(connection, next.value, signal);
        terminal = last;
        first = false;
      }
    } catch (error) {
      if (!terminal && !connection.ended) await sendFailure(connection, request.id, error);
    } finally {
      clearTimeout(job.timer);
      job.controller.abort(failure('aborted'));
      let cleanupFailed = false;
      try { if (job.iterator) await deadline(job.iterator.return(), performance.now() + limits.closeTimeoutMs); }
      catch { cleanupFailed = true; end(connection, 'unknown', false); }
      if (stream) connection.streams--;
      connection.jobs.delete(request.id);
      if (cleanupFailed) throw failure('unavailable');
    }
  }
  function message(connection: Connection, bytes: WebSocket.RawData, binary: boolean) {
    if (connection.ended) return;
    if (!connection.ready) { end(connection, 'protocol', false, 1008); return; }
    if (binary) { end(connection, 'protocol', false, 1003); return; }
    if (connection.jobs.size >= limits.maxInFlightRequests) { end(connection, 'backpressure', true, 1013); return; }
    const text = Array.isArray(bytes) ? Buffer.concat(bytes).toString('utf8') : Buffer.from(bytes as ArrayBuffer).toString('utf8');
    let value: unknown;
    try { value = JSON.parse(text); }
    catch { void sendFailure(connection, null, new JsonRpcRequestMalformedError({ envelopeCode: A2A_ERROR_CODE.PARSE_ERROR })); return; }
    try {
      if (!object(value) || value.jsonrpc !== '2.0' || typeof value.method !== 'string' || !value.method.trim() || value.method.length > 128 ||
          /[\x00-\x1f\x7f]/.test(value.method) || Object.keys(value).some(key => !['jsonrpc', 'id', 'method', 'params'].includes(key)) ||
          !(typeof value.id === 'string' && validIdentifier(value.id) || typeof value.id === 'number' && Number.isSafeInteger(value.id))) {
        throw new JsonRpcRequestMalformedError({ envelopeCode: A2A_ERROR_CODE.INVALID_REQUEST });
      }
    } catch { void sendFailure(connection, null, new JsonRpcRequestMalformedError({ envelopeCode: A2A_ERROR_CODE.INVALID_REQUEST })); return; }
    const id = value.id as string | number;
    if (connection.jobs.has(id)) { end(connection, 'protocol', false, 1008); return; }
    try {
      if (!object(value.params) || Buffer.byteLength(text) > 256 * 1024) throw new RequestMalformedError();
      checkJson(value.params);
    } catch (error) { void sendFailure(connection, id, error); return; }
    const controller = new AbortController();
    const job: Job = { controller, work: Promise.resolve(), timer: setTimeout(() => controller.abort(failure('timeout')), limits.callTimeoutMs) };
    connection.jobs.set(id, job);
    // Register ownership before dispatch can yield or invoke a borrowed handler.
    job.work = Promise.resolve().then(() => dispatch(connection, value as Request, job));
    void job.work.catch(() => end(connection, 'unknown', false));
  }
  async function attempt(initialSignal?: AbortSignal) {
    const controller = new AbortController(); attemptController = controller;
    const signal = AbortSignal.any([controller.signal, shutdown.signal, ...(initialSignal ? [initialSignal] : [])]);
    const timer = setTimeout(() => controller.abort(failure('timeout')), limits.connectTimeoutMs);
    let connection: Connection | undefined;
    try {
      const raw = await wait(Promise.resolve().then(() => options.getCredentials({ origin: origin.origin, signal })), signal);
      if (!raw || typeof raw.authorization !== 'string' || !raw.authorization.trim() || !/^[\x20-\x7e]+$/.test(raw.authorization) || Buffer.byteLength(raw.authorization) > 8192 || !object(raw.principal)) throw failure('authentication');
      let principal: A2APrincipal;
      try { principal = Object.freeze({ organizationId: validIdentifier(raw.principal.organizationId), callerId: validIdentifier(raw.principal.callerId), installationId: validIdentifier(raw.principal.installationId) }); }
      catch (error) { throw failure('authentication', error); }
      const expiresAt = typeof raw.expiresAt === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(raw.expiresAt) ? Date.parse(raw.expiresAt) : NaN;
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw failure('authentication');
      signal.throwIfAborted();
      const ws = new WebSocket(url, { headers: { Authorization: raw.authorization, [A2A_VERSION_HEADER]: '1.0', [HTTP_EXTENSION_HEADER]: Extensions.toServiceParameter([DELIVERY_RECEIPT_EXTENSION]) },
        perMessageDeflate: false, maxPayload: limits.maxMessageBytes, followRedirects: false, handshakeTimeout: limits.connectTimeoutMs, maxHeaderSize: 16 * 1024 });
      const closed = Promise.withResolvers<void>();
      connection = { ws, principal, expiresAt, controller: new AbortController(), ready: false, ended: false,
        jobs: new Map(), streams: 0, queue: [], outboundBytes: 0, sending: false, closed: closed.promise };
      const c = connection; current = c;
      const ready = Promise.withResolvers<void>();
      let checked = false;
      ws.on('error', error => {
        const code = object(error) ? error.code : (error as NodeJS.ErrnoException).code;
        const kind = certificateCodes.has(typeof code === 'string' ? code : '') ? 'protocol' : 'network';
        ready.reject(failure(kind === 'network' ? 'unavailable' : kind, error));
        end(c, kind, kind === 'network');
      });
      ws.on('close', () => {
        closed.resolve(); ready.reject(failure('unavailable'));
        if (!c.ended) end(c, 'network', true);
      });
      ws.on('unexpected-response', (request, response) => {
        const kind = response.statusCode === 401 ? 'authentication' : response.statusCode === 403 ? 'forbidden' : (response.statusCode ?? 0) >= 500 || response.statusCode === 429 ? 'unavailable' : 'protocol';
        ready.reject(failure(kind));
        response.destroy(); request.destroy(); end(c, kind === 'unavailable' ? 'network' : kind, kind === 'unavailable', 1008);
      });
      ws.on('upgrade', response => {
        try { negotiated(response, limits.maxHeaderBytes); checked = true; }
        catch (error) { ready.reject(error); end(c, 'protocol', false, 1008); }
      });
      ws.on('open', () => {
        if (!checked || c.ended || Date.now() >= expiresAt || signal.aborted) { ready.reject(failure('protocol')); end(c, 'protocol', false, 1008); return; }
        c.ready = true;
        publish({ state: 'connected' });
        ready.resolve();
        const expire = () => {
          const remaining = expiresAt - Date.now();
          if (remaining <= 0) { end(c, 'authentication', false, 1008); return; }
          c.expiry = setTimeout(expire, Math.min(remaining, 2_147_483_647));
        };
        expire();
        const ping = () => {
          if (c.ended) return;
          c.ping = randomUUID();
          try { ws.ping(c.ping); }
          catch { end(c, 'network', true); return; }
          c.pong = setTimeout(() => end(c, 'network', true), limits.pongTimeoutMs);
        };
        c.heartbeat = setTimeout(ping, limits.heartbeatIntervalMs);
        ws.on('pong', data => {
          if (c.ended || data.toString() !== c.ping) return;
          clearTimeout(c.pong); c.ping = undefined; delay = limits.reconnectMinMs;
          c.heartbeat = setTimeout(ping, limits.heartbeatIntervalMs);
        });
      });
      ws.on('message', (data, binary) => message(c, data, binary));
      await wait(ready.promise, signal);
    } catch (error) {
      if (connection) end(connection, 'network', false);
      if (error instanceof RuntimeError && ['authentication', 'forbidden', 'protocol', 'invalid-request'].includes(error.kind)) throw error;
      if (signal.aborted) throw failure(initialSignal?.aborted || shutdown.signal.aborted ? 'aborted' : 'timeout', error);
      throw failure('unavailable', error);
    } finally { clearTimeout(timer); if (attemptController === controller) attemptController = undefined; }
  }
  try { await attempt(callOptions.signal); }
  catch (error) {
    closing = true; shutdown.abort(); clearTimeout(retry); attemptController?.abort();
    await deadline(Promise.allSettled([...cleanups]), performance.now() + limits.closeTimeoutMs).catch(() => {});
    throw error;
  }
  return {
    getStatus: () => ({ ...status }),
    subscribe(listener) {
      if (typeof listener !== 'function') throw failure('invalid-request');
      if (listeners.size >= 64) throw failure('resource-limit');
      listeners.add(listener);
      try { listener({ ...status }); } catch { /* Subscribers are observers, not execution owners. */ }
      return () => { listeners.delete(listener); };
    },
    close(closeOptions) {
      if (!closeOptions || !Number.isFinite(closeOptions.deadline) || closeOptions.deadline < 0) return Promise.reject(failure('invalid-request'));
      if (closeWork) return closeWork;
      closing = true; publish({ state: 'closing' });
      clearTimeout(retry); retry = undefined; shutdown.abort(failure('aborted')); attemptController?.abort();
      if (current) end(current, 'unknown', false, 1000);
      closeWork = deadline((async () => {
        await attempting;
        const results = await Promise.allSettled([...cleanups]);
        if (results.some(result => result.status === 'rejected')) throw failure('unavailable');
        publish({ state: 'closed' }); listeners.clear();
      })(), Math.min(closeOptions.deadline, performance.now() + limits.closeTimeoutMs));
      return closeWork;
    },
  };
}
