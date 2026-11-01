import { Text } from '@nix/ui';
import type { ReactNode } from 'react';

import { useOfflineState } from './offline-state';

/** A small notice that the screen shows the synced copy. Nothing renders while connected. */
export function OfflineBanner(): ReactNode {
  const { bootOffline, networkDown } = useOfflineState();
  if (!bootOffline && !networkDown) return null;
  return (
    <aside
      role="status"
      aria-label="Offline"
      className="pointer-events-none fixed top-[max(0.5rem,env(safe-area-inset-top))] left-1/2 z-50 -translate-x-1/2 rounded-lg border border-divider bg-background px-3 py-1"
    >
      <Text variant="note" as="p" tone="muted">
        Offline — showing your synced copy
      </Text>
    </aside>
  );
}
