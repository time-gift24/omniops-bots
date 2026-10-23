import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, readdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, relative, sep } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import SQLite from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import type { KyselyPlugin } from 'kysely';
import { canonicalize } from 'json-canonicalize';
import { Task, TaskState, taskStateToJSON } from '@a2a-js/sdk';
import { A2AError, RequestMalformedError, TaskNotFoundError } from '@a2a-js/sdk/errors';
import { ServerCallContext } from '@a2a-js/sdk/server';
import type { TaskStore } from '@a2a-js/sdk/server';
import { DatabaseTaskStore } from '@a2a-js/sdk/server/database';
import type { TaskRow } from '@a2a-js/sdk/server/database';
import { RuntimeError } from '../errors.ts';
import { statusMessage } from './status.ts';

export const RECEIPT_EXTENSION = 'urn:omniops:a2a:extension:delivery-receipt:v1';
export type Principal = Readonly<{ organizationId: string; callerId: string; installationId: string }>;
type DeliveryRow = {
  organization_id: string; caller_id: string; installation_id: string; message_id: string;
  fingerprint: string; agent_id: string; content_id: string;
  tenant: string; owner: string; task_id: string;
  thread_id: string | null; run_id: string | null;
  result_sha256: string | null; received_at: string | null;
};
type Database = { a2a_tasks: TaskRow; omniops_a2a_delivery: DeliveryRow };
type Acceptance = Readonly<{
  principal: Principal; messageId: string; fingerprint: string; agentId: string;
  contentId: string; context: ServerCallContext;
}>;
type InitialTask = { task: Task; threadId?: string; runId?: string };
type Receipt = Readonly<{ taskId: string; resultSha256: string; receivedAt: string }>;
/** Internal admission failure: caller must retain its unstarted reservation until final shutdown. */
export type UncertainAcceptanceError = RuntimeError & { acceptanceUnknown: true };
const execFileAsync = promisify(execFile);
const terminalStates = new Set([
  TaskState.TASK_STATE_COMPLETED, TaskState.TASK_STATE_FAILED,
  TaskState.TASK_STATE_CANCELED, TaskState.TASK_STATE_REJECTED,
]);

export const isTerminalTask = (task: Task): boolean => terminalStates.has(task.status?.state ?? 0);
const sha256 = (value: unknown): string => createHash('sha256').update(canonicalize(value)).digest('hex');
export const principalOwner = (principal: Principal): string =>
  `omniops-v1:${sha256([principal.organizationId, principal.callerId, principal.installationId])}`;
export function taskResultSha256(task: Task): string {
  const json = Task.toJSON(task) as Record<string, unknown>;
  return sha256({ id: json.id, contextId: json.contextId, status: json.status, artifacts: json.artifacts ?? [] });
}
const storageError = (cause?: unknown): RuntimeError => {
  const error = new RuntimeError('storage', 'A2A 持久化不可用。');
  if (cause !== undefined) Object.defineProperty(error, 'cause', { value: cause });
  return error;
};
function requireId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.isWellFormed() || !value.trim() || value.length > 256 || /[\x00-\x1f\x7f]/u.test(value)) {
    throw new RequestMalformedError('A2A 标识无效。');
  }
}
function scope(context: ServerCallContext) {
  const tenant = context.tenant;
  const owner = context.user?.userName;
  requireId(tenant); requireId(owner);
  if (!context.user?.isAuthenticated || !owner.startsWith('omniops-v1:')) throw storageError();
  return { tenant, owner };
}
function checkWaiting(context: ServerCallContext) {
  const signal = context.state.get('omniops.waitSignal');
  if (signal instanceof AbortSignal && signal.aborted) throw new RuntimeError('aborted', 'A2A 调用等待已停止。');
}
function isTimestamp(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const [, year, month, day, hour, minute, second] = match.map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1] && hour < 24 && minute < 60 && second < 60;
}
function seal(task: Task): Task {
  const copy = structuredClone(task);
  if (isTerminalTask(copy)) {
    copy.metadata = { ...copy.metadata, [RECEIPT_EXTENSION]: { resultSha256: taskResultSha256(copy) } };
  }
  return copy;
}
function checkSeal(task: Task, row: DeliveryRow) {
  if (isTerminalTask(task) !== (row.result_sha256 !== null)) throw storageError();
  if (row.result_sha256 !== null && (
    taskResultSha256(task) !== row.result_sha256 ||
    (task.metadata?.[RECEIPT_EXTENSION] as { resultSha256?: unknown } | undefined)?.resultSha256 !== row.result_sha256
  )) throw storageError();
  if (row.received_at !== null && row.result_sha256 === null) throw storageError();
}

function storedObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw storageError();
  return value as Record<string, unknown>;
}
function optionalFields(value: Record<string, unknown>, strings: string[], arrays: string[] = []) {
  if (strings.some(key => value[key] != null && typeof value[key] !== 'string') ||
    arrays.some(key => value[key] != null && (!Array.isArray(value[key]) || value[key].some(item => typeof item !== 'string'))) ||
    value.metadata != null && (typeof value.metadata !== 'object' || Array.isArray(value.metadata))) throw storageError();
}
function storedJson(value: unknown): void {
  if (typeof value === 'number' && !Number.isFinite(value)) throw storageError();
  if (value && typeof value === 'object') for (const child of Object.values(value)) storedJson(child);
}
function storedParts(value: unknown) {
  if (!Array.isArray(value) || value.length === 0) throw storageError();
  for (const raw of value) {
    const part = storedObject(raw);
    const variants = ['text', 'raw', 'url', 'data'].filter(key => Object.hasOwn(part, key));
    if (variants.length !== 1) throw storageError();
    const variant = variants[0];
    if (variant !== 'data' && typeof part[variant] !== 'string') throw storageError();
    if (variant === 'raw' && (typeof part.raw !== 'string' ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(part.raw) ||
      Buffer.from(part.raw, 'base64').toString('base64') !== part.raw)) throw storageError();
    optionalFields(part, ['filename', 'mediaType']);
  }
}
function storedMessage(value: unknown) {
  const message = storedObject(value);
  requireId(message.messageId);
  if (!['ROLE_USER', 'ROLE_AGENT', 1, 2].includes(message.role as string | number)) throw storageError();
  optionalFields(message, ['contextId', 'taskId'], ['extensions', 'referenceTaskIds']);
  if (message.contextId) requireId(message.contextId);
  if (message.taskId) requireId(message.taskId);
  storedParts(message.parts);
}
function storedPayload(payload: Record<string, unknown>) {
  storedJson(payload);
  if (payload.status !== undefined) {
    const status = storedObject(payload.status);
    if (status.message != null) storedMessage(status.message);
  }
  if (payload.history !== undefined) {
    if (!Array.isArray(payload.history)) throw storageError();
    payload.history.forEach(storedMessage);
  }
  if (payload.artifacts !== undefined) {
    if (!Array.isArray(payload.artifacts)) throw storageError();
    const ids = new Set<string>();
    for (const value of payload.artifacts) {
      const artifact = storedObject(value);
      requireId(artifact.artifactId);
      if (ids.has(artifact.artifactId)) throw storageError();
      ids.add(artifact.artifactId);
      optionalFields(artifact, ['name', 'description'], ['extensions']);
      storedParts(artifact.parts);
    }
  }
}

/** Reject corrupt Task rows before SDK list's catch-and-console branch, including projected pages. */
function safeTaskRows(maxTaskBytes: number, payloads?: Map<string, Record<string, unknown>>): KyselyPlugin {
  return {
    transformQuery: ({ node }) => node,
    async transformResult({ result }) {
      try {
        for (const row of result.rows) {
          if (!('id' in row && 'tenant' in row && 'owner' in row && 'context_id' in row && 'protocol_version' in row)) continue;
          for (const key of ['tenant', 'owner', 'id', 'context_id']) requireId(row[key]);
          if (row.protocol_version !== '1.0' || !Number.isSafeInteger(row.status_last_updated)) throw storageError();
          const payload: Record<string, unknown> = { id: row.id, contextId: row.context_id };
          for (const key of ['status', 'artifacts', 'history', 'metadata']) {
            if (!(key in row)) continue;
            const raw = row[key];
            if (raw !== null && typeof raw !== 'string') throw storageError();
            if (typeof raw === 'string' && Buffer.byteLength(raw) > maxTaskBytes) throw storageError();
            const value = raw === null ? undefined : JSON.parse(raw as string);
            if (value !== undefined && ((key === 'artifacts' || key === 'history') ? !Array.isArray(value) :
              (typeof value !== 'object' || value === null || Array.isArray(value)))) throw storageError();
            payload[key] = value;
          }
          storedPayload(payload);
          const task = Task.fromJSON(payload);
          if (!task.status || task.status.state <= 0 || task.status.state > 8 ||
            row.status_state !== taskStateToJSON(task.status.state) ||
            !task.status.timestamp || !isTimestamp(task.status.timestamp) ||
            row.status_last_updated !== Date.parse(task.status.timestamp)) throw storageError();
          if (Buffer.byteLength(JSON.stringify(Task.toJSON(task))) > maxTaskBytes) throw storageError();
          payloads?.set(task.id, payload);
        }
        return result;
      } catch (cause) { throw storageError(cause); }
    },
  };
}

/** SDK 1.3.0 Part.fromJSON treats data:null as absent; restore only explicit nulls observed in its query result. */
function restoreJsonNull(task: Task, raw?: Record<string, unknown>): Task {
  if (!raw) return task;
  const parts = (message: { parts: { content?: { $case: string; value: unknown } }[] } | undefined, source: unknown) => {
    const rawParts = (source as { parts?: Record<string, unknown>[] } | undefined)?.parts;
    if (!message || !Array.isArray(rawParts)) return;
    message.parts.forEach((part, index) => {
      if (Object.hasOwn(rawParts[index] ?? {}, 'data') && rawParts[index].data === null) {
        part.content = { $case: 'data', value: null };
      }
    });
  };
  parts(task.status?.message, (raw.status as { message?: unknown } | undefined)?.message);
  task.artifacts.forEach((artifact, index) => parts(artifact, (raw.artifacts as unknown[] | undefined)?.[index]));
  task.history.forEach((message, index) => parts(message, (raw.history as unknown[] | undefined)?.[index]));
  return task;
}

/** SDK 1.3.0 exports migrations only through a2a-db; consume its public CLI, never private migration modules. */
async function sdkSchema(signal?: AbortSignal): Promise<string> {
  const sdkRoot = resolve(dirname(fileURLToPath(import.meta.resolve('@a2a-js/sdk'))), '..');
  const manifest = JSON.parse(await readFile(join(sdkRoot, 'package.json'), 'utf8'));
  const bin = manifest.bin?.['a2a-db'];
  if (manifest.version !== '1.3.0' || typeof bin !== 'string') throw storageError();
  const cli = resolve(sdkRoot, bin);
  const relativeCli = relative(sdkRoot, cli);
  if (isAbsolute(relativeCli) || relativeCli === '..' || relativeCli.startsWith(`..${sep}`)) throw storageError();
  const { stdout } = await execFileAsync(process.execPath, [cli, 'upgrade', '--sql', '--dialect', 'sqlite',
    '--store', 'tasks', '--tasks-table-name', 'a2a_tasks'], { signal, timeout: 10_000, windowsHide: true, maxBuffer: 128 * 1024 });
  return stdout;
}

function sharedDirectory(directory: string, roots = [homedir(), tmpdir()]): boolean {
  if (dirname(directory) === directory) return true;
  return roots.some(shared => {
    const child = relative(directory, resolve(shared));
    return child === '' || !isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`);
  });
}

async function dedicatedDirectory(directory: string): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || process.getuid && info.uid !== process.getuid()) {
    throw new RuntimeError('invalid-request', 'A2A 必须使用本机用户的专用目录。');
  }
  const canonical = await realpath(directory);
  const protectedRoots = await Promise.all([homedir(), tmpdir()].map(root => realpath(root).catch(() => resolve(root))));
  if (sharedDirectory(canonical, protectedRoots)) throw new RuntimeError('invalid-request', 'A2A 不能使用根目录、用户目录或共享临时目录。');
  const entries = await readdir(canonical);
  const files = new Set(['a2a.sqlite', 'a2a.sqlite-journal', 'a2a.sqlite-wal', 'a2a.sqlite-shm']);
  if (entries.some(name => !files.has(name)) || entries.length > 0 && !entries.includes('a2a.sqlite')) {
    throw new RuntimeError('invalid-request', 'A2A 目录必须为空或仅包含本模块的 SQLite 文件。');
  }
  // Existing directories belong to the caller; never change their permissions to claim ownership.
  return canonical;
}

export async function openA2AStore(options: Readonly<{ directory: string; maxTaskBytes: number; signal?: AbortSignal }>) {
  const { directory, maxTaskBytes, signal } = options;
  if (!isAbsolute(directory) || sharedDirectory(resolve(directory)) || !Number.isSafeInteger(maxTaskBytes) || maxTaskBytes <= 0) {
    throw new RuntimeError('invalid-request', 'A2A 存储配置无效。');
  }
  let db: Kysely<Database> | undefined;
  let sqlite: SQLite.Database | undefined;
  try {
    signal?.throwIfAborted();
    const canonical = await dedicatedDirectory(directory);
    const file = join(canonical, 'a2a.sqlite');
    const existing = await lstat(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (existing && (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1 ||
      process.getuid && existing.uid !== process.getuid())) throw storageError();
    signal?.throwIfAborted();
    if (!existing) {
      const created = await open(file, 'wx', 0o600);
      await created.close();
    }
    sqlite = new SQLite(file, { timeout: 0, fileMustExist: true });
    sqlite.pragma('foreign_keys = ON');
    sqlite.pragma('locking_mode = EXCLUSIVE');
    if (sqlite.pragma('integrity_check', { simple: true }) !== 'ok') throw storageError();
    const version = sqlite.pragma('user_version', { simple: true });
    if (version !== 0 && version !== 1) throw storageError();
    if (version === 0) {
      const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
      if (tables.length) throw storageError();
      const schema = await sdkSchema(signal);
      signal?.throwIfAborted();
      // Offline SDK SQL is deliberately not wrapped; our single timeout=0 connection makes migration atomic.
      sqlite.transaction(() => {
        sqlite!.exec(schema);
        sqlite!.exec(`CREATE TABLE omniops_a2a_delivery (
          organization_id TEXT NOT NULL, caller_id TEXT NOT NULL, installation_id TEXT NOT NULL,
          message_id TEXT NOT NULL, fingerprint TEXT NOT NULL, agent_id TEXT NOT NULL, content_id TEXT NOT NULL,
          tenant TEXT NOT NULL, owner TEXT NOT NULL, task_id TEXT NOT NULL,
          thread_id TEXT, run_id TEXT, result_sha256 TEXT, received_at TEXT,
          PRIMARY KEY (organization_id, caller_id, installation_id, message_id),
          UNIQUE (tenant, owner, task_id),
          FOREIGN KEY (tenant, owner, task_id) REFERENCES a2a_tasks(tenant, owner, id),
          CHECK ((thread_id IS NULL) = (run_id IS NULL)),
          CHECK (received_at IS NULL OR result_sha256 IS NOT NULL)
        ); PRAGMA user_version = 1;`);
      })();
    }
    const ledger = sqlite.prepare('SELECT name FROM a2a_a2a_tasks_migrations').all() as { name: string }[];
    if (ledger.length !== 1 || ledger[0].name !== '0001_create_tasks' || (sqlite.pragma('foreign_key_check') as unknown[]).length) throw storageError();
    if (process.platform !== 'win32') await chmod(file, 0o600);
    db = new Kysely<Database>({ dialect: new SqliteDialect({ database: sqlite }), plugins: [safeTaskRows(maxTaskBytes)] });
    const database = db;
    const sdk = (connection: Kysely<Database> = database): TaskStore => {
      // This operation-local plugin sees SDK-selected columns; no result cache, extra SELECT, or custom paging.
      const payloads = new Map<string, Record<string, unknown>>();
      const store = new DatabaseTaskStore(connection.withPlugin(safeTaskRows(maxTaskBytes, payloads)), { tableName: 'a2a_tasks' });
      return {
        save: (task, context) => store.save(task, context),
        async load(taskId, context) {
          const task = await store.load(taskId, context);
          return task && restoreJsonNull(task, payloads.get(task.id));
        },
        async list(params, context) {
          const response = await store.list(params, context);
          response.tasks.forEach(task => restoreJsonNull(task, payloads.get(task.id)));
          return response;
        },
      };
    };
    let closing = false;
    const pending = new Set<Promise<unknown>>();
    const run = <T>(operation: () => Promise<T>): Promise<T> => {
      if (closing) return Promise.reject(new RuntimeError('unavailable', 'A2A 存储已关闭。'));
      const promise = operation().catch(cause => {
        if (cause instanceof A2AError || cause instanceof RuntimeError) throw cause;
        throw storageError(cause);
      });
      pending.add(promise);
      promise.then(() => pending.delete(promise), () => pending.delete(promise));
      return promise;
    };
    const association = (connection: Kysely<Database>, taskId: string, context: ServerCallContext) => {
      const { tenant, owner } = scope(context);
      return connection.selectFrom('omniops_a2a_delivery').selectAll().where('tenant', '=', tenant)
        .where('owner', '=', owner).where('task_id', '=', taskId).executeTakeFirst();
    };
    const checkedTask = (task: Task) => {
      if (Buffer.byteLength(JSON.stringify(Task.toJSON(task))) > maxTaskBytes) throw new RequestMalformedError('A2A Task 超出大小限制。');
      return task;
    };
    const save = async (task: Task, context: ServerCallContext) => database.transaction().execute(async trx => {
      scope(context);
      const row = await association(trx, task.id, context);
      const current = await sdk(trx).load(task.id, context);
      if (!row || !current) throw storageError();
      checkSeal(current, row);
      if (row.result_sha256 !== null) {
        if (canonicalize(Task.toJSON(current)) !== canonicalize(Task.toJSON(task))) throw new RequestMalformedError('A2A 终态已冻结。');
        return;
      }
      const next = checkedTask(seal(task));
      await sdk(trx).save(next, context);
      if (isTerminalTask(next)) await trx.updateTable('omniops_a2a_delivery')
        .set({ result_sha256: taskResultSha256(next) }).where('tenant', '=', row.tenant)
        .where('owner', '=', row.owner).where('task_id', '=', row.task_id).executeTakeFirstOrThrow();
    });
    const taskStore: TaskStore = {
      save: (task, context) => run(() => save(task, context)),
      load: (taskId, context) => run(async () => { scope(context); return sdk().load(taskId, context); }),
      list: (params, context) => run(async () => { scope(context); return sdk().list(params, context); }),
    };
    // Recover every persisted task once. SDK owns Task decoding; the project table is only its association/seal.
    await database.transaction().execute(async trx => {
      const rows = await trx.selectFrom('omniops_a2a_delivery').selectAll().execute();
      const count = await trx.selectFrom('a2a_tasks').select(eb => eb.fn.countAll().as('total')).executeTakeFirstOrThrow();
      if (Number(count.total) !== rows.length) throw storageError();
      for (const row of rows) {
        signal?.throwIfAborted();
        for (const key of ['organization_id', 'caller_id', 'installation_id', 'message_id', 'agent_id', 'content_id', 'task_id'] as const) requireId(row[key]);
        if (!/^[0-9a-f]{64}$/u.test(row.fingerprint) || row.owner !== principalOwner({
          organizationId: row.organization_id, callerId: row.caller_id, installationId: row.installation_id,
        })) throw storageError();
        if (row.thread_id !== null) requireId(row.thread_id);
        if (row.run_id !== null) requireId(row.run_id);
        if (row.received_at !== null && !isTimestamp(row.received_at)) throw storageError();
        const context = new ServerCallContext({ tenant: row.tenant, requestedVersion: '1.0',
          user: { isAuthenticated: true, userName: row.owner } });
        const task = await sdk(trx).load(row.task_id, context);
        if (!task) throw storageError();
        checkSeal(task, row);
        if (isTerminalTask(task)) continue;
        task.status = { state: TaskState.TASK_STATE_FAILED, timestamp: new Date().toISOString(),
          message: statusMessage(task, 'interrupted-unknown', '执行因进程退出而中断，未自动重跑。') };
        task.history.push(task.status.message!);
        const recovered = checkedTask(seal(task));
        await sdk(trx).save(recovered, context);
        await trx.updateTable('omniops_a2a_delivery').set({ result_sha256: taskResultSha256(recovered) })
          .where('tenant', '=', row.tenant).where('owner', '=', row.owner).where('task_id', '=', row.task_id).execute();
      }
    });
    signal?.throwIfAborted();
    return {
      taskStore,
      accept: (request: Acceptance, create: () => InitialTask, beforeCommit?: () => void): Promise<{ task: Task; fresh: boolean }> => run(async () => {
        const { principal, messageId, fingerprint, agentId, contentId, context } = request;
        const { tenant, owner } = scope(context);
        for (const value of [...Object.values(principal), messageId, agentId, contentId]) requireId(value);
        if (principalOwner(principal) !== owner || !/^[0-9a-f]{64}$/u.test(fingerprint)) throw storageError();
        const identity = (connection: Kysely<Database>) => connection.selectFrom('omniops_a2a_delivery').selectAll()
          .where('organization_id', '=', principal.organizationId).where('caller_id', '=', principal.callerId)
          .where('installation_id', '=', principal.installationId).where('message_id', '=', messageId).executeTakeFirst();
        let createdId: string | undefined;
        const existingTask = async (connection: Kysely<Database>, row: DeliveryRow) => {
          if (row.fingerprint !== fingerprint) throw new RequestMalformedError('messageId 已用于不同请求。');
          if (row.tenant !== tenant || row.owner !== owner || row.agent_id !== agentId || row.content_id !== contentId) throw new RequestMalformedError('messageId 已用于不同入口。');
          const task = await sdk(connection).load(row.task_id, context);
          if (!task) throw storageError();
          checkSeal(task, row);
          return { task, fresh: row.task_id === createdId };
        };
        try {
          return await database.transaction().execute(async trx => {
            const row = await identity(trx);
            if (row) return existingTask(trx, row);
            checkWaiting(context);
            const initial = create();
            const task = checkedTask(seal(initial.task));
            requireId(task.id); requireId(task.contextId);
            if ((initial.threadId === undefined) !== (initial.runId === undefined)) throw storageError();
            createdId = task.id;
            await sdk(trx).save(task, context);
            await trx.insertInto('omniops_a2a_delivery').values({
              organization_id: principal.organizationId, caller_id: principal.callerId, installation_id: principal.installationId,
              message_id: messageId, fingerprint, agent_id: agentId, content_id: contentId,
              tenant, owner, task_id: task.id, thread_id: initial.threadId ?? null, run_id: initial.runId ?? null,
              result_sha256: isTerminalTask(task) ? taskResultSha256(task) : null, received_at: null,
            }).execute();
            checkWaiting(context);
            beforeCommit?.();
            return { task, fresh: true };
          });
        } catch (cause) {
          // A commit rejection is ambiguous. Reconcile the durable identity before caller releases its reservation.
          if (createdId) {
            let committed: DeliveryRow | undefined;
            try { committed = await identity(database); }
            catch (reconcileError) {
              throw Object.assign(storageError(reconcileError), { acceptanceUnknown: true as const });
            }
            if (committed) return existingTask(database, committed);
          }
          throw cause;
        }
      }),
      confirm: (receipt: Receipt, context: ServerCallContext) => run(() => database.transaction().execute(async trx => {
        const row = await association(trx, receipt.taskId, context);
        const task = await sdk(trx).load(receipt.taskId, context);
        if (!row || !task) throw new TaskNotFoundError();
        checkSeal(task, row);
        if (!row.result_sha256 || row.result_sha256 !== receipt.resultSha256 || !/^[0-9a-f]{64}$/u.test(receipt.resultSha256) ||
          !isTimestamp(receipt.receivedAt)) throw new RequestMalformedError('A2A 交付回执无效。');
        checkWaiting(context);
        if (row.received_at === null) await trx.updateTable('omniops_a2a_delivery').set({ received_at: receipt.receivedAt })
          .where('tenant', '=', row.tenant).where('owner', '=', row.owner).where('task_id', '=', row.task_id)
          .where('result_sha256', '=', receipt.resultSha256).where('received_at', 'is', null).execute();
        checkWaiting(context);
        return { taskId: task.id, resultSha256: receipt.resultSha256 };
      })),
      close: async () => {
        closing = true;
        await Promise.allSettled([...pending]);
        await database.destroy().catch(cause => { throw storageError(cause); });
      },
    };
  } catch (cause) {
    if (db) await db.destroy().catch(() => {});
    else if (sqlite?.open) sqlite.close();
    if (signal?.aborted) throw new RuntimeError('aborted', 'A2A 存储初始化已停止。');
    if (cause instanceof RuntimeError && cause.kind === 'invalid-request') throw cause;
    throw storageError(cause);
  }
}
