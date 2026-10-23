import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createChromeHost } from '../browser/chrome-host.ts';
import { createBrowserService, createOperationsBrowser } from '../browser/browser.ts';
import { safeError } from '../errors.ts';

test('invalid manual CDP configuration remains safely unavailable without affecting Agent Chrome', async () => {
  for (const config of [undefined, { endpoint: 'http://127.0.0.1:1' }, { targetId: 'manual' },
    { endpoint: 'https://remote.example.test', targetId: 'manual' },
    { endpoint: 'http://user:private-secret@127.0.0.1:1', targetId: 'manual' },
    ...['', 'a\u0000b', 'a\nb', 'a\u007fb', 'a\u0085b', 'a'.repeat(257)].map(targetId => ({ endpoint: 'http://127.0.0.1:1', targetId })),
  ]) {
    const browser = createOperationsBrowser(config);
    assert.equal(browser.getState().status, 'error');
    await browser.refresh();
    await assert.rejects(browser.navigation('navigate', 'https://example.test'), error => {
      assert.equal(safeError(error).kind, 'unavailable');
      assert.doesNotMatch(JSON.stringify(safeError(error)), /private-secret|remote\.example/);
      return true;
    });
    await browser.close();
  }
});

test('ordinary thread selection publishes state without launching Chrome or taking focus', async () => {
  const calls = [], states = [];
  const browser = createBrowserService({ async request(...args) { calls.push(args); }, async close() {} });
  browser.subscribe(state => states.push(state));
  await browser.select('first');
  await browser.select('second');
  await browser.select(null);
  assert.deepEqual(calls, []);
  assert.equal(states.length, 3);
  assert.equal(browser.getThreadId(), null);
  await browser.close();
  assert.deepEqual(calls, []);
});

test('Chrome starts lazily, shares an in-flight launch, safely reports failure and retries explicitly', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omniops-chrome-failure-'));
  let launches = 0;
  const host = createChromeHost({ directory, async launch(profile, options) {
    launches++;
    assert.equal(profile, directory);
    assert.equal(options.channel, 'chrome');
    assert.equal(options.headless, false);
    assert.equal(options.chromiumSandbox, true);
    throw new Error('Chrome missing at /private/user-secret');
  } });
  try {
    assert.equal(launches, 0);
    const failures = await Promise.allSettled([host.request('create', 'one'), host.request('create', 'two')]);
    assert.equal(launches, 1);
    for (const failure of failures) {
      assert.equal(failure.status, 'rejected');
      assert.equal(safeError(failure.reason).kind, 'unavailable');
      assert.match(safeError(failure.reason).message, /Google Chrome/);
      assert.doesNotMatch(JSON.stringify(safeError(failure.reason)), /user-secret/);
    }
    await assert.rejects(host.request('create', 'one'), /Google Chrome/);
    assert.equal(launches, 2);
    await host.close();
    await assert.rejects(host.request('create', 'one'), /已关闭/);
    assert.equal(launches, 2);
  } finally { await host.close(); await rm(directory, { recursive: true, force: true }); }
});
