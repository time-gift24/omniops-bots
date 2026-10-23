export class RuntimeError extends Error {
  readonly kind: string;
  constructor(kind: string, message: string) {
    super(message);
    this.kind = kind;
  }
}

export const invalid = (message: string) => new RuntimeError('invalid-request', message);

/** Unexpected dependency errors never expose provider payloads or credentials over IPC. */
export function safeError(error: unknown): { kind: string; message: string } {
  if (error instanceof RuntimeError) return { kind: error.kind, message: error.message };
  const value = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  if (value.name === 'AbortError') return { kind: 'aborted', message: '任务已停止。' };
  if (value.name === 'TimeoutError' || value.name === 'APIConnectionTimeoutError' || value.code === 'ETIMEDOUT') return { kind: 'timeout', message: '操作超时，请重试。' };
  if (value.status === 401 || value.status === 403) return { kind: 'authentication', message: '模型认证失败，请检查本地模型配置。' };
  if (value.status === 429) return { kind: 'rate-limited', message: '模型服务暂时限流，请稍后重试。' };
  if (value.status === 400 || value.status === 422) return { kind: 'unsupported', message: '模型不接受本次输入，请检查是否支持所附媒体和工具调用。' };
  if (typeof value.status === 'number' && value.status >= 500) return { kind: 'unavailable', message: '模型服务暂时不可用。' };
  return { kind: 'unknown', message: '本地执行失败，请检查配置或重试。' };
}
