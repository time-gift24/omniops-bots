/** Real CDP pages stand in for the native CEF page registry in runtime browser tests. */
export function browserHostFixture(context, endpoint) {
  const pages = new Map();
  const bindings = new Map();
  let selected = '__manual__';
  return {
    pages,
    get selected() { return selected; },
    async request(method, pageId) {
      if (method === 'create') {
        if (bindings.has(pageId)) return bindings.get(pageId);
        if (!pages.has(pageId)) pages.set(pageId, await context.newPage());
        const session = await context.newCDPSession(pages.get(pageId));
        try {
          const { targetInfo } = await session.send('Target.getTargetInfo');
          const binding = { endpoint, targetId: targetInfo.targetId };
          bindings.set(pageId, binding);
          return binding;
        } finally { await session.detach(); }
      }
      if (method === 'select') {
        if (pageId !== '__manual__' && !pages.has(pageId)) throw new Error('Unknown browser page');
        selected = pageId;
        return { selected: true };
      }
      if (method === 'release') {
        await pages.get(pageId)?.close();
        pages.delete(pageId);
        bindings.delete(pageId);
        return { released: true };
      }
      throw new Error('Unknown host request');
    },
  };
}
