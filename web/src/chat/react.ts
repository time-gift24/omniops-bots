import * as React from "react";

import { getChatGateway } from "./binding.ts";
import type { ThreadId } from "./dto.ts";
import type { ThreadViewState } from "./fold.ts";
import { createThreadStoreRegistry, type ThreadStoreRegistry } from "./registry.ts";
import type { ThreadStore } from "./thread-store.ts";

/** store 生命周期独立于组件。 */
export const defaultThreadRegistry: ThreadStoreRegistry =
  createThreadStoreRegistry(() => getChatGateway());

/** 卸载只释放引用，不中止流。 */
export function useThreadStore(
  threadId: ThreadId,
  registry: ThreadStoreRegistry = defaultThreadRegistry,
): ThreadStore {
  const store = React.useMemo(() => registry.acquire(threadId), [registry, threadId]);
  React.useEffect(() => {
    return () => registry.release(threadId);
  }, [registry, threadId, store]);
  return store;
}

export function useThreadState(store: ThreadStore): ThreadViewState {
  return React.useSyncExternalStore(store.subscribe, store.getState);
}
