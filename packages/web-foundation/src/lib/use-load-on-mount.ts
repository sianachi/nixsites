import { useEffect } from 'react';

/**
 * Runs `load` when it first exists or changes, handing it a signal that aborts on unmount or when
 * `load` changes. It starts in a microtask so the first setState lands after the effect returns
 * rather than during it, the same cascade-stopper `use-workspace-tree.ts` documents.
 */
export function useLoadOnMount(load: (signal: AbortSignal) => Promise<void>): void {
  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => {
      void load(controller.signal);
    });
    return () => {
      controller.abort();
    };
  }, [load]);
}
