import { Text, cn } from '@nix/ui';
import { useState, type ReactNode } from 'react';
import {
  TAB_DOCK_LABELS,
  carriesTabTransfer,
  readTabTransfer,
  type TabDockEdge,
  type TabTransferPayload,
} from './tab-transfer';

const zones = [
  { edge: 'top', position: 'col-span-3 col-start-1 row-start-1' },
  { edge: 'bottom', position: 'col-span-3 col-start-1 row-start-3' },
  { edge: 'left', position: 'col-start-1 row-start-2' },
  { edge: 'right', position: 'col-start-3 row-start-2' },
] as const;

export function TabDockTargets({
  draggedTab,
  onDock,
}: {
  readonly draggedTab: TabTransferPayload;
  readonly onDock: (edge: TabDockEdge) => void;
}): ReactNode {
  const [active, setActive] = useState<TabDockEdge | null>(null);
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-40 grid grid-cols-3 grid-rows-3 gap-2 p-2"
    >
      {zones.map(({ edge, position }) => (
        <div
          key={edge}
          data-dock-edge={edge}
          className={cn(
            'pointer-events-auto flex items-center justify-center rounded-md border border-accent',
            active === edge ? 'bg-accent/35' : 'bg-surface/90',
            position,
          )}
          onDragOver={(event) => {
            if (!carriesTabTransfer(event.dataTransfer)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
            setActive(edge);
          }}
          onDragLeave={() => {
            setActive(null);
          }}
          onDrop={(event) => {
            if (!carriesTabTransfer(event.dataTransfer)) return;
            event.preventDefault();
            const payload = readTabTransfer(event.dataTransfer);
            if (
              payload?.itemId === draggedTab.itemId &&
              payload.sourcePane === draggedTab.sourcePane
            )
              onDock(edge);
          }}
        >
          <Text variant="note" className="pointer-events-none">
            {TAB_DOCK_LABELS[edge]}
          </Text>
        </div>
      ))}
    </div>
  );
}
