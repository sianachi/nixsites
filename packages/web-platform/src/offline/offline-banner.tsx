import { Button, Text } from '@nix/ui';
import { useEffect, useState, type ReactNode } from 'react';

import { getNativeMirror } from './native-mirror';
import { OfflineConflicts } from './offline-conflicts';
import { coalesced, setOfflineState, useOfflineState } from './offline-state';

/**
 * A small notice that the screen shows the synced copy, how many changes are still waiting to be
 * sent, what the last sync could not do (with a retry), and a count of offline changes the server
 * refused. Nothing renders while connected with
 * nothing to report.
 */
/** How many changes made on this device the server has not taken yet; 0 outside the shell. */
function useUnsentCount(): number {
  const mirror = getNativeMirror();
  const { lastSyncedAt, bootOffline } = useOfflineState();
  const [count, setCount] = useState(0);
  useEffect(() => {
    const store = mirror?.current();
    if (store === null || store === undefined) return;
    const refresh = (): void => {
      void store.countUnsent().then(setCount, () => undefined);
    };
    refresh();
    return store.subscribe(coalesced(refresh));
  }, [mirror, lastSyncedAt, bootOffline]);
  return count;
}

export function OfflineBanner(): ReactNode {
  const { bootOffline, networkDown, syncProblem } = useOfflineState();
  const unsent = useUnsentCount();
  const waiting =
    unsent === 0
      ? null
      : unsent === 1
        ? '1 change waiting to sync'
        : `${String(unsent)} changes waiting to sync`;
  return (
    <div className="fixed top-[max(var(--spacing)*2,env(safe-area-inset-top))] left-1/2 z-50 flex -translate-x-1/2 flex-col items-center gap-1">
      {bootOffline || networkDown ? (
        <aside
          role="status"
          aria-label="Offline"
          className="pointer-events-none rounded-lg border border-divider bg-background px-3 py-1"
        >
          <Text variant="note" as="p" tone="muted">
            Offline — showing your synced copy{waiting === null ? '' : `. ${waiting}`}
          </Text>
        </aside>
      ) : waiting === null ? null : (
        <aside
          role="status"
          aria-label="Waiting to sync"
          className="pointer-events-none rounded-lg border border-divider bg-background px-3 py-1"
        >
          <Text variant="note" as="p" tone="muted">
            {waiting}
          </Text>
        </aside>
      )}
      {syncProblem === null ? null : (
        <aside
          role="alert"
          aria-label="Sync problem"
          className="flex max-w-[90vw] items-center gap-2 rounded-lg border border-divider bg-background py-1 pr-1 pl-3"
        >
          <Text variant="note" as="p">
            {syncProblem}
          </Text>
          <Button
            variant="secondary"
            onClick={() => {
              setOfflineState({ resyncRequestedAt: Date.now() });
            }}
          >
            Retry
          </Button>
        </aside>
      )}
      <OfflineConflicts />
    </div>
  );
}
