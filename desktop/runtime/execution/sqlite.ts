import { chmod, lstat, mkdir, open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { compareWritesSortKeys, writesSortKey, type BaseCheckpointSaver, type CheckpointTuple } from '@langchain/langgraph-checkpoint';

const format = 'omniops-checkpoints:1;sqlite-saver:1.1.0;checkpoint:1.2.0;jsonplus:1';
const columns = {
  checkpoints: ['thread_id', 'checkpoint_ns', 'checkpoint_id', 'parent_checkpoint_id', 'type', 'checkpoint', 'metadata'],
  writes: ['thread_id', 'checkpoint_ns', 'checkpoint_id', 'task_id', 'task_path', 'idx', 'channel', 'type', 'value'],
};

class ManagedSqliteSaver extends SqliteSaver {
  private pending = new Set<Promise<unknown>>();
  private closing = false;
  private closed?: Promise<void>;

  initialize() { this.setup(); }

  private restoreBytes(tuple: CheckpointTuple): CheckpointTuple {
    const pending = tuple.pendingWrites;
    if (!pending?.length) return tuple;
    const config = tuple.config.configurable!;
    const rows = this.db.prepare('SELECT task_id, task_path, idx, channel, type, value FROM writes WHERE thread_id=? AND checkpoint_ns=? AND checkpoint_id=?')
      .all(config.thread_id, config.checkpoint_ns ?? '', config.checkpoint_id) as {
        task_id: string; task_path: string; idx: number; channel: string; type: string; value: Uint8Array;
      }[];
    if (!rows.some(row => row.type === 'bytes')) return tuple;
    rows.sort((a, b) => compareWritesSortKeys(writesSortKey(a.task_path, a.task_id, a.idx), writesSortKey(b.task_path, b.task_id, b.idx)));
    // SqliteSaver 1.1.0 casts pending BLOBs to UTF-8 text. Preserve arbitrary bytes from the original BLOB.
    const byWrite = new Map<string, typeof rows>();
    for (const row of rows) {
      const key = JSON.stringify([row.task_id, row.channel]);
      const group = byWrite.get(key) ?? [];
      group.push(row);
      byWrite.set(key, group);
    }
    for (const write of pending) {
      const row = byWrite.get(JSON.stringify([write[0], write[1]]))?.shift();
      if (row?.type === 'bytes') write[2] = new Uint8Array(row.value);
    }
    return tuple;
  }

  private track<T>(work: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error('Checkpoint database is closing'));
    const task = work();
    this.pending.add(task);
    void task.then(() => this.pending.delete(task), () => this.pending.delete(task));
    return task;
  }

  override getTuple(...args: Parameters<SqliteSaver['getTuple']>) {
    return this.track(async () => {
      const tuple = await super.getTuple(...args);
      return tuple ? this.restoreBytes(tuple) : tuple;
    });
  }
  override put(...args: Parameters<SqliteSaver['put']>) {
    return this.track(() => super.put(...args));
  }
  override putWrites(...args: Parameters<SqliteSaver['putWrites']>) {
    return this.track(() => super.putWrites(...args));
  }
  override deleteThread(...args: Parameters<SqliteSaver['deleteThread']>) {
    return this.track(() => super.deleteThread(...args));
  }
  override async *list(...args: Parameters<SqliteSaver['list']>) {
    if (this.closing) throw new Error('Checkpoint database is closing');
    // Materialize before yielding so a paused consumer cannot keep the database open.
    const rows = await this.track(async () => {
      const rows = [];
      for await (const row of super.list(...args)) rows.push(this.restoreBytes(row));
      return rows;
    });
    yield* rows;
  }

  close(): Promise<void> {
    this.closed ??= (async () => {
      this.closing = true;
      const settled = await Promise.allSettled([...this.pending]);
      this.db.close();
      const failed = settled.filter(item => item.status === 'rejected');
      if (failed.length) throw new AggregateError(failed.map(item => item.reason), 'Checkpoint writes failed while closing');
    })();
    return this.closed;
  }
}

/** Open the private, versioned native saver. Incompatible or corrupt data is preserved. */
export async function openSqliteCheckpointer(path: string, { maxBytes = 512 * 1024 * 1024 }: { maxBytes?: number } = {}): Promise<{
  checkpointer: BaseCheckpointSaver;
  close(): Promise<void>;
}> {
  if (!path || path === ':memory:') throw new Error('A persistent checkpoint database path is required');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 16 * 4096) throw new Error('Checkpoint capacity must be a positive safe integer of at least 65536 bytes');
  const file = resolve(path);
  const directory = dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const parent = await lstat(directory);
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('Checkpoint directory must be a real directory');
  await chmod(directory, 0o700);
  try {
    const created = await open(file, 'wx', 0o600);
    await created.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const existing = await lstat(file);
  if (!existing.isFile() || existing.isSymbolicLink()) throw new Error('Checkpoint database must be a regular file');
  await chmod(file, 0o600);
  const saver = new ManagedSqliteSaver(SqliteSaver.fromConnString(file).db);
  const db = saver.db;
  try {
    if (db.pragma('quick_check', { simple: true }) !== 'ok') throw new Error('Checkpoint database integrity check failed');
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
    if (tables.length) {
      if (!tables.some(table => table.name === 'omniops_checkpoint_format') ||
          db.prepare<[], { format: string }>('SELECT format FROM omniops_checkpoint_format WHERE id=1').get()?.format !== format) {
        throw new Error('Unsupported checkpoint database format; preserve the database before upgrading');
      }
      for (const [table, expected] of Object.entries(columns)) {
        const actual = (db.pragma(`table_info(${table})`) as { name: string }[]).map(column => column.name);
        if (actual.join(',') !== expected.join(',')) throw new Error('Unsupported checkpoint database schema');
      }
      for (const table of ['checkpoints', 'writes']) {
        const types = table === 'writes' ? "'json', 'bytes'" : "'json'";
        if (db.prepare(`SELECT 1 FROM ${table} WHERE type IS NOT NULL AND type NOT IN (${types}) LIMIT 1`).get()) {
          throw new Error('Unsupported checkpoint serialization format');
        }
      }
    }
    db.pragma('busy_timeout = 5000');
    const pageSize = db.pragma('page_size', { simple: true }) as number;
    const pages = Math.min(Math.floor(maxBytes / pageSize), 4294967294);
    if (pages < 16) throw new Error('Checkpoint capacity must allow at least 16 database pages');
    if (db.pragma(`max_page_count = ${pages}`, { simple: true }) !== pages) {
      throw Object.assign(new Error('Checkpoint database exceeds configured capacity'), { code: 'SQLITE_FULL' });
    }
    if (db.pragma('journal_mode = WAL', { simple: true }) !== 'wal') throw new Error('Checkpoint WAL mode is unavailable');
    db.pragma('synchronous = FULL');
    // The page ceiling bounds the logical database. WAL recycling is not a hard disk-byte quota.
    db.pragma(`journal_size_limit = ${Math.min(maxBytes, 8 * 1024 * 1024)}`);
    db.pragma(`wal_autocheckpoint = ${Math.min(pages, 1000)}`);
    db.transaction(() => {
      saver.initialize();
      if (!tables.length) {
        db.exec('CREATE TABLE omniops_checkpoint_format (id INTEGER PRIMARY KEY CHECK(id=1), format TEXT NOT NULL)');
        db.prepare('INSERT INTO omniops_checkpoint_format (id, format) VALUES (1, ?)').run(format);
      }
    })();
    for (const suffix of ['', '-wal', '-shm']) {
      try { await chmod(file + suffix, 0o600); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return { checkpointer: saver, close: () => saver.close() };
  } catch (error) {
    db.close();
    throw new Error('Cannot open persistent checkpoints', { cause: error });
  }
}
