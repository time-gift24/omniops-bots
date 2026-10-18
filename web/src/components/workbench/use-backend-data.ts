import { useEffect, useState } from "react";

export type BackendDataState<T> =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; data: T };

/**
 * 按 key 从 WorkbenchBackend 加载数据。
 * key 变化时重置为 loading 并重新加载；卸载后到达的结果被丢弃。
 */
export function useBackendData<T>(
  key: unknown,
  load: () => Promise<T>,
): BackendDataState<T> {
  type KeyedState = BackendDataState<T> & { key: unknown };
  const [state, setState] = useState<KeyedState>({ key, status: "loading" });
  // React 认可的派生重置：渲染期比较 key，避免在 effect 里同步 setState。
  if (state.key !== key) setState({ key, status: "loading" });
  useEffect(() => {
    let live = true;
    load().then(
      (data) => {
        if (live) setState({ key, status: "ready", data });
      },
      () => {
        if (live) setState({ key, status: "error" });
      },
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load 由 key 标识，调用方保证 key 覆盖 load 依赖的输入。
  }, [key]);
  return state;
}
