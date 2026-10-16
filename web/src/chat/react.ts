/**
 * React 绑定：组件经 useThreadStore 获取线程 store，useThreadState 订阅状态。
 * 本轮单线程界面固定一个 threadId；将来加切换 UI 时状态层不变。
 */

import * as React from "react";

import { getChatGateway } from "./binding.ts";
import type { ThreadId } from "./dto.ts";
import type { ThreadViewState } from "./fold.ts";
import { createThreadStoreRegistry, type ThreadStoreRegistry } from "./registry.ts";
import type { ThreadStore } from "./thread-store.ts";

/** 默认注册表：进程级单例，store 生命周期独立于组件。 */
export const defaultThreadRegistry: ThreadStoreRegistry =
  createThreadStoreRegistry(() => getChatGateway());

/**
 * mount 时 acquire、unmount 时 release。
 * 驱逐判断同时看引用计数与订阅者数，React StrictMode 双挂载不会导致使用中的 store 被驱逐。
 */
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
