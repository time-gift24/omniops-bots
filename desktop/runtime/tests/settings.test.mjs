import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { createClientSettings } from '../settings.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'omniops-settings-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { file: join(directory, 'settings.json') };
}

test('settings default to four, validate exact integers and persist ahead of the environment fallback', async t => {
  const { file } = await fixture(t);
  const settings = await createClientSettings({ file });
  assert.deepEqual(await settings.read(), { maxConcurrentRuns: 4 });
  await assert.rejects(readFile(file), { code: 'ENOENT' });
  for (const value of [0, 65, -1, 1.5, '8', NaN, null, undefined]) {
    await assert.rejects(settings.save({ maxConcurrentRuns: value }), error => error.kind === 'invalid-request');
  }
  await assert.rejects(settings.save({ maxConcurrentRuns: 8, ignored: true }), error => error.kind === 'invalid-request');
  assert.deepEqual(await settings.save({ maxConcurrentRuns: 8 }), { maxConcurrentRuns: 8 });
  await settings.close();
  const reopened = await createClientSettings({ file, defaultMaxConcurrentRuns: NaN });
  assert.deepEqual(await reopened.read(), { maxConcurrentRuns: 8 });
  await reopened.save({ maxConcurrentRuns: 1 });
  await reopened.save({ maxConcurrentRuns: 64 });
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { maxConcurrentRuns: 64 });
});

test('read and save failures stay explicit and preserve the last confirmed admission value', async t => {
  const { file } = await fixture(t);
  const settings = await createClientSettings({ file, defaultMaxConcurrentRuns: 3 });
  await settings.save({ maxConcurrentRuns: 6 });
  await rename(file, `${file}.backup`);
  await mkdir(file);
  await assert.rejects(settings.save({ maxConcurrentRuns: 8 }), error => error.kind === 'storage');
  assert.deepEqual(settings.current(), { maxConcurrentRuns: 6 });
  await assert.rejects(settings.read(), error => error.kind === 'storage');
  assert.deepEqual(settings.current(), { maxConcurrentRuns: 6 });
  await rm(file, { recursive: true });
  await rename(`${file}.backup`, file);
  assert.deepEqual(await settings.read(), { maxConcurrentRuns: 6 });
  await writeFile(file, '{broken');
  const reopened = await createClientSettings({ file });
  assert.throws(() => reopened.current(), error => error.kind === 'storage');
  await assert.rejects(reopened.read(), error => error.kind === 'storage');
  await writeFile(file, JSON.stringify({ maxConcurrentRuns: 2 }));
  assert.deepEqual(await reopened.read(), { maxConcurrentRuns: 2 });
});

test('concurrent settings writes and reads keep call order without sharing mutable inputs', async t => {
  const { file } = await fixture(t);
  const settings = await createClientSettings({ file });
  const input = { maxConcurrentRuns: 5 };
  const first = settings.save(input);
  input.maxConcurrentRuns = 9;
  const read = settings.read();
  const last = settings.save({ maxConcurrentRuns: 7 });
  assert.deepEqual(await first, { maxConcurrentRuns: 5 });
  assert.deepEqual(await read, { maxConcurrentRuns: 5 });
  assert.deepEqual(await last, { maxConcurrentRuns: 7 });
  await settings.close();
  assert.deepEqual(settings.current(), { maxConcurrentRuns: 7 });
});
