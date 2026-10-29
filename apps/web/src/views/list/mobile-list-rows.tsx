import {
  Button,
  ContextMenu,
  Text,
  cn,
  type ContextMenuTargetProps,
  type TableColumn,
} from '@nix/ui';
import { useState, type ReactNode } from 'react';

import type { Item } from '@nix/web-collections/core/container-model';
import { ValuePopover } from '@nix/web-collections/properties/value-popover';
import { SELECT_COLUMN_KEY } from './list-columns';
import { rowMenuLabel, type ListRowsProps } from './list-rows';

export function MobileListRows({
  items,
  columns: allColumns,
  rowContextMenu,
  rowSelection,
  caption,
}: ListRowsProps): ReactNode {
  const [limit, setLimit] = useState(40);
  // The selection gutter is not a field: it is drawn beside the row, and only while selecting.
  const columns = allColumns.filter((column) => column.key !== SELECT_COLUMN_KEY);
  const selectColumn = allColumns.find((column) => column.key === SELECT_COLUMN_KEY);
  const selecting = items.some(rowSelection.selected);
  return (
    <section aria-label={caption} className="flex min-w-0 flex-col gap-3">
      <ul className="divide-y divide-divider">
        {items.slice(0, limit).map((item) =>
          // A long press is the phone's right-click: the same actions the desktop rows offer, so a
          // row on a phone is not the one place an item cannot be moved, pinned or deleted from.
          rowContextMenu === undefined ? (
            <MobileRow
              key={item.id}
              item={item}
              columns={columns}
              selectColumn={selecting ? selectColumn : undefined}
              selected={rowSelection.selected(item)}
            />
          ) : (
            <ContextMenu
              key={item.id}
              label={rowMenuLabel(item)}
              items={() => rowContextMenu(item)}
              {...(rowSelection.longPress === undefined
                ? {}
                : { onLongPress: () => rowSelection.longPress?.(item) === true })}
            >
              {(contextTarget) => (
                <MobileRow
                  item={item}
                  columns={columns}
                  target={contextTarget}
                  selectColumn={selecting ? selectColumn : undefined}
                  selected={rowSelection.selected(item)}
                />
              )}
            </ContextMenu>
          ),
        )}
      </ul>
      {items.length > limit ? (
        <Button
          variant="secondary"
          onClick={() => {
            setLimit((current) => current + 40);
          }}
        >
          Show more items
        </Button>
      ) : null}
    </section>
  );
}

/**
 * One phone row: the title and the view's first two fields. The values are read, not edited, in the
 * row - a column of live controls is a form per row - and each opens the cell's own editor in a
 * popover, so there is one edit path. The remaining fields are in the item.
 */
function MobileRow(props: {
  readonly item: Item;
  readonly columns: ListRowsProps['columns'];
  readonly target?: ContextMenuTargetProps;
  readonly selectColumn?: TableColumn<Item> | undefined;
  readonly selected: boolean;
}): ReactNode {
  const { item, columns, target, selectColumn, selected } = props;

  return (
    <li
      {...target}
      className={cn('flex min-w-0 items-center gap-2 py-2', selected && 'bg-accent/10')}
    >
      {selectColumn?.cell(item)}
      <div className="min-w-0 flex-1">{columns[0]?.cell(item)}</div>
      {columns.slice(1, 3).map((column) => {
        const { property } = column;
        return (
          <div key={column.key} className="w-28 shrink-0">
            {property === undefined ? (
              <Text as="span" variant="caption" tone="muted" truncate>
                {column.cell(item)}
              </Text>
            ) : (
              <ValuePopover item={item} property={property} density="cell" className="w-full">
                {(column.cardCell ?? column.cell)(item)}
              </ValuePopover>
            )}
          </div>
        );
      })}
    </li>
  );
}
