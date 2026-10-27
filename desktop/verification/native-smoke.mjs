import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, writeFile, realpath, lstat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

async function hash(file) { const value = createHash('sha256'); for await (const bytes of createReadStream(file)) value.update(bytes); return value.digest('hex'); }
async function phases(file) { try { const text = await readFile(file, 'utf8'); assert.ok(text.length < 1024 * 1024); return text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } }
async function until(check, milliseconds = 20000) { const end = Date.now() + milliseconds; do { const value = await check(); if (value) return value; await delay(25); } while (Date.now() < end); throw new Error('Native process boundary deadline exceeded.'); }
async function snapshot(directory) { const files = []; async function visit(root, prefix = '') { for (const name of (await readdir(root)).sort()) { const path = join(root, name), relative = prefix + name, info = await lstat(path); assert.ok(!info.isSymbolicLink()); if (info.isDirectory()) await visit(path, relative + '/'); else if (name !== '.desktop.lock') files.push([relative, await hash(path)]); } } await visit(directory); return files; }

/** Debug-package acceptance. A preload records only fixed lifecycle fields, never IPC bodies. */
export async function runNativeSmoke(executable, directory) {
 assert.ok(process.platform === 'darwin', 'This packaged native smoke currently requires macOS.');
 assert.ok(isAbsolute(executable) && isAbsolute(directory), 'Native smoke paths must be absolute.');
 assert.ok((await lstat(executable)).isFile(), 'The packaged executable must exist.');
 await mkdir(directory, { recursive: true, mode: 0o700 }); directory = await realpath(directory);
 assert.equal((await readdir(directory)).length, 0, 'Native smoke requires an empty isolated directory.');
 const probe = join(directory, 'probe.cjs'), localRoot = join(directory, 'local'), children = [], startedAt = new Date().toISOString();
 await writeFile(probe, `const fs=require('node:fs');const file=process.env.OMNIOPS_BOTS_NATIVE_PROBE_FILE;function mark(value){fs.appendFileSync(file,JSON.stringify(value)+'\\n',{mode:0o600});}mark({event:'loaded',pid:process.pid,diagnosticsOnly:process.env.OMNIOPS_BOTS_DIAGNOSTICS_ONLY==='1'});const out=process.stdout.write;process.stdout.write=function(chunk,...args){try{for(const line of String(chunk).trim().split('\\n')){const value=JSON.parse(line);if(value.event==='ready'){mark({event:'ready',diagnosticsOnly:!!value.state?.diagnosticsOnly});if(value.state?.diagnosticsOnly)setImmediate(()=>process.stdin.emit('data',Buffer.from(JSON.stringify({id:910001,method:'diagnostic_threads',params:{}})+'\\n')));}else if(value.id!==undefined){mark({event:'reply',id:value.id,errorKind:value.error?.kind,hasResult:Object.hasOwn(value,'result')});if(value.id===910001)setImmediate(()=>process.stdin.emit('data',Buffer.from(JSON.stringify({id:910002,method:'chat_start',params:{}})+'\\n')));}}}catch{}return out.call(this,chunk,...args);};process.on('exit',code=>mark({event:'exit',code}));`, { mode: 0o600 });
 const launch = (name, diagnosticsOnly, exitAfterMs) => {
  const evidenceFile = join(directory, `${name}-node.jsonl`);
  const child = spawn(executable, diagnosticsOnly ? ['--diagnostics'] : [], { detached: true,
   env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, USER: process.env.USER, LOGNAME: process.env.LOGNAME, LANG: process.env.LANG,
    OMNIOPS_BOTS_SMOKE_DATA_DIR: join(directory, `${name}-cef`), OMNIOPS_BOTS_DATA_DIR: join(directory, `${name}-app`), OMNIOPS_BOTS_LOCAL_ROOT: localRoot,
    OMNIOPS_BOTS_SMOKE_EXIT_MS: String(exitAfterMs), OMNIOPS_BOTS_MODEL: '', OPENAI_API_KEY: '', OPENAI_BASE_URL: '', NODE_OPTIONS: `--require ${JSON.stringify(probe)}`, OMNIOPS_BOTS_NATIVE_PROBE_FILE: evidenceFile }, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = Promise.withResolvers(), outputHash = createHash('sha256'); let outputBytes = 0;
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { outputBytes += bytes.length; outputHash.update(bytes); });
  child.once('error', exited.reject); child.once('exit', (code, signal) => exited.resolve({ code, signal }));
  const entry = { child, evidenceFile, exited: exited.promise, output: () => ({ outputBytes, outputSha256: outputHash.digest('hex') }) }; children.push(entry); return entry;
 };
 const stop = async entry => {
  const signal = name => { try { process.kill(-entry.child.pid, name); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
  if (entry.child.exitCode === null && !entry.child.signalCode) { signal('SIGTERM'); await Promise.race([entry.exited, delay(2000)]); if (entry.child.exitCode === null && !entry.child.signalCode) signal('SIGKILL'); }
  await entry.exited;
  const events = await phases(entry.evidenceFile); if (!events.some(event => event.event === 'exit')) for (const event of events.filter(event => event.event === 'loaded')) { try { process.kill(event.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
 };
 const report = { schemaVersion: 1, startedAt, executableSha256: await hash(executable), cases: [] }; let phase = 'normal-startup';
 try {
  const normal = launch('normal', false, 8000);
  await until(async () => (await phases(normal.evidenceFile)).some(event => event.event === 'ready' && !event.diagnosticsOnly));
  phase = 'shared-root-lock';
  const blocked = launch('locked-diagnostics', true, 1000);
  await delay(2000);
  assert.equal(blocked.child.exitCode, null, 'The second host remains open to show the controlled data-root lock error.');
  assert.equal((await phases(blocked.evidenceFile)).length, 0, 'A competing diagnostic host never starts its Node process.');
  await stop(blocked);
  report.cases.push({ name: 'normal-and-diagnostics-share-exclusive-root', status: 'passed', secondNodeStarted: false });
  phase = 'normal-shutdown';
  const normalExit = await until(async () => normal.child.exitCode !== null ? await normal.exited : null);
  assert.equal(normalExit.code, 0);
  const normalPhases = await phases(normal.evidenceFile);
  assert.ok(normalPhases.some(event => event.event === 'exit' && event.code === 0), 'Node completes shutdown normally.');
  assert.ok(!normalPhases.some(event => event.event === 'reply' && event.id === null), 'Host requests remain valid JSONL IPC.');
  report.cases.push({ name: 'packaged-native-normal-ready-shutdown', status: 'passed', hostExitCode: normalExit.code, nodeExitCode: 0, ...normal.output() });
  phase = 'standalone-readonly';
  const before = await snapshot(localRoot), standalone = launch('standalone-diagnostics', true, 1000);
  report.localFilesBefore = before;
  await until(async () => (await phases(standalone.evidenceFile)).some(event => event.event === 'ready' && event.diagnosticsOnly));
  const standaloneExit = await until(async () => standalone.child.exitCode !== null ? await standalone.exited : null);
  report.standaloneExit = standaloneExit;
  assert.equal(standaloneExit.code, 0);
  const standalonePhases = await phases(standalone.evidenceFile);
  assert.ok(standalonePhases.some(event => event.id === 910001 && event.hasResult), 'Standalone diagnostics accepts a real read-only list request.');
  assert.ok(standalonePhases.some(event => event.id === 910002 && event.errorKind === 'invalid-request'), 'Standalone diagnostics rejects execution.');
  assert.ok(standalonePhases.some(event => event.event === 'exit' && event.code === 0));
  const after = await snapshot(localRoot); report.localFilesAfter = after;
  const sidecars = new Set(['checkpoints.sqlite-shm', 'checkpoints.sqlite-wal']);
  assert.deepEqual(after.filter(([path]) => !sidecars.has(path)), before.filter(([path]) => !sidecars.has(path)), 'Standalone list and rejected execution preserve source record and checkpoint bytes.');
  const previousWal = before.find(([path]) => path === 'checkpoints.sqlite-wal')?.[1], nextWal = after.find(([path]) => path === 'checkpoints.sqlite-wal')?.[1], emptyHash = createHash('sha256').digest('hex');
  if (previousWal && previousWal !== emptyHash) assert.equal(nextWal, previousWal, 'Existing checkpoint WAL bytes are preserved.');
  else assert.ok(!nextWal || nextWal === emptyHash, 'A read-only SQLite connection can create only an empty WAL.');
  report.cases.push({ name: 'standalone-diagnostics-after-lock-release', status: 'passed', hostExitCode: 0, executionRejected: true, sourceFilesUnchanged: true,
   sqliteReadSidecars: after.filter(([path]) => sidecars.has(path)), ...standalone.output() });
  report.result = 'passed';
 } catch (error) { report.result = 'failed'; report.reason = 'A native startup, shutdown, shared-lock or read-only assertion failed.'; report.failedPhase = phase; if (error.name === 'AssertionError') report.assertion = error.message.split('\n')[0]; }
 finally { for (const entry of children.toReversed()) try { await stop(entry); } catch { report.result = 'failed'; report.failedPhase ??= 'cleanup'; report.reason = 'An owned native process could not be cleaned up.'; } }
 report.endedAt = new Date().toISOString();
 const reportFile = join(directory, 'native-report.json'); await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 }); return { reportFile, ...report };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
 try { const args = process.argv.slice(2); if (args.length !== 4 || args[0] !== '--executable' || args[2] !== '--directory') throw new Error('Usage: native-smoke.mjs --executable /absolute/debug/app-binary --directory /absolute/empty-directory'); const result = await runNativeSmoke(args[1], args[3]); console.log(JSON.stringify({ reportFile: result.reportFile, result: result.result })); process.exitCode = result.result === 'passed' ? 0 : 1; }
 catch { process.stderr.write('Native smoke could not complete in the supplied isolated environment.\n'); process.exitCode = 1; }
}
