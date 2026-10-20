import { chromium } from 'playwright-core';

export function browserTargetConfig({ endpoint, targetId }) {
  if (!endpoint || !targetId) throw new Error('Browser endpoint and target ID must be provided together');
  const url = new URL(endpoint);
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]'
    || /^127\.\d+\.\d+\.\d+$/.test(url.hostname);
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) || !loopback || url.username || url.password) {
    throw new Error('Browser CDP endpoint must be a loopback HTTP(S) or WS(S) URL without credentials');
  }
  if (typeof targetId !== 'string' || !targetId.trim() || targetId !== targetId.trim() || targetId.length > 256 || /\p{Cc}/u.test(targetId)) {
    throw new Error('Browser target ID is invalid');
  }
  return { endpoint: url.href, targetId };
}

export async function selectBrowserTarget(browser, targetId) {
  const matches = [];
  for (const context of browser.contexts()) {
    for (const page of context.pages()) {
      if (page.isClosed()) continue;
      let session;
      try {
        session = await context.newCDPSession(page);
        const { targetInfo } = await session.send('Target.getTargetInfo');
        if (targetInfo.targetId === targetId) matches.push({ context, page });
      } catch (error) {
        if (!page.isClosed()) throw error;
      } finally { await session?.detach().catch(() => {}); }
    }
  }
  if (matches.length !== 1) throw new Error(`Browser target ${targetId} is unavailable; refusing to select another page`);
  return matches[0];
}
/** Attach only this target: Playwright's default browser-wide attachment can wait on an unrelated stalled page. */
export async function connectBrowserTarget(endpoint, targetId, options = {}) {
  ({ endpoint, targetId } = browserTargetConfig({ endpoint, targetId }));
  const signal = AbortSignal.timeout(5000);
  let url = new URL(endpoint);
  if (url.protocol === 'http:' || url.protocol === 'https:') {
    const response = await fetch(new URL('/json/version', url), { signal });
    if (!response.ok) throw new Error('Browser CDP endpoint is unavailable');
    url = new URL((await response.json()).webSocketDebuggerUrl);
  }
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    const abort = () => { socket.close(); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    socket.addEventListener('open', () => { signal.removeEventListener('abort', abort); resolve(); }, { once: true });
    socket.addEventListener('error', () => { signal.removeEventListener('abort', abort); reject(new Error('Browser CDP connection failed')); }, { once: true });
  });
  const transport = {
    send(message) {
      // Explicit attachment emits attachedToTarget before its reply, preserving Playwright's initialization barrier.
      if (!message.sessionId && message.method === 'Target.setAutoAttach' && message.params.autoAttach) {
        socket.send(JSON.stringify({ id: message.id, method: 'Target.attachToTarget', params: { targetId, flatten: true } }));
        return;
      }
      if (['Target.createTarget', 'Target.createBrowserContext', 'Target.disposeBrowserContext', 'Browser.close'].includes(message.method) ||
          (['Target.attachToTarget', 'Target.closeTarget', 'Target.activateTarget'].includes(message.method) && message.params?.targetId !== targetId)) {
        queueMicrotask(() => transport.onmessage?.({ id: message.id, ...(message.sessionId ? { sessionId: message.sessionId } : {}),
          error: { code: -32000, message: 'This task can only use its assigned browser page' } }));
        return;
      }
      socket.send(JSON.stringify(message));
    },
    close() { socket.close(); },
  };
  socket.addEventListener('message', event => {
    try { transport.onmessage?.(JSON.parse(event.data)); }
    catch { socket.close(); }
  });
  socket.addEventListener('close', () => transport.onclose?.());
  socket.addEventListener('error', () => { socket.close(); });
  try { return await chromium.connectOverCDP(transport, { timeout: 5000, noDefaults: true, ...options }); }
  catch (error) { socket.close(); throw error; }
}
