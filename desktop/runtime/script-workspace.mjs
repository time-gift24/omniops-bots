import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const runtimeDir = dirname(fileURLToPath(import.meta.url));
const runnerPath = join(runtimeDir, 'script-runner.mjs');
const hash = code => createHash('sha256').update(code).digest('hex');
const compact = run => run && ({ id: run.id, status: run.status, exitCode: run.exitCode, durationMs: run.durationMs, sha256: run.sha256 });

export async function createScriptWorkspace({ dataDir, ensureBrowser, signalEvent, redact }) {
  const root = join(await realpath(dataDir), 'automation');
  const scriptsDir = join(root, 'scripts');
  const runsDir = join(root, 'runs');
  for (const dir of [root, scriptsDir, runsDir]) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    if ((await lstat(dir)).isSymbolicLink()) throw new Error('Automation directories must not be symlinks');
  }

  function scriptPath(name) {
    if (typeof name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}\.mjs$/.test(name)) {
      throw new Error('Use a flat script name, for example bing-search.mjs (letters, numbers, _ and - only)');
    }
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])\.mjs$/i.test(name)) throw new Error('Reserved Windows device names cannot be used for scripts');
    return join(scriptsDir, name);
  }

  async function readRunRecord(id) {
    if (typeof id !== 'string' || !/^[\dTZ_-]+[a-f0-9-]+$/.test(id)) throw new Error('Invalid run ID');
    const runDir = join(runsDir, id);
    const run = JSON.parse(await readFile(join(runDir, 'run.json'), 'utf8'));
    if (!run || Array.isArray(run) || run.id !== id || typeof run.name !== 'string'
      || typeof run.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(run.sha256)
      || !['passed', 'failed', 'timed_out', 'cancelled'].includes(run.status)) throw new Error('Invalid run record');
    for (const key of ['stdout', 'stderr', 'error', 'url', 'title', 'screenshot']) {
      if (run[key] !== undefined && typeof run[key] !== 'string') throw new Error(`Invalid run record field: ${key}`);
    }
    if (run.durationMs !== undefined && (!Number.isFinite(run.durationMs) || run.durationMs < 0)) throw new Error('Invalid run duration');
    return run;
  }

  async function readRun(id) {
    const run = await readRunRecord(id);
    const runDir = join(runsDir, id);
    try { run.screenshot = `data:image/png;base64,${(await readFile(join(runDir, 'output/screenshot.png'))).toString('base64')}`; } catch {}
    return run;
  }

  async function lastRun(name, withScreenshot = false) {
    let hasPointer = false;
    try {
      const text = await readFile(join(scriptsDir, `${name}.last-run.json`), 'utf8');
      hasPointer = true;
      const pointer = JSON.parse(text);
      const run = await (withScreenshot ? readRun(pointer?.id) : readRunRecord(pointer?.id));
      if (run.name !== name) throw new Error('Run record does not match this script');
      return { lastRun: run };
    } catch (error) {
      if (!hasPointer && error.code === 'ENOENT') return { lastRun: null };
      return { lastRun: null, lastRunError: redact(`历史运行记录不可用：${error.message}`) };
    }
  }

  async function readSource(name) {
    const path = scriptPath(name);
    if ((await lstat(path)).isSymbolicLink() || await realpath(path) !== path) throw new Error('Script symlinks are not allowed');
    const code = await readFile(path, 'utf8');
    if (Buffer.byteLength(code) > 128 * 1024) throw new Error('Script exceeds 128 KiB');
    return { name, path, code, sha256: hash(code), updatedAt: (await stat(path)).mtime.toISOString() };
  }

  async function read(name) {
    return { ...await readSource(name), ...await lastRun(name, true) };
  }

  async function save({ name, code }) {
    const path = scriptPath(name);
    if (typeof code !== 'string' || !code.trim() || Buffer.byteLength(code) > 128 * 1024) throw new Error('Script code must contain 1–131072 bytes');
    // Atomic replacement also replaces a pre-existing symlink without following it.
    const temporary = join(scriptsDir, `.${randomUUID()}.tmp`);
    await writeFile(temporary, code, { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
    return read(name);
  }

  async function list() {
    // ponytail: scan this small desktop workspace; add an index only if thousands of scripts make it slow.
    const result = [];
    for (const name of (await readdir(scriptsDir)).filter(name => name.endsWith('.mjs')).sort()) {
      const { code, ...entry } = await readSource(name);
      const history = await lastRun(name);
      result.push({ ...entry, ...history, lastRun: compact(history.lastRun) });
    }
    return result;
  }

  async function run({ name, sha256, parameters = {}, timeoutMs = 30_000 }, signal) {
    if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) throw new Error('parameters must be a JSON object');
    if (!Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 90_000) throw new Error('timeoutMs must be between 100 and 90000');
    const parametersJSON = JSON.stringify(parameters);
    if (Buffer.byteLength(parametersJSON) > 16_384) throw new Error('parameters exceeds 16 KiB');
    signal?.throwIfAborted();
    const source = await readSource(name);
    if (sha256 !== undefined && source.sha256 !== sha256) throw new Error('脚本源码已改变，请重新审阅并批准当前版本。');
    const id = `${new Date().toISOString().replaceAll(':', '-').replace('.', '-')}_${randomUUID()}`;
    const runDir = join(runsDir, id);
    const artifactDir = join(runDir, 'output');
    await mkdir(artifactDir, { recursive: true, mode: 0o700 });
    const snapshot = join(runDir, 'script.mjs');
    await writeFile(snapshot, source.code, { mode: 0o400, flag: 'wx' });
    const started = Date.now();
    let stdout = '', stderr = '', payload = '', error, exitCode = null, timedOut = false, cancelled = false;
    let parsed = {};
    try {
      const { endpoint, targetId } = await ensureBrowser();
      signal?.throwIfAborted();
      const child = spawn(process.execPath, [
        '--permission', '--allow-net',
        `--allow-fs-read=${runtimeDir}`, `--allow-fs-read=${snapshot}`,
        `--allow-fs-read=${artifactDir}`, `--allow-fs-write=${artifactDir}`,
        runnerPath, endpoint, snapshot, artifactDir, parametersJSON, targetId || '',
      ], {
        env: { LANG: process.env.LANG || 'en_US.UTF-8', TZ: process.env.TZ || 'UTC', TMPDIR: artifactDir },
        cwd: artifactDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
      });
      signalEvent({ event: 'runner_started', pid: child.pid });
      const append = (current, chunk) => (current + chunk.toString('utf8')).slice(0, 65_536);
      child.stdout.on('data', chunk => { stdout = append(stdout, chunk); });
      child.stderr.on('data', chunk => { stderr = append(stderr, chunk); });
      child.stdio[3].on('data', chunk => {
        payload += chunk.toString('utf8');
        if (payload.length > 1_048_576) { error = 'Script result exceeds 1 MiB'; payload = ''; child.kill('SIGKILL'); }
      });
      const abort = () => { cancelled = true; child.kill('SIGKILL'); };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
      try {
        exitCode = await new Promise((resolve, reject) => {
          child.once('error', reject);
          child.once('close', code => resolve(code));
        });
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        signalEvent({ event: 'runner_closed', pid: child.pid });
      }
      if (payload) {
        try { parsed = JSON.parse(payload); } catch { error ||= 'Runner returned an invalid result'; }
      } else if (!cancelled && !timedOut) error ||= 'Runner exited without a result';
      error ||= parsed.error || (exitCode !== 0 ? `Script exited with code ${exitCode}` : undefined);
    } catch (cause) {
      cancelled ||= signal?.aborted ?? false;
      error = cause.message;
    }
    const result = {
      id, name, status: cancelled ? 'cancelled' : timedOut ? 'timed_out' : error ? 'failed' : 'passed',
      exitCode, stdout: redact(stdout), stderr: redact(stderr), result: parsed.result ?? null,
      ...(error ? { error: redact(error) } : {}),
      sourcePath: source.path, scriptPath: snapshot, artifactDir,
      durationMs: Date.now() - started, sha256: source.sha256,
      ...(parsed.url ? { url: parsed.url, title: parsed.title } : {}),
    };
    await writeFile(join(runDir, 'run.json'), redact(JSON.stringify(result, null, 2)) + '\n', { mode: 0o600 });
    const pointerPath = join(scriptsDir, `${name}.last-run.json`);
    await writeFile(`${pointerPath}.tmp`, JSON.stringify({ id }) + '\n', { mode: 0o600 });
    await rename(`${pointerPath}.tmp`, pointerPath);
    try { result.screenshot = `data:image/png;base64,${(await readFile(join(artifactDir, 'screenshot.png'))).toString('base64')}`; } catch {}
    return result;
  }

  return { read, save, list, run, readRun, scriptsDir, runsDir };
}
