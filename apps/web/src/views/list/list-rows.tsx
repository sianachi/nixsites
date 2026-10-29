import { Table, type MenuEntry, type TableRowDrag, type TableSort } from '@nix/ui';
import { useMemo, useRef, type ReactNode } from 'react';

import type { Item } from '../../collections/core/container-model';
import { useVirtualWindow } from '../../collections/core/use-virtual-window';
import { virtualSpacers } from '../../collections/core/virtual-window';
import type { ListColumn } from './list-columns';

const VIRTUALIZATION_THRESHOLD = 100;
const ESTIMATED_ROW_HEIGHT = 45;

export interface ListRowsProps {
  readonly items: readonly Item[];
  readonly columns: readonly ListColumn[];
  readonly sort: TableSort | undefined;
  readonly onSortChange: (sort: TableSort) => void;
  readonly rowContextMenu?: (item: Item) => MenuEntry[];

  /** Which rows are selected and what a touch long-press on one does. */
  readonly rowSelection: RowSelection;

  /** The table's accessible name: the list's, or the section's heading when it is grouped. */
  readonly caption: string;

  /** Dragged widths, kept per device (column-widths.ts), and where a drag writes them. */
  readonly widths?: WidthControl | undefined;
}

export interface RowSelection {
  readonly selected: (item: Item) => boolean;
  readonly longPress: ((item: Item) => boolean) | undefined;
  readonly drag: ((item: Item) => TableRowDrag) | undefined;
}

interface WidthControl {
  readonly columnWidths: Readonly<Record<string, number>>;
  readonly onColumnResize: (columnKey: string, width: number) => void;
  readonly onColumnWidthReset: (columnKey: string) => void;
}

/** Which row a list row's menu acts on, for the name a screen reader hears. */
export function rowMenuLabel(item: Item): string {
  return `${item.title || 'Untitled'} actions`;
}

export function ListRows(props: ListRowsProps): ReactNode {
  const { items, columns, sort, onSortChange, rowContextMenu, rowSelection, caption, widths } =
    props;
  if (items.length <= VIRTUALIZATION_THRESHOLD) {
    return (
      <Table<Item>
        caption={caption}
        captionHidden
        columns={columns}
        rows={items}
        rowKey={(item) => item.id}
        emptyMessage="Nothing in here yet."
        {...(sort === undefined ? {} : { sort })}
        {...(widths ?? {})}
        onSortChange={onSortChange}
        rowSelected={rowSelection.selected}
        {...(rowSelection.drag === undefined ? {} : { rowDrag: rowSelection.drag })}
        {...(rowSelection.longPress === undefined ? {} : { rowLongPress: rowSelection.longPress })}
        {...(rowContextMenu === undefined
          ? {}
          : { rowContextMenu, rowContextMenuLabel: rowMenuLabel })}
      />
    );
  }

  return <VirtualListRows {...props} />;
}

function VirtualListRows(props: ListRowsProps): ReactNode {
  const { items, columns, sort, onSortChange, rowContextMenu, rowSelection, caption, widths } =
    props;
  const rootRef = useRef<HTMLTableElement>(null);
  // Stable identity keeps the virtualizer's measurement subscriptions intact between renders.
  const keys = useMemo(() => items.map((item) => item.id), [items]);
  const windowed = useVirtualWindow({
    keys,
    rootRef,
    estimate: ESTIMATED_ROW_HEIGHT,
  });
  const rows = windowed.indexes.flatMap((index) => {
    const item = items[index];
    return item === undefined ? [] : [item];
  });

  return (
    <Table<Item>
      tableRef={rootRef}
      caption={caption}
      columns={columns}
      rows={rows}
      rowKey={(item) => item.id}
      emptyMessage="Nothing in here yet."
      {...(sort === undefined ? {} : { sort })}
      {...(widths ?? {})}
      onSortChange={onSortChange}
      rowSelected={rowSelection.selected}
      {...(rowSelection.drag === undefined ? {} : { rowDrag: rowSelection.drag })}
      {...(rowSelection.longPress === undefined ? {} : { rowLongPress: rowSelection.longPress })}
      {...(rowContextMenu === undefined
        ? {}
        : { rowContextMenu, rowContextMenuLabel: rowMenuLabel })}
      captionHidden
      virtualization={{
        totalRows: items.length,
        rowIndexes: windowed.indexes,
        spacerHeights: virtualSpacers(windowed.offsets, windowed.indexes),
      }}
    />
  );
}
