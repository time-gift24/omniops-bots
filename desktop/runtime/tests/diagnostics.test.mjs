import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { exportOfflineThreadDiagnostics, listOfflineDiagnosticThreads, listSavedDiagnosticPackages, openSavedDiagnosticPackage, previewDiagnosticFile } from '../diagnostics.ts';
import { readPackageZip } from '../package.ts';

const hash = value => createHash('sha256').update(value).digest('hex');
test('diagnostics read only one thread, preserve namespaces/pending writes and redact copies', async t => {
  const root = await mkdtemp(join(tmpdir(), 'omniops-diagnostics-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'runs', '.records'), { recursive: true });
  const record = { threadId: 'selected', runId: 'run-one', graphThreadId: 'graph-one', status: 'completed', startedAt: '2026-10-26T01:00:00Z', details: { apiKey: 'sentinel-secret', events: [{ text: 'Bearer sentinel-secret' }] } };
  const recordFile = join(root, 'runs', '.records', hash(record.runId) + '.json');
  await writeFile(recordFile, JSON.stringify(record));
  await writeFile(join(root, 'runs', '.records', hash('other') + '.json'), JSON.stringify({ ...record, runId: 'other', threadId: 'other', graphThreadId: 'graph-other', details: { text: 'OTHER-THREAD-PRIVATE' } }));
  const db = new Database(join(root, 'checkpoints.sqlite'));
  db.exec('CREATE TABLE checkpoints(thread_id TEXT,checkpoint_ns TEXT,checkpoint_id TEXT,parent_checkpoint_id TEXT,type TEXT,checkpoint BLOB,metadata BLOB); CREATE TABLE writes(thread_id TEXT,checkpoint_ns TEXT,checkpoint_id TEXT,task_id TEXT,task_path TEXT,idx INTEGER,channel TEXT,type TEXT,value BLOB)');
  for (const ns of ['', 'child:one']) db.prepare('INSERT INTO checkpoints VALUES (?,?,?,?,?,?,?)').run('graph-one', ns, 'cp1', null, 'json', Buffer.from(JSON.stringify({ token: 'sentinel-secret', value: false })), Buffer.from('{}'));
  db.prepare('INSERT INTO checkpoints VALUES (?,?,?,?,?,?,?)').run('graph-other', '', 'other-cp', null, 'json', Buffer.from('{"private":"OTHER-THREAD-PRIVATE"}'), Buffer.from('{}'));
  db.prepare('INSERT INTO writes VALUES (?,?,?,?,?,?,?,?,?)').run('graph-one', 'child:one', 'cp1', 'tool', 'path', 0, 'result', 'json', Buffer.from('{"value":0,"authorization":"sentinel-secret"}'));
  db.close();
  const before = await readFile(recordFile);
  const output = await exportOfflineThreadDiagnostics({ localRoot: root, threadId: 'selected', includeAttachments: [], outputDirectory: join(root, 'out') });
  const zip = await readFile(output.packageFile);
  assert.equal(hash(zip), output.bundleSha256);
  const entries = await readPackageZip(zip);
  const all = entries.filter(e => e.bytes).map(e => Buffer.from(e.bytes).toString()).join('\n');
  assert.doesNotMatch(all, /sentinel-secret|OTHER-THREAD-PRIVATE/);
  const checkpoints = JSON.parse(Buffer.from(entries.find(e => e.path.startsWith('checkpoints/')).bytes).toString());
  assert.deepEqual(checkpoints.checkpoints.map(c => c.checkpoint_ns), ['', 'child:one']);
  assert.equal(checkpoints.pendingWrites[0].value.value, 0);
  assert.equal(output.manifest.sourceInstallationId, null);
  assert.equal(output.manifest.runs[0].lastEventSequence, 0);
  assert.deepEqual(output.manifest.runs[0].namespaces, [{ namespace: '', checkpointId: 'cp1' }, { namespace: 'child:one', checkpointId: 'cp1' }]);
  assert.equal(output.manifest.runs[0].collectedAt, output.manifest.cutoff);
  assert.deepEqual(await readFile(recordFile), before);
  assert.equal(output.preview.missing.some(m => m.reason === 'session-unavailable'), true);
  await writeFile(join(root, 'out', `${output.uploadId}.json`), JSON.stringify(output));
  const list = await listOfflineDiagnosticThreads({ localRoot: root, limit: 1 });
  assert.equal(list.items.length, 1);
  assert.ok(list.nextCursor);
  assert.equal((await listOfflineDiagnosticThreads({ localRoot: root, limit: 1, cursor: list.nextCursor })).items.length, 1);
});

test('retained package selection and content preview verify the frozen hash and reject arbitrary members', async t => {
  const root = await mkdtemp(join(tmpdir(), 'omniops-diagnostics-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'runs', '.records'), { recursive: true });
  await writeFile(join(root, 'runs', '.records', hash('r') + '.json'), JSON.stringify({ threadId: 't', runId: 'r', graphThreadId: 'g', status: 'completed', startedAt: '2026-10-27T00:00:00Z', details: { authorization: 'secret', text: 'saved evidence' } }));
  const output = await exportOfflineThreadDiagnostics({ localRoot: root, threadId: 't', includeAttachments: [], outputDirectory: join(root, 'diagnostics') });
  await writeFile(join(root, 'diagnostics', `${output.uploadId}.json`), JSON.stringify(output));
  const saved = await listSavedDiagnosticPackages(root);
  assert.equal(saved[0].uploadId, output.uploadId);
  assert.deepEqual(await openSavedDiagnosticPackage(root, output.uploadId), output);
  const content = await previewDiagnosticFile(root, output.uploadId, `runs/${hash('r')}.json`);
  assert.equal(content.mediaType, 'text/plain');
  assert.match(content.text, /saved evidence/);
  assert.doesNotMatch(content.text, /secret/);
  await assert.rejects(previewDiagnosticFile(root, output.uploadId, '../model.env'), { kind: 'invalid-request' });
  await writeFile(output.packageFile, 'different bytes');
  await assert.rejects(openSavedDiagnosticPackage(root, output.uploadId), { kind: 'integrity' });
});

test('diagnostic preview truncates Chinese text between UTF-8 characters without rejecting valid evidence', async t => {
  const root = await mkdtemp(join(tmpdir(), 'omniops-diagnostics-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'runs', '.records'), { recursive: true });
  const record = { threadId: 't', runId: 'r', graphThreadId: 'g', status: 'completed', startedAt: '2026-10-27T00:00:00Z', details: { text: '' } };
  const prefix = Buffer.byteLength(JSON.stringify(record).slice(0, -4));
  record.details.text = 'x'.repeat((1024 * 1024 - prefix) % 3 === 0 ? 1 : 0) + '汉'.repeat(400_000);
  await writeFile(join(root, 'runs', '.records', hash('r') + '.json'), JSON.stringify(record));
  const output = await exportOfflineThreadDiagnostics({ localRoot: root, threadId: 't', includeAttachments: [], outputDirectory: join(root, 'diagnostics') });
  await writeFile(join(root, 'diagnostics', `${output.uploadId}.json`), JSON.stringify(output));
  const file = `runs/${hash('r')}.json`, entries = await readPackageZip(await readFile(output.packageFile));
  const bytes = entries.find(entry => entry.path === file).bytes;
  assert.throws(() => new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, 1024 * 1024)), 'the fixture must split a multibyte character');
  const preview = await previewDiagnosticFile(root, output.uploadId, file);
  assert.equal(preview.mediaType, 'text/plain');
  assert.equal(preview.truncated, true);
  assert.ok(preview.text.endsWith('汉'));
  assert.doesNotMatch(preview.text, /\uFFFD/u);
  assert.ok(Buffer.byteLength(preview.text) <= 1024 * 1024);
});

test('checkpoint and pending-write bytes are bounded before unsupported BLOBs can be materialized', async t => {
  for (const [name, checkpointBytes, pendingBytes, graphs] of [['checkpoint', 101 * 1024 * 1024, 0, ['g']], ['combined', 60 * 1024 * 1024, 41 * 1024 * 1024, ['g']], ['multiple runs', 60 * 1024 * 1024, 0, ['g', 'g-second']]]) {
    await t.test(name, async t => {
      const root = await mkdtemp(join(tmpdir(), 'omniops-diagnostics-'));
      t.after(() => rm(root, { recursive: true, force: true }));
      await mkdir(join(root, 'runs', '.records'), { recursive: true });
      const records = graphs.map(graphThreadId => ({ threadId: 't', runId: `run-${graphThreadId}`, graphThreadId, status: 'completed', startedAt: '2026-10-27T00:00:00Z' }));
      for (const record of records) await writeFile(join(root, 'runs', '.records', hash(record.runId) + '.json'), JSON.stringify(record));
      const db = new Database(join(root, 'checkpoints.sqlite'));
      // SQLite zeroblob views keep the fixture small; selecting the BLOB into JS would allocate all bytes.
      db.exec(`CREATE VIEW checkpoints AS ${graphs.map(graphId => `SELECT '${graphId}' AS thread_id,'' AS checkpoint_ns,'cp' AS checkpoint_id,NULL AS parent_checkpoint_id,'binary' AS type,zeroblob(${checkpointBytes}) AS checkpoint,X'7b7d' AS metadata`).join(' UNION ALL ')};
        CREATE VIEW writes AS ${graphs.map(graphId => `SELECT '${graphId}' AS thread_id,'' AS checkpoint_ns,'cp' AS checkpoint_id,'tool' AS task_id,'path' AS task_path,0 AS idx,'result' AS channel,'binary' AS type,zeroblob(${pendingBytes}) AS value`).join(' UNION ALL ')};`);
      db.close();
      await assert.rejects(exportOfflineThreadDiagnostics({ localRoot: root, threadId: 't', includeAttachments: [], outputDirectory: join(root, 'out') }), { kind: 'resource-limit' });
      for (const record of records) assert.deepEqual(JSON.parse(await readFile(join(root, 'runs', '.records', hash(record.runId) + '.json'), 'utf8')), record);
    });
  }
});

test('embedded screenshots stay excluded from JSON evidence until explicitly selected and can be previewed', async t => {
  const root = await mkdtemp(join(tmpdir(), 'omniops-diagnostics-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'runs', '.records'), { recursive: true });
  const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=';
  const original = JSON.stringify({ threadId: 't', runId: 'r', graphThreadId: 'g', status: 'completed', startedAt: '2026-10-27T00:00:00Z', details: { events: [{ content: JSON.stringify({ screenshot: dataUrl, apiKey: 'nested-secret' }) }] } });
  const recordFile = join(root, 'runs', '.records', hash('r') + '.json');
  await writeFile(recordFile, original);
  const request = { localRoot: root, threadId: 't', includeAttachments: [], outputDirectory: join(root, 'diagnostics') };
  const first = await exportOfflineThreadDiagnostics(request);
  assert.equal(first.preview.attachments.length, 1);
  const initial = await readPackageZip(await readFile(first.packageFile));
  assert.equal(initial.some(entry => entry.path.startsWith('attachments/')), false);
  assert.doesNotMatch(initial.filter(e => e.bytes).map(e => Buffer.from(e.bytes).toString()).join('\n'), /iVBORw0|nested-secret/);
  const selected = await exportOfflineThreadDiagnostics({ ...request, includeAttachments: [first.preview.attachments[0].id] });
  await writeFile(join(root, 'diagnostics', `${selected.uploadId}.json`), JSON.stringify(selected));
  const name = selected.preview.files.find(file => file.path.endsWith('.png')).path;
  const preview = await previewDiagnosticFile(root, selected.uploadId, name);
  assert.equal(preview.mediaType, 'image/png');
  assert.equal(preview.dataUrl, dataUrl);
  assert.equal(await readFile(recordFile, 'utf8'), original);
});

test('diagnostics tolerate bad SQLite and records without repairing or inventing checkpoints', async t => {
  const root = await mkdtemp(join(tmpdir(), 'omniops-diagnostics-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'runs', '.records'), { recursive: true });
  await writeFile(join(root, 'runs', '.records', hash('r') + '.json'), JSON.stringify({ threadId: 't', runId: 'r', graphThreadId: 'g', status: 'running', startedAt: '2026-10-26T00:00:00Z' }));
  await writeFile(join(root, 'checkpoints.sqlite'), 'not a database');
  const output = await exportOfflineThreadDiagnostics({ localRoot: root, threadId: 't', includeAttachments: [], outputDirectory: join(root, 'out') });
  assert.equal(output.preview.missing.some(m => m.reason === 'checkpoint-unavailable'), true);
  assert.equal(output.preview.missing.some(m => m.reason === 'disk-state-incomplete'), true);
  assert.equal(await readFile(join(root, 'checkpoints.sqlite'), 'utf8'), 'not a database');
  await assert.rejects(exportOfflineThreadDiagnostics({ localRoot: root, threadId: 'missing', includeAttachments: [], outputDirectory: join(root, 'out') }), { kind: 'invalid-request' });
  await assert.rejects(exportOfflineThreadDiagnostics({ localRoot: root, threadId: 't', includeAttachments: [], outputDirectory: join(root, 'out') }, { signal: AbortSignal.abort() }), { name: 'AbortError' });
});
