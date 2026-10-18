import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { invalid, RuntimeError } from './errors.mjs';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type RunStatus = 'preparing' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timed-out' | 'interrupted';
export interface RunRecord {
  runId: string; threadId: string; agentId?: string; title: string;
  status: RunStatus; startedAt: string; endedAt?: string;
  inputMessages: Json[]; events: Json[]; result?: Json; snapshot?: Json;
  error?: { kind: string; message: string };
}
export const storageId = (value: string) => createHash('sha256').update(value).digest('hex');
export async function writeJson(file: string, value: unknown) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temp, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temp, file);
  } finally { await rm(temp, { force: true }); }
}

/** Durable terminal records are written before clients receive terminal events. */
export async function createRunStore(directory: string) {
  const recordsDir = join(directory, '.records');
  const sessionsDir = join(directory, '.sessions');
  await mkdir(recordsDir, { recursive: true, mode: 0o700 });
  await mkdir(sessionsDir, { recursive: true, mode: 0o700 });
  const records = new Map<string, RunRecord>();
  for (const name of await readdir(recordsDir)) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
    const record: RunRecord = JSON.parse(await readFile(join(recordsDir, name), 'utf8'));
    if (!record.runId || !record.threadId || storageId(record.runId) + '.json' !== name || !Array.isArray(record.events)) {
      throw new RuntimeError('storage', '执行记录损坏，请保留数据并检查本地存储。');
    }
    if (record.status === 'preparing' || record.status === 'running') {
      record.status = 'interrupted';
      record.endedAt = new Date().toISOString();
      record.error = { kind: 'interrupted', message: '执行中断、结果未知。已完成的操作可能仍然生效；任务不会自动重跑。' };
      record.events.push({ type: 'failed', error: record.error });
      await writeJson(join(recordsDir, name), record);
    }
    records.set(record.runId, record);
  }
  const get = (runId: string) => {
    const record = records.get(runId);
    if (!record) throw invalid('执行记录不存在。');
    return structuredClone(record);
  };
  return {
    has: (runId: string) => records.has(runId),
    get,
    list: () => [...records.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).map(record => structuredClone(record)),
    async save(record: RunRecord) {
      await writeJson(join(recordsDir, `${storageId(record.runId)}.json`), record);
      records.set(record.runId, structuredClone(record));
    },
    async readSession(threadId: string): Promise<{ snapshot: Json; messages: Json[]; lastRunId?: string } | null> {
      try { return JSON.parse(await readFile(join(sessionsDir, `${storageId(threadId)}.json`), 'utf8')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    },
    async saveSession(threadId: string, value: { snapshot: unknown; messages: unknown[]; lastRunId?: string }) {
      await writeJson(join(sessionsDir, `${storageId(threadId)}.json`), value);
    },
  };
}
