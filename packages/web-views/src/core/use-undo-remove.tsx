import { Toast } from '@nix/ui';
import { useState, type ReactNode } from 'react';

export function insertAt<T>(list: readonly T[], index: number, item: T): T[] {
  return [...list.slice(0, index), item, ...list.slice(index)];
}

/** Undo for the latest removal only: `undo` rebuilds from the current state, so later edits survive. */
export function useUndoRemove<S>(
  current: S,
  set: (next: S) => void,
): { track: (label: string, undo: (state: S) => S) => void; notice: ReactNode } {
  const [pending, setPending] = useState<{
    label: string;
    undo: (state: S) => S;
    key: number;
  } | null>(null);
  return {
    // A fresh key remounts the Toast so a new removal restarts its timer and focus.
    track: (label, undo) => {
      setPending((last) => ({ label, undo, key: (last?.key ?? 0) + 1 }));
    },
    notice:
      pending === null ? null : (
        <Toast
          key={pending.key}
          message={`Removed ${pending.label}`}
          action={{
            label: 'Undo',
            onAction: () => {
              set(pending.undo(current));
            },
          }}
          onDismiss={() => {
            setPending(null);
          }}
        />
      ),
  };
}
