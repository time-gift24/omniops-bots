import { chromium } from 'playwright-core';
import { selectBrowserTarget } from './browser-target.mjs';
import { httpUrl } from './input.mjs';
import { RuntimeError } from './errors.mjs';

export const emptyBrowser = () => ({ url: '', title: '浏览器未打开', status: 'empty', canGoBack: false, canGoForward: false });

/** The host owns Chromium. This service only attaches to its one selected page. */
export function createBrowserService(config) {
  let connection, current, page, session, revision = 0;
  let state = emptyBrowser();
  let publish = () => {};
  const update = patch => { state = { ...state, ...patch }; publish(state); };

  async function refresh() {
    if (!page || page.isClosed() || !session) return;
    const version = ++revision;
    try {
      const [title, history] = await Promise.all([page.title(), session.send('Page.getNavigationHistory')]);
      if (version !== revision) return;
      const url = page.url() === 'about:blank' ? '' : page.url();
      update({ url, title: title || (url ? '浏览器' : '浏览器未打开'), canGoBack: history.currentIndex > 0, canGoForward: history.currentIndex < history.entries.length - 1 });
    } catch { /* Navigation can replace the document between title and history reads. */ }
  }

  async function ensure() {
    if (!connection) {
      connection = chromium.connectOverCDP(config.endpoint, { timeout: 5000, noDefaults: true }).then(async browser => {
        try {
          const selected = await selectBrowserTarget(browser, config.targetId);
          current = browser;
          page = selected.page;
          session = await selected.context.newCDPSession(page);
          page.setDefaultTimeout(10_000);
          browser.on('disconnected', () => {
            if (current !== browser) return;
            connection = current = page = session = undefined;
            revision++;
          });
          page.on('framenavigated', frame => { if (frame === page?.mainFrame()) void refresh(); });
          page.on('domcontentloaded', () => { update({ status: page?.url() === 'about:blank' ? 'empty' : 'ready', error: undefined }); void refresh(); });
          page.on('request', request => { if (request.isNavigationRequest() && request.frame() === page?.mainFrame()) update({ status: 'loading', error: undefined }); });
          page.on('requestfailed', request => { if (request.isNavigationRequest() && request.frame() === page?.mainFrame()) update({ status: 'error', error: '页面未能加载，请重试。' }); });
          await refresh();
          return { browser, ...selected, endpoint: config.endpoint, targetId: config.targetId };
        } catch (error) { await browser.close().catch(() => {}); throw error; }
      }).catch(() => { connection = undefined; throw new RuntimeError('unavailable', '内置浏览器尚未就绪或目标页面已关闭，请重新打开应用。'); });
    }
    const result = await connection;
    if (result.page.isClosed()) throw new RuntimeError('unavailable', '内置浏览器页面已关闭，请重新打开应用。');
    return result;
  }

  async function withCancellation(signal, operation) {
    signal?.throwIfAborted();
    const target = await ensure();
    let cancellation;
    let stoppedUrl;
    const abort = () => {
      stoppedUrl = target.page.url();
      cancellation = Promise.race([session?.send('Page.stopLoading').catch(() => {}), new Promise(resolve => setTimeout(resolve, 250))])
        .finally(() => target.browser.close().catch(() => {}));
    };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      signal?.throwIfAborted();
      return await operation(target);
    } finally {
      signal?.removeEventListener('abort', abort);
      await cancellation;
      if (cancellation) update({ url: stoppedUrl === 'about:blank' ? '' : stoppedUrl, status: stoppedUrl === 'about:blank' ? 'empty' : 'ready', error: undefined });
      await refresh();
    }
  }

  async function navigation(method, url) {
    const target = await ensure();
    update({ status: 'loading', error: undefined });
    try {
      if (method === 'navigate') await target.page.goto(httpUrl(url, { normalize: true }), { waitUntil: 'domcontentloaded', timeout: 15_000 });
      else if (method === 'back') await target.page.goBack({ waitUntil: 'domcontentloaded', timeout: 15_000 });
      else if (method === 'forward') await target.page.goForward({ waitUntil: 'domcontentloaded', timeout: 15_000 });
      else await target.page.reload({ waitUntil: 'domcontentloaded', timeout: 15_000 });
      update({ status: target.page.url() === 'about:blank' ? 'empty' : 'ready', error: undefined });
      await refresh();
    } catch (error) {
      update({ status: 'error', error: '页面未能加载，请检查网址后重试。' });
      if (error instanceof RuntimeError) throw error;
      throw new RuntimeError('transport', '页面未能加载，请检查网址后重试。');
    }
  }

  return {
    getState: () => state,
    subscribe(listener) { publish = listener; },
    ensure,
    refresh,
    navigation,
    async inspect({ url }, signal) {
      const targetUrl = url === undefined ? undefined : httpUrl(url);
      return withCancellation(signal, async target => {
        if (targetUrl) await target.page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 });
        signal.throwIfAborted();
        const interactive = await target.page.locator('input,textarea,button,select,a[href]').evaluateAll(nodes => nodes.filter(node => node.getClientRects().length).slice(0, 60).map(node => ({
          tag: node.tagName.toLowerCase(), id: node.id, name: node.getAttribute('name'), type: node.getAttribute('type'),
          placeholder: node.getAttribute('placeholder'), ariaLabel: node.getAttribute('aria-label'), text: node.textContent?.trim().slice(0, 100),
        })));
        return { title: await target.page.title(), url: target.page.url(), accessibility: (await target.page.locator('body').ariaSnapshot({ timeout: 5000 })).slice(0, 12000), interactive };
      });
    },
    async close() { await (await connection?.catch(() => undefined))?.browser.close().catch(() => {}); },
  };
}
