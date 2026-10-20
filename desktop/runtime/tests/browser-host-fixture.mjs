/** An externally owned CDP browser exercises page binding without launching a visible Chrome. */
export function browserHostFixture(context, endpoint) {
  const pages = new Map([['__manual__', context.pages()[0]]].filter(([, page]) => page));
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
        if (!pages.has(pageId)) await this.request('create', pageId);
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
    async close() {
      await Promise.all([...pages.values()].map(page => page.close()));
      pages.clear(); bindings.clear();
    },
  };
}
