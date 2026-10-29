import { Text } from '@nix/ui';
import type { ReactNode } from 'react';

import type { Item } from '@nix/web-collections/core/container-model';
import type { AxisGroup } from '@nix/web-collections/core/view-axis';

export function ColumnHeader({ column }: { readonly column: AxisGroup }): ReactNode {
  return (
    <th scope="col" className="border border-divider p-3 text-left align-bottom">
      <Text as="span" variant="h6">
        {column.label}
      </Text>
    </th>
  );
}

export function CellCards({
  items,
  label,
  render,
}: {
  readonly items: readonly Item[];
  readonly label: string;
  readonly render: (item: Item) => ReactNode;
}): ReactNode {
  if (items.length === 0) {
    return (
      <Text as="p" variant="caption" tone="muted">
        Empty.
      </Text>
    );
  }
  return (
    <ul aria-label={`${label} cards`} className="flex flex-col gap-2">
      {items.map(render)}
    </ul>
  );
}
