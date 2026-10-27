import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { initialize } from './init.mjs';

async function deadline(promise, milliseconds = 5000) {
 let timer;
 try { return await Promise.race([promise, new Promise((_, no) => { timer = setTimeout(() => no(new Error('Process boundary deadline exceeded.')), milliseconds); })]); }
 finally { clearTimeout(timer); }
}
async function until(check) {
 const end = Date.now() + 5000;
 do { const result = await check(); if (result) return result; await delay(20); } while (Date.now() < end);
 throw new Error('Expected process state was not observed.');
}
async function peer(t) {
 const root = await mkdtemp(join(tmpdir(), 'omniops-main-security-'));
 const children = [];
 t.after(async () => {
  for (const { child, exited } of children.toReversed()) { if (child.exitCode === null && !child.signalCode) child.kill('SIGTERM'); await deadline(exited.promise); }
  await rm(root, { recursive: true, force: true });
 });
 const paths = await initialize(root), config = JSON.parse(await readFile(paths.configFile, 'utf8'));
 const secret = (await readFile(config.control.secretFile, 'utf8')).trim();
 const child = spawn(process.execPath, [fileURLToPath(new URL('./server.mjs', import.meta.url)), '--config', paths.configFile], { stdio: ['ignore', 'pipe', 'pipe'] });
 const started = Promise.withResolvers(), exited = Promise.withResolvers();
 children.push({ child, exited });
 child.stderr.resume();
 child.once('error', started.reject);
 child.once('exit', code => { exited.resolve(code); started.reject(new Error('Peer exited before ready.')); });
 createInterface({ input: child.stdout }).on('line', line => { const value = JSON.parse(line); if (value.event === 'ready') started.resolve(value); });
 const ready = await deadline(started.promise);
 const control = async (path, body) => {
  const response = await fetch(ready.controlOrigin + path, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200, 'Peer control request succeeds.');
  return response.json();
 };
 return { root, paths, config, ready, control, children };
}
async function main(t, fixture, name, tokenFile = fixture.config.identities[0].tokenFile) {
 const root = join(fixture.root, name), started = Promise.withResolvers(), exited = Promise.withResolvers(), pending = new Map();
 let sequence = 0, stdout = '', stderr = '';
 const child = spawn(process.execPath, [resolve(import.meta.dirname, '../runtime/main.ts')], {
  cwd: resolve(import.meta.dirname, '../runtime'),
  env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, SystemRoot: process.env.SystemRoot, USER: process.env.USER, LANG: process.env.LANG,
   OMNIOPS_BOTS_DATA_DIR: join(root, 'app'), OMNIOPS_BOTS_LOCAL_ROOT: join(root, 'local'), OMNIOPS_BOTS_PLATFORM_URL: fixture.ready.publicOrigin, OMNIOPS_BOTS_PLATFORM_TOKEN_FILE: tokenFile,
   OMNIOPS_BOTS_MODEL: '', OPENAI_API_KEY: '', OPENAI_BASE_URL: '', NODE_EXTRA_CA_CERTS: fixture.paths.trustedCaFile },
  stdio: ['pipe', 'pipe', 'pipe'],
 });
 fixture.children.push({ child, exited });
 child.stderr.on('data', bytes => { assert.ok(stderr.length + bytes.length < 65536, 'Stderr stays bounded.'); stderr += bytes; });
 child.once('error', started.reject);
 child.once('exit', code => { exited.resolve(code); const error = new Error('Main exited before the IPC response.'); started.reject(error); for (const request of pending.values()) request.reject(error); pending.clear(); });
 createInterface({ input: child.stdout }).on('line', line => {
  assert.ok(stdout.length + line.length < 65536, 'Stdout stays bounded.'); stdout += line + '\n';
  const message = JSON.parse(line);
  if (message.event === 'ready') started.resolve();
  const response = pending.get(message.id); if (response) { pending.delete(message.id); response.resolve(message); }
 });
 const rpc = (method, params) => { const id = ++sequence, response = Promise.withResolvers(); pending.set(id, response); child.stdin.write(JSON.stringify({ id, method, params }) + '\n'); return deadline(response.promise); };
 t.after(async () => { if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL'); await deadline(exited.promise); });
 await deadline(started.promise);
 return { rpc, output: () => stdout + stderr, async close() { assert.deepEqual((await rpc('shutdown')).result, { stopped: true }); assert.equal(await deadline(exited.promise), 0); } };
}

test('real main serializes initial and manual WSS handshakes and closes pending transport without an orphan', { timeout: 20000 }, async t => {
 const fixture = await peer(t);
 await fixture.control('/fault', { name: 'delay-handshake', durationMs: 1200 });
 const client = await main(t, fixture, 'reconnect');
 await until(async () => (await fixture.control('/stats')).counts.pendingHandshakes === 1);
 const initial = await Promise.all([client.rpc('platform_reconnect'), client.rpc('platform_reconnect')]);
 assert.ok(initial.every(reply => reply.error?.kind === 'busy'), 'Both manual attempts are busy while initial startup owns the connection.');
 await until(async () => (await fixture.control('/stats')).activeConnections === 1);
 assert.equal((await fixture.control('/stats')).counts.connections, 1);
 await fixture.control('/fault', { name: 'delay-handshake', durationMs: 1200 });
 const manual = await Promise.all([client.rpc('platform_reconnect'), client.rpc('platform_reconnect')]);
 assert.deepEqual(manual[0].result, { connecting: true });
 assert.equal(manual[1].error?.kind, 'busy', 'A second parallel manual reconnect is rejected.');
 await until(async () => (await fixture.control('/stats')).counts.pendingHandshakes === 1);
 const connected = await until(async () => { const stats = await fixture.control('/stats'); return stats.activeConnections === 1 && stats.counts.connections === 2 ? stats : null; });
 assert.equal(connected.counts.upgradeAttempts, 2, 'Only one upgrade is started per accepted reconnect.');
 assert.equal(connected.clients.length, 1);
 await fixture.control('/fault', { name: 'delay-handshake', durationMs: 1200 });
 assert.deepEqual((await client.rpc('platform_reconnect')).result, { connecting: true });
 await until(async () => (await fixture.control('/stats')).counts.pendingHandshakes === 1);
 await client.close();
 await until(async () => { const stats = await fixture.control('/stats'); return stats.activeConnections === 0 && stats.counts.pendingHandshakes === 0; });
 await delay(1300);
 const closed = await fixture.control('/stats');
 assert.equal(closed.activeConnections, 0);
 assert.equal(closed.clients.length, 0);
 assert.equal(closed.counts.connections, 2, 'The canceled delayed handshake never creates another connection.');
 assert.equal(closed.counts.modelRequests, 0);
 assert.equal(closed.counts.mcpCalls, 0);
});

test('real main rejects linked and oversized token files without exposing file bytes', { timeout: 15000 }, async t => {
 const fixture = await peer(t), original = (await readFile(fixture.config.identities[0].tokenFile, 'utf8')).trim();
 const sentinel = `TOKEN_FILE_SECRET_${randomUUID()}`;
 const linked = join(fixture.root, 'linked-token'), oversized = join(fixture.root, 'oversized-token');
 await symlink(fixture.config.identities[0].tokenFile, linked, 'file');
 await writeFile(oversized, sentinel.repeat(Math.ceil(8193 / sentinel.length)), { mode: 0o600 });
 for (const [name, tokenFile] of [['linked', linked], ['oversized', oversized]]) await t.test(name, async subtest => {
  const client = await main(subtest, fixture, name, tokenFile);
  const status = await until(async () => { const reply = await client.rpc('status'); return reply.result.connection.state === 'blocked' ? reply.result.connection : null; });
  assert.equal(status.reason, 'protocol');
  const session = await client.rpc('platform_session');
  assert.equal(session.error?.kind, 'invalid-request');
  assert.equal((await fixture.control('/stats')).counts.upgradeAttempts, 0, 'Invalid files never reach a WSS upgrade.');
  await client.close();
  assert.ok(!client.output().includes(original), 'The credential never appears in stdout or stderr.');
  assert.ok(!client.output().includes(sentinel), 'Oversized file bytes never appear in stdout or stderr.');
 });
});
