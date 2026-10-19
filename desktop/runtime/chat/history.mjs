import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { storageId, writeJson } from '../json-store.mjs';
import { ExecutionError } from '../execution/index.ts';

export async function createChatHistory(directory) {
  const sessions = join(directory, '.sessions');
  try { await mkdir(sessions, { recursive: true, mode: 0o700 }); }
  catch (error) { throw new ExecutionError('storage', error); }
  return {
    async read(threadId) {
      try { return JSON.parse(await readFile(join(sessions, `${storageId(threadId)}.json`), 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') return null; throw new ExecutionError('storage', error); }
    },
    async save(threadId, value) {
      try { await writeJson(join(sessions, `${storageId(threadId)}.json`), value); }
      catch (error) { throw new ExecutionError('storage', error); }
    },
  };
}
