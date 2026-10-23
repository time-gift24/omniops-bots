import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { storageId, writeJson } from '../json-store.ts';
import { ExecutionError } from '../execution/index.ts';

export async function createChatHistory<T extends object = Record<string, unknown>>(directory: string) {
  const sessions = join(directory, '.sessions');
  try { await mkdir(sessions, { recursive: true, mode: 0o700 }); }
  catch (error) { throw new ExecutionError('storage', error); }
  return {
    async read(threadId: string): Promise<T | null> {
      try { return JSON.parse(await readFile(join(sessions, `${storageId(threadId)}.json`), 'utf8')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new ExecutionError('storage', error); }
    },
    async save(threadId: string, value: unknown) {
      try { await writeJson(join(sessions, `${storageId(threadId)}.json`), value); }
      catch (error) { throw new ExecutionError('storage', error); }
    },
  };
}
