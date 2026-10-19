export function embeddedBrowserConfig(env) {
  const endpoint = env.OMNIOPS_BOTS_BROWSER_CDP_ENDPOINT;
  const targetId = env.OMNIOPS_BOTS_BROWSER_TARGET_ID;
  if (!endpoint || !targetId) throw new Error('OMNIOPS_BOTS_BROWSER_CDP_ENDPOINT and OMNIOPS_BOTS_BROWSER_TARGET_ID must be provided together');
  const url = new URL(endpoint);
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]'
    || /^127\.\d+\.\d+\.\d+$/.test(url.hostname);
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) || !loopback || url.username || url.password) {
    throw new Error('Embedded browser CDP endpoint must be a loopback HTTP(S) or WS(S) URL without credentials');
  }
  if (typeof targetId !== 'string' || !targetId.trim() || targetId !== targetId.trim() || targetId.length > 256) {
    throw new Error('Embedded browser target ID is invalid');
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
  if (matches.length !== 1) throw new Error(`Embedded browser target ${targetId} is unavailable; refusing to select another page`);
  return matches[0];
}
