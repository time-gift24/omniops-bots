import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import type { BrowserContext, Page } from 'playwright-core';
import { RuntimeError } from '../errors.ts';

/** Own only the Chrome instance and profile launched for this application. */
export function createChromeHost({ directory, launch = (profile, options) => chromium.launchPersistentContext(profile, options) }: {
  directory: string; launch?: (profile: string, options: Parameters<typeof chromium.launchPersistentContext>[1]) => Promise<BrowserContext>;
}) {
  const pages = new Map<string, Promise<Page>>();
  let pending: Promise<{ context: BrowserContext; endpoint: string }> | undefined, closed = false;

  function ensure() {
    if (closed) throw new RuntimeError('unavailable', '浏览器已关闭。');
    return pending ??= (async () => {
      let context: BrowserContext | undefined;
      try {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        context = await launch(directory, {
          channel: 'chrome', headless: false, chromiumSandbox: true, viewport: null, timeout: 20_000,
          args: ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1'],
        });
        const [port, path] = (await readFile(join(directory, 'DevToolsActivePort'), 'utf8')).trim().split('\n');
        if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535 || !/^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(path)) {
          throw new Error('Invalid Chrome debugging endpoint');
        }
        context.on('close', () => { pending = undefined; pages.clear(); });
        const manual = context.pages()[0];
        if (manual) pages.set('__manual__', Promise.resolve(manual));
        return { context, endpoint: `ws://127.0.0.1:${port}${path}` };
      } catch (cause) {
        await context?.close().catch(() => {});
        pending = undefined;
        throw Object.assign(new RuntimeError('unavailable', '无法启动 Google Chrome。请确认已安装 Chrome、未有其他应用实例使用专用浏览器，并重试。'), { cause });
      }
    })();
  }

  return {
    async request(method: string, pageId: string) {
      if (!['create', 'select', 'release'].includes(method)) throw new RuntimeError('invalid-request', '不支持此浏览器操作。');
      if (method === 'release') {
        const pendingPage = pages.get(pageId);
        pages.delete(pageId);
        const page = await pendingPage?.catch(() => undefined);
        await page?.close().catch(() => {});
        return { released: true };
      }
      const { context, endpoint } = await ensure();
      if (closed) throw new RuntimeError('unavailable', '浏览器已关闭。');
      let pendingPage = pages.get(pageId);
      if (pendingPage && (await pendingPage).isClosed()) {
        if (pages.get(pageId) === pendingPage) pages.delete(pageId);
        pendingPage = pages.get(pageId);
      }
      if (!pendingPage) {
        pendingPage = context.newPage().catch(error => {
          if (pages.get(pageId) === pendingPage) pages.delete(pageId);
          throw error;
        });
        pages.set(pageId, pendingPage);
      }
      const page = await pendingPage;
      if (method === 'select') { await page.bringToFront(); return { selected: true }; }
      const session = await context.newCDPSession(page);
      try {
        const { targetInfo } = await session.send('Target.getTargetInfo');
        return { endpoint, targetId: targetInfo.targetId };
      } finally { await session.detach(); }
    },
    async close() {
      closed = true;
      const host = await pending?.catch(() => undefined);
      await host?.context.close();
      pages.clear();
    },
  };
}
