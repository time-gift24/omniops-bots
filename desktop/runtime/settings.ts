import { lstat, readFile } from 'node:fs/promises';
import { writeJson } from './json-store.ts';
import { invalid, RuntimeError } from './errors.ts';

export type ClientSettings = { maxConcurrentRuns: number };
function validate(value: unknown): ClientSettings {
  const settings = value as Partial<ClientSettings> | null;
  if (!settings || typeof settings !== 'object' || Array.isArray(settings) ||
      Object.keys(settings).some(key => key !== 'maxConcurrentRuns') ||
      typeof settings.maxConcurrentRuns !== 'number' || !Number.isSafeInteger(settings.maxConcurrentRuns) || settings.maxConcurrentRuns < 1 || settings.maxConcurrentRuns > 64) {
    throw invalid('并发任务上限必须是 1 到 64 之间的整数。');
  }
  return { maxConcurrentRuns: settings.maxConcurrentRuns };
}

/** Only confirmed reads/writes change admission; a failed write leaves the last effective setting intact. */
export async function createClientSettings({ file, defaultMaxConcurrentRuns = 4 }: { file: string; defaultMaxConcurrentRuns?: number }) {
  let current: ClientSettings | undefined, readError: RuntimeError | undefined;
  let tail = Promise.resolve();
  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const pending = tail.then(work);
    tail = pending.then(() => {}, () => {});
    return pending;
  };
  const read = () => enqueue(async () => {
    try {
      let value: unknown;
      try {
        const stat = await lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw new Error('Invalid settings file');
        value = JSON.parse(await readFile(file, 'utf8'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        value = { maxConcurrentRuns: defaultMaxConcurrentRuns };
      }
      current = validate(value);
      readError = undefined;
      return { ...current };
    } catch (cause) {
      readError = Object.assign(new RuntimeError('storage', '无法读取客户端设置，请检查本地配置文件后重试。'), { cause });
      throw readError;
    }
  });
  // Keep settings and resource pages available so a read failure is visible and retryable.
  await read().catch(() => {});
  return {
    current(): ClientSettings {
      if (!current) throw readError;
      return { ...current };
    },
    read,
    async save(settings: unknown) {
      const next = validate(settings);
      return enqueue(async () => {
        try { await writeJson(file, next); }
        catch (cause) { throw Object.assign(new RuntimeError('storage', '客户端设置保存失败，原设置仍然有效，请重试。'), { cause }); }
        current = next;
        readError = undefined;
        return { ...current };
      });
    },
    close: () => tail,
  };
}
