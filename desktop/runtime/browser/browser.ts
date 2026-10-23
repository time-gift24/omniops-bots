import { browserTargetConfig, connectBrowserTarget, selectBrowserTarget } from './browser-target.ts';
import type { BrowserTarget } from './browser-target.ts';
import type { Browser, BrowserContext, CDPSession, Page } from 'playwright-core';
import { httpUrl } from '../input.ts';
import { RuntimeError } from '../errors.ts';

export type BrowserState = { url: string; title: string; status: 'empty' | 'ready' | 'loading' | 'error'; canGoBack: boolean; canGoForward: boolean; error?: string };
type ConnectedPage = BrowserTarget & { browser: Browser; context: BrowserContext; page: Page; session: CDPSession };
type BrowserHost = { request(method: string, pageId: string): Promise<unknown>; close(): Promise<void> };
export const emptyBrowser = (): BrowserState => ({ url: '', title: '浏览器未打开', status: 'empty', canGoBack: false, canGoForward: false });

/** Each connection keeps its original target even when the UI selects another page. */
function createPageService(getConfig: () => BrowserTarget | Promise<BrowserTarget>, name = 'Chrome', initialState = emptyBrowser()) {
  let connection: Promise<ConnectedPage> | undefined, current: Browser | undefined, page: Page | undefined, session: CDPSession | undefined, revision = 0;
  let state = initialState;
  let publish: (state: BrowserState) => void = () => {};
  const update = (patch: Partial<BrowserState>) => { state = { ...state, ...patch }; publish(state); };

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
    if (page?.isClosed()) {
      const stale = current;
      connection = current = page = session = undefined;
      revision++;
      await stale?.close().catch(() => {});
    }
    if (!connection) {
      connection = Promise.resolve().then(getConfig).then(async config => {
        const browser = await connectBrowserTarget(config.endpoint, config.targetId);
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
          return { browser, ...selected, session, endpoint: config.endpoint, targetId: config.targetId };
        } catch (error) { await browser.close().catch(() => {}); throw error; }
      }).catch(error => {
        connection = undefined;
        if (error instanceof RuntimeError) throw error;
        throw Object.assign(new RuntimeError('unavailable', `${name} 尚未就绪或目标页面已关闭，请重试。`), { cause: error });
      });
    }
    const result = await connection;
    if (result.page.isClosed()) throw new RuntimeError('unavailable', `${name} 页面已关闭，请重试。`);
    return result;
  }

  async function withCancellation<T>(signal: AbortSignal | undefined, operation: (target: ConnectedPage) => Promise<T>): Promise<T> {
    signal?.throwIfAborted();
    const target = await ensure();
    let cancellation: Promise<unknown> | undefined;
    let stoppedUrl: string | undefined;
    const abort = () => {
      stoppedUrl = target.page.url();
      cancellation = Promise.race([target.session.send('Page.stopLoading').catch(() => {}), new Promise(resolve => setTimeout(resolve, 250))])
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

  async function navigation(method: string, url?: unknown) {
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

  async function assertAutomationReady() {
    const target = await ensure();
    const needsHuman = await target.page.locator('input[type="password"], iframe[src*="recaptcha"], iframe[src*="hcaptcha"], [data-sitekey]').evaluateAll(nodes => nodes.some(node => node.getClientRects().length > 0));
    if (needsHuman) throw new RuntimeError('human-required', '页面需要人工登录或验证。请在专用浏览器中完成后发起新任务；本轮不会自动恢复。');
  }

  return {
    assertAutomationReady,
    getState: () => state,
    subscribe(listener: (state: BrowserState) => void) { publish = listener; },
    ensure,
    refresh,
    navigation,
    async inspect({ url }: { url?: string }, signal: AbortSignal) {
      const targetUrl = url === undefined ? undefined : httpUrl(url);
      return withCancellation(signal, async target => {
        if (targetUrl) await target.page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 });
        signal.throwIfAborted();
        await assertAutomationReady();
        const interactive = await target.page.locator('input,textarea,button,select,a[href]').evaluateAll(nodes => nodes.filter(node => node.getClientRects().length).slice(0, 60).map(node => ({
          tag: node.tagName.toLowerCase(), id: node.id, name: node.getAttribute('name'), type: node.getAttribute('type'),
          placeholder: node.getAttribute('placeholder'), ariaLabel: node.getAttribute('aria-label'), text: node.textContent?.trim().slice(0, 100),
        })));
        return { title: await target.page.title(), url: target.page.url(), accessibility: (await target.page.locator('body').ariaSnapshot({ timeout: 5000 })).slice(0, 12000), interactive };
      });
    },
    async stop() {
      if (session) await session.send('Page.stopLoading').catch(() => {});
    },
    async close() { await (await connection?.catch(() => undefined))?.browser.close().catch(() => {}); },
  };
}

/** Manual operations use only the native host's fixed page, never an Agent's Chrome page. */
export function createOperationsBrowser(config?: unknown) {
  let validated: BrowserTarget | undefined;
  try { validated = browserTargetConfig(config ?? {}); } catch { /* An unavailable manual host must not prevent Agent chat. */ }
  const configured = Boolean(validated);
  const message = '运维浏览器尚未就绪，请在桌面端打开运维浏览器。';
  const service = createPageService(() => {
    if (!validated) throw new RuntimeError('unavailable', message);
    return validated;
  }, '运维浏览器', configured ? emptyBrowser() : { ...emptyBrowser(), status: 'error', error: message });
  const { getState, subscribe, navigation, close } = service;
  return { getState, subscribe, navigation, close, async refresh() {
    if (configured) { await service.ensure(); await service.refresh(); }
  } };
}

/** A thread owns a page; changing the visible page never changes a run's binding. */
export function createBrowserService(host: BrowserHost) {
  const pages = new Map<string, ReturnType<typeof createPageService>>();
  const manual = createPageService(async () => browserTargetConfig(await host.request('create', '__manual__')));
  let selected: string | null = null, publish: (state: BrowserState) => void = () => {}, selecting = Promise.resolve(), closed = false, closePromise: Promise<void> | undefined;
  manual.subscribe(state => { if (selected === null) publish(state); });

  function forThread(threadId: string | null): ReturnType<typeof createPageService> {
    if (closed) throw new RuntimeError('unavailable', '浏览器已关闭。');
    if (threadId === null) return manual;
    if (threadId === '__manual__') throw new RuntimeError('invalid-request', '会话编号为浏览器保留编号。');
    const existing = pages.get(threadId);
    if (existing) return existing;
    let attempted = false;
    const service = createPageService(async () => {
      attempted = true;
      return browserTargetConfig(await host.request('create', threadId));
    });
    service.subscribe(state => { if (selected === threadId) publish(state); });
    const page = {
      ...service,
      async close() {
        if (!attempted) return;
        try { await service.close(); }
        finally { await host.request('release', threadId); }
      },
    };
    pages.set(threadId, page);
    return page;
  }

  const current = () => selected === null ? manual : forThread(selected);
  return {
    forThread,
    getState: () => current().getState(),
    getThreadId: () => selected,
    subscribe(listener: (state: BrowserState) => void) { publish = listener; },
    ensure: () => current().ensure(),
    inspect: (input: { url?: string }, signal: AbortSignal) => current().inspect(input, signal),
    assertAutomationReady: () => current().assertAutomationReady(),
    refresh: () => current().refresh(),
    async select(threadId: string | null, { focus = false } = {}) {
      if (closed) throw new RuntimeError('unavailable', '浏览器已关闭。');
      const work = selecting.catch(() => {}).then(async () => {
        const page = forThread(threadId);
        if (focus) {
          await page.ensure();
          await host.request('select', threadId ?? '__manual__');
        }
        selected = threadId;
        await page.refresh();
        publish(page.getState());
      });
      selecting = work;
      return work;
    },
    navigation: (method: string, url?: unknown) => current().navigation(method, url),
    close() {
      if (closePromise) return closePromise;
      closed = true;
      closePromise = (async () => {
        await selecting.catch(() => {});
        const errors = [];
        for (const page of pages.values()) {
          try { await page.close(); } catch (error) { errors.push(error); }
        }
        await manual.close();
        await host.close();
        if (errors.length) throw errors[0];
      })();
      return closePromise;
    },
  };
}
