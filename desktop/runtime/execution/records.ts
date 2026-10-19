import { mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { storageId, writeJson } from '../json-store.mjs';

export type RunStatus = 'preparing' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timed-out' | 'interrupted';
export interface RunRecord {
  runId: string;
  threadId: string;
  graphThreadId: string;
  status: RunStatus;
  startedAt: string;
  endedAt?: string;
  error?: { kind: string; message: string };
  details?: object;
}

export async function createRunRecords(directory: string) {
  const recordsDirectory = join(directory, '.records');
  await mkdir(recordsDirectory, { recursive: true, mode: 0o700 });
  const records = new Map<string, RunRecord>();
  const statuses = new Set<RunStatus>(['preparing', 'running', 'completed', 'failed', 'cancelled', 'timed-out', 'interrupted']);
  for (const name of await readdir(recordsDirectory)) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
    const raw = JSON.parse(await readFile(join(recordsDirectory, name), 'utf8'));
    if (!raw || typeof raw.runId !== 'string' || !raw.runId || typeof raw.threadId !== 'string' || !raw.threadId ||
        storageId(raw.runId) + '.json' !== name || !statuses.has(raw.status) || typeof raw.startedAt !== 'string') {
      throw new Error('Invalid execution record');
    }
    const { runId, threadId, graphThreadId, status, startedAt, endedAt, error, details, ...legacyDetails } = raw;
    const record: RunRecord = {
      runId, threadId, graphThreadId: graphThreadId ?? `legacy:${storageId(runId)}`, status, startedAt,
      ...(endedAt ? { endedAt } : {}), ...(error ? { error } : {}),
      ...(details !== undefined ? { details } : Object.keys(legacyDetails).length ? { details: legacyDetails } : {}),
    };
    if (typeof record.graphThreadId !== 'string' || !record.graphThreadId ||
        (record.details !== undefined && (!record.details || typeof record.details !== 'object' || Array.isArray(record.details)))) {
      throw new Error('Invalid execution record');
    }
    if (status === 'preparing' || status === 'running') {
      record.status = 'interrupted';
      record.endedAt = new Date().toISOString();
      record.error = { kind: 'interrupted', message: '执行中断、结果未知。已完成的操作可能仍然生效；任务不会自动重跑。' };
      await writeJson(join(recordsDirectory, name), record);
    }
    records.set(runId, record);
  }
  return {
    has: (runId: string) => records.has(runId),
    get(runId: string): RunRecord {
      const record = records.get(runId);
      if (!record) throw new Error('Execution record does not exist');
      return structuredClone(record);
    },
    list: () => [...records.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).map(record => structuredClone(record)),
    async save(record: RunRecord) {
      const snapshot = structuredClone(record);
      await writeJson(join(recordsDirectory, `${storageId(record.runId)}.json`), snapshot);
      records.set(record.runId, snapshot);
    },
  };
}

export type RunRecords = Pick<Awaited<ReturnType<typeof createRunRecords>>, 'has' | 'get' | 'list'>;
