import { RuntimeError } from './errors.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const failure = (message, cause) => {
  const error = new RuntimeError('credentials', message);
  if (cause !== undefined) error.cause = cause;
  return error;
};
const validSecret = value => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 2560 && !/[\x00-\x1f\x7f]/.test(value);

/**
 * OS-only credential RPC: get(ref) -> Promise<string|null>, set(ref, secret)/delete(ref) ->
 * Promise<null>; failures are safe RuntimeError('credentials'). UUID refs and key size are
 * checked before sending. receive(message) -> boolean consumes only private replies.
 * close() rejects pending calls. Timeout/close cannot undo an OS operation already started.
 */
export function createCredentialClient({ send, timeoutMs = 15_000 }) {
  if (typeof send !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000) throw failure('凭据连接配置无效。');
  const pending = new Map();
  let nextId = 0;
  let closed = false;

  async function request(operation, reference, secret) {
    if (closed) throw failure('系统凭据连接已关闭。');
    if (typeof reference !== 'string' || !UUID.test(reference) || reference === '00000000-0000-0000-0000-000000000000') throw failure('凭据引用无效。');
    if (operation === 'set' && !validSecret(secret)) throw failure('API Key 无效或超过 2560 字节。');
    if (pending.size >= 64) throw failure('系统凭据请求过多，请稍后重试。');
    if (nextId === Number.MAX_SAFE_INTEGER) throw failure('请重启应用后操作系统凭据。');
    const requestId = ++nextId;
    return new Promise((resolve, reject) => {
      const settle = (error, result) => {
        const item = pending.get(requestId);
        if (!item) return;
        clearTimeout(item.timer);
        pending.delete(requestId);
        if (error) reject(error); else resolve(result);
      };
      const timer = setTimeout(() => settle(failure('系统凭据操作超时，请检查凭据库后重试。')), timeoutMs);
      pending.set(requestId, { operation, settle, timer });
      try {
        Promise.resolve(send({ event: 'credential_request', requestId, operation, reference, ...(operation === 'set' ? { secret } : {}) }))
          .catch(cause => settle(failure('系统凭据连接不可用。', cause)));
      } catch (cause) { settle(failure('系统凭据连接不可用。', cause)); }
    });
  }

  return {
    get: reference => request('get', reference),
    set: (reference, secret) => request('set', reference, secret),
    delete: reference => request('delete', reference),
    receive(message) {
      if (message?.event !== 'credential_reply') return false;
      const item = pending.get(message.requestId);
      if (!item) return true;
      if (Object.hasOwn(message, 'error')) item.settle(failure('系统凭据库不可用，请解锁凭据库或检查权限。', message.error));
      else if (message.result === null || (item.operation === 'get' && validSecret(message.result))) item.settle(null, message.result);
      else item.settle(failure('系统凭据响应无效。'));
      return true;
    },
    close() {
      closed = true;
      for (const item of pending.values()) item.settle(failure('系统凭据连接已关闭。'));
    },
  };
}
