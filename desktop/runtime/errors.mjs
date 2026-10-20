export class RuntimeError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

export const invalid = message => new RuntimeError('invalid-request', message);

/** Unexpected dependency errors never expose provider payloads or credentials over IPC. */
export function safeError(error) {
  if (error instanceof RuntimeError) return { kind: error.kind, message: error.message };
  if (error?.name === 'AbortError') return { kind: 'aborted', message: '任务已停止。' };
  if (error?.name === 'TimeoutError' || error?.name === 'APIConnectionTimeoutError' || error?.code === 'ETIMEDOUT') return { kind: 'timeout', message: '操作超时，请重试。' };
  if (error?.status === 401 || error?.status === 403) return { kind: 'authentication', message: '模型认证失败，请检查本地模型配置。' };
  if (error?.status === 429) return { kind: 'rate-limited', message: '模型服务暂时限流，请稍后重试。' };
  if (error?.status === 400 || error?.status === 422) return { kind: 'unsupported', message: '模型不接受本次输入，请检查是否支持所附媒体和工具调用。' };
  if (error?.status >= 500) return { kind: 'unavailable', message: '模型服务暂时不可用。' };
  return { kind: 'unknown', message: '本地执行失败，请检查配置或重试。' };
}
