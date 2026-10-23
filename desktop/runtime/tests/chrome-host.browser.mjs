import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createChromeHost } from '../browser/chrome-host.ts';
import { createBrowserService } from '../browser/browser.ts';

test('visible external Chrome pins each thread, reopens closed tabs, persists login and closes with the host', { timeout: 45_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omniops-chrome-'));
  let host = createChromeHost({ directory });
  let service = createBrowserService(host);
  try {
    const first = await service.forThread('first').ensure();
    const second = await service.forThread('second').ensure();
    const duplicates = await Promise.all([host.request('create', 'parallel'), host.request('create', 'parallel')]);
    assert.equal(duplicates[0].targetId, duplicates[1].targetId, 'concurrent requests allocate one thread page');
    assert.notEqual(first.targetId, second.targetId);
    await first.page.setContent('<title>First task</title>');
    await second.page.setContent('<title>Second task</title>');
    await service.select('second', { focus: true });
    await service.select('first', { focus: true });
    await service.select('first', { focus: true });
    assert.equal(await first.page.evaluate(() => document.visibilityState), 'visible');
    assert.equal((await service.forThread('first').ensure()).targetId, first.targetId);
    assert.equal(await first.page.title(), 'First task');
    assert.equal(await second.page.title(), 'Second task');
    assert.equal(first.context.pages().length, 1, 'task connection attaches only its assigned target');
    await assert.rejects(first.session.send('Target.closeTarget', { targetId: second.targetId }), /assigned browser page/);
    await first.context.addCookies([{ name: 'login', value: 'saved', url: 'https://example.test', expires: Math.floor(Date.now() / 1000) + 3600 }]);
    assert.equal((await second.context.cookies('https://example.test'))[0].value, 'saved');
    await first.page.close();
    const [replacement, repeated] = await Promise.all([service.forThread('first').ensure(), service.forThread('first').ensure()]);
    assert.equal(replacement, repeated, 'concurrent retries share one CDP connection');
    assert.notEqual(replacement.targetId, first.targetId);
    assert.equal((await service.forThread('second').ensure()).targetId, second.targetId);
    await service.close();
    assert.equal(second.browser.isConnected(), false);
    await service.close();
    host = createChromeHost({ directory });
    service = createBrowserService(host);
    const restored = await service.forThread('first').ensure();
    assert.equal((await restored.context.cookies('https://example.test'))[0].value, 'saved');
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});
