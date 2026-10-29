import { Button, Text } from '@nix/ui';
import { useState, type ReactNode } from 'react';

import { SelectionBar } from './selection-bar';

export default { title: 'Nix/Views/Selection tray', parameters: { layout: 'padded' } };

const ROWS = Array.from({ length: 24 }, (_, index) => `Row ${String(index + 1)}`);

/**
 * The tray in a scrolling pane, the way a view places it: after the content, floating at the
 * bottom of the pane, with the last row still reachable above it.
 */
function Pane({
  initial,
  shown,
  compact = false,
}: {
  readonly initial: number;
  readonly shown: number;
  readonly compact?: boolean;
}): ReactNode {
  const [count, setCount] = useState(initial);
  return (
    <div className="h-80 max-w-lg overflow-y-auto rounded-md border border-divider bg-background p-4">
      <ul className="flex flex-col gap-2">
        {ROWS.map((row) => (
          <li key={row}>
            <Text as="span" variant="body">
              {row}
            </Text>
          </li>
        ))}
      </ul>
      <SelectionBar
        compact={compact}
        count={count}
        shownCount={shown}
        onSelectAll={() => {
          setCount(shown);
        }}
        onMove={() => undefined}
        onDelete={() => undefined}
        onClear={() => {
          setCount(0);
        }}
      >
        <Button variant="secondary">Archive</Button>
      </SelectionBar>
    </div>
  );
}

export const SomeSelected = { render: (): ReactNode => <Pane initial={3} shown={42} /> };
export const EverythingSelected = { render: (): ReactNode => <Pane initial={42} shown={42} /> };
export const Compact = { render: (): ReactNode => <Pane initial={3} shown={42} compact /> };
export const DarkSomeSelected = { ...SomeSelected, globals: { ground: 'dark' } };
export const Phone = {
  ...SomeSelected,
  parameters: { viewport: { defaultViewport: 'mobile1' } },
};
export const DarkPhone = { ...Phone, globals: { ground: 'dark' } };
