import { Segmented, Text } from '@nix/ui';
import type { ReactNode } from 'react';

import type { SplitOrientation } from './pane-params';

const SPLIT_OPTIONS = [
  { value: 'vertical', label: 'Side by side' },
  { value: 'horizontal', label: 'Stacked' },
] as const;

export interface PaneSplitControlProps {
  readonly orientation: SplitOrientation;
  readonly onChange: (orientation: SplitOrientation) => void;
}

/** Chooses how an existing multi-pane arrangement uses the screen. */
export function PaneSplitControl({ orientation, onChange }: PaneSplitControlProps): ReactNode {
  return (
    <div className="flex shrink-0 items-center justify-end gap-2 bg-surface px-2 py-1 shadow-sm">
      <Text as="span" variant="caption" tone="muted">
        Layout
      </Text>
      <Segmented
        label="Pane layout"
        options={SPLIT_OPTIONS}
        value={orientation}
        onChange={onChange}
      />
    </div>
  );
}
