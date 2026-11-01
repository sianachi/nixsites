import { Text } from '@nix/ui';
import type { ReactNode } from 'react';

import { OfflineConflicts } from './offline-conflicts';
import { useOfflineState } from './offline-state';

/**
 * A small notice that the screen shows the synced copy, and a count of offline changes the server
 * refused. Nothing renders while connected with nothing to report.
 */
export function OfflineBanner(): ReactNode {
  const { bootOffline, networkDown } = useOfflineState();
  return (
    <div className="fixed top-[max(var(--spacing)*2,env(safe-area-inset-top))] left-1/2 z-50 flex -translate-x-1/2 flex-col items-center gap-1">
      {bootOffline || networkDown ? (
        <aside
          role="status"
          aria-label="Offline"
          className="pointer-events-none rounded-lg border border-divider bg-background px-3 py-1"
        >
          <Text variant="note" as="p" tone="muted">
            Offline — showing your synced copy
          </Text>
        </aside>
      ) : null}
      <OfflineConflicts />
    </div>
  );
}
