/**
 * One in-memory slot with `useSyncExternalStore` plumbing: an unfinished gesture that a second
 * offer replaces, never queues, and a reload rightly drops.
 */
export function createPendingSlot<T>(): {
  readonly offer: (value: T) => void;
  readonly clear: () => void;
  readonly get: () => T | null;
  readonly subscribe: (listener: () => void) => () => void;
} {
  let pending: T | null = null;
  const listeners = new Set<() => void>();
  const changed = (): void => {
    for (const listener of listeners) listener();
  };

  return {
    offer: (value) => {
      pending = value;
      changed();
    },
    clear: () => {
      if (pending !== null) {
        pending = null;
        changed();
      }
    },
    get: () => pending,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
