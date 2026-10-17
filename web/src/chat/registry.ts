import type { ChatGateway } from "./gateway.ts";
import type { ThreadId } from "./dto.ts";
import { ThreadStoreImpl, type ThreadSnapshot, type ThreadStore } from "./thread-store.ts";

export interface ThreadStoreRegistry {
  /** 命中缓存或懒创建，引用计数 +1。 */
  acquire(threadId: ThreadId): ThreadStore;
  /** 引用计数 -1，归零后进入可驱逐状态；不中止流。 */
  release(threadId: ThreadId): void;
  snapshot(threadId: ThreadId): ThreadSnapshot | undefined;
  /** LRU 驱逐空闲线程；跳过有订阅者和流式中的线程。 */
  evictIdle(maxIdle?: number): void;
}

interface Entry {
  store: ThreadStoreImpl;
  refs: number;
  lastUsed: number;
}

export function createThreadStoreRegistry(
  gatewayFor: (threadId: ThreadId) => ChatGateway,
): ThreadStoreRegistry {
  const entries = new Map<ThreadId, Entry>();

  const touch = (entry: Entry) => {
    entry.lastUsed = Date.now();
  };

  return {
    acquire(threadId) {
      let entry = entries.get(threadId);
      if (!entry) {
        entry = {
          store: new ThreadStoreImpl(threadId, gatewayFor(threadId)),
          refs: 0,
          lastUsed: Date.now(),
        };
        entries.set(threadId, entry);
      }
      entry.refs += 1;
      touch(entry);
      return entry.store;
    },

    release(threadId) {
      const entry = entries.get(threadId);
      if (!entry) return;
      entry.refs = Math.max(0, entry.refs - 1);
      touch(entry);
    },

    snapshot(threadId) {
      return entries.get(threadId)?.store.snapshot();
    },

    evictIdle(maxIdle = 0) {
      const idle = [...entries.entries()]
        .filter(
          ([, entry]) =>
            entry.refs === 0 &&
            entry.store.listenerCount === 0 &&
            !entry.store.streaming,
        )
        .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
      const excess = idle.length - maxIdle;
      for (let i = 0; i < excess; i += 1) {
        entries.delete(idle[i][0]);
      }
    },
  };
}
