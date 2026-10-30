import { ScrollRegion, Button, Icon, Text, cn, focusRing } from '@nix/ui';
import { CircleAlert } from 'lucide-react';
import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';

import { useNarrowViewport } from '@nix/web-foundation/layout/viewport';
import type { Item, View } from '@nix/web-collections/core/container-model';
import { CreateItemControl } from '../core/create-item-control';
import type { ContainerData } from '@nix/web-collections/core/use-container';
import { groupItems, type AxisGroup } from '@nix/web-collections/core/view-axis';
import { drawable, undrawable, useViewChrome } from '../core/view-chrome';
import { useViewState } from '@nix/web-collections/core/view-state';
import { cellValue, resolveAxes, type CellAddress, type MatrixAxes } from './matrix-axes';
import { MatrixCard, type CellChoice } from './matrix-card';
import { CellCards, ColumnHeader } from './matrix-cells';

/**
 * The matrix (plan 3.5): cards in a grid of cells, placed by two properties at once - rows by the
 * view's `rowBy`, columns by its `groupBy`, the board's own field.
 *
 * **A cell is two property values, never a placement.** Exactly as a board's column is its
 * property value, a card's cell here is its row value and its column value and nothing stored
 * against the view. Dragging a card to another cell writes both properties in one update, so the
 * move is a single edit everybody sees, and it can never land half-done with one axis moved.
 *
 * **Drag is never the only way.** Every card carries a "Move to" select naming each cell, which
 * writes the same two values the drag does: a keyboard, a screen reader and a touch screen with
 * assistive technology all reach it, and the two gestures cannot drift apart.
 *
 * **A real table.** Row and column headers are `<th>`s, so a screen reader announces "Urgent,
 * Important" on entering a cell rather than leaving somebody to count. On a phone the table would
 * not fit, so it is drawn as one section per row instead, each listing its cells by column name.
 */

export interface MatrixViewProps {
  readonly container: ContainerData;
  readonly view: View;
  readonly onOpen: (itemId: string) => void;
}

export function MatrixView(props: MatrixViewProps): ReactNode {
  const { container, view, onOpen } = props;
  const viewState = useViewState();
  const narrow = useNarrowViewport();
  const [showEmpty, setShowEmpty] = useState(false);
  const [dragged, setDragged] = useState<string | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [dropCell, setDropCell] = useState<string | null>(null);
  // After a move the card is drawn in its new cell as a new element, so focus is put back on its
  // title once that render lands - the way the outline keeps focus on a moved row.
  const titleRefs = useRef(new Map<string, HTMLButtonElement>());
  const pendingFocus = useRef<string | null>(null);
  useEffect(() => {
    const target = pendingFocus.current;
    if (target === null) return;
    const element = titleRefs.current.get(target);
    if (element !== undefined) {
      pendingFocus.current = null;
      element.focus();
    }
  });
  const properties = container.schema?.properties ?? [];
  const resolution = resolveAxes(properties, view);

  const chrome = useViewChrome({
    container,
    viewState,
    subject: 'this matrix',
    drawable:
      resolution.kind === 'ready'
        ? drawable(resolution.axes)
        : undrawable<MatrixAxes>({ title: resolution.title, detail: resolution.detail }),
    emptyTitle: 'Nothing in here yet',
    emptyDetail: 'Items added to this one appear in the matrix as cards.',
    emptyAction: <CreateItemControl label="Add the first item" onCreate={container.create} />,
    filtered: (total) => ({
      title: 'No items match the filters',
      detail: `This holds ${String(total)} items. The filters in the address are hiding all of them.`,
    }),
    savedRules: view.filters,
    view,
    sortBy: viewState.sortBy ?? view.sortBy,
    descending:
      viewState.sortBy === null ? view.sortDescending : viewState.direction === 'descending',
  });

  if (chrome.kind === 'chrome') {
    return chrome.node;
  }

  const { rows, columns } = chrome.drawable;
  const rowGroups = groupItems(rows, chrome.items, [], showEmpty);
  const columnGroups = groupItems(columns, chrome.items, view.groupOrder, showEmpty);
  const cellItems = (address: CellAddress): readonly Item[] =>
    chrome.items.filter(
      (item) => rows.groupOf(item) === address.row && columns.groupOf(item) === address.column,
    );
  const cardFields = view.columns.flatMap((key) => {
    if (key === rows.key || key === columns.key) return [];
    const definition = properties.find((candidate) => candidate.key === key);
    return definition === undefined ? [] : [definition];
  });

  function move(item: Item, to: CellAddress): void {
    if (rows.groupOf(item) === to.row && columns.groupOf(item) === to.column) return;
    const writeRow = rows.valueFor;
    const writeColumn = columns.valueFor;
    if (writeRow === undefined || writeColumn === undefined) return;
    setMoveError(null);
    pendingFocus.current = item.id;
    // Both axes in one write: a move is one edit, and it either lands whole or not at all.
    void container
      .setProperties(item.id, {
        [rows.key]: writeRow(to.row),
        [columns.key]: writeColumn(to.column),
      })
      .then(setMoveError);
  }

  // Every cell a card can be moved to, empty or not: the "Move to" choice must reach a cell the
  // grid is currently folding away, or the keyboard could not do what a drag onto it can.
  const cells: readonly CellChoice[] = groupItems(rows, chrome.items, [], true).flatMap((row) =>
    groupItems(columns, chrome.items, view.groupOrder, true).map((column) => ({
      address: { row: row.group, column: column.group },
      label: `${row.label}, ${column.label}`,
    })),
  );

  const cardFor = (item: Item): ReactNode => (
    <MatrixCard
      key={item.id}
      item={item}
      current={{ row: rows.groupOf(item), column: columns.groupOf(item) }}
      cells={cells}
      fields={cardFields}
      dragging={dragged === item.id}
      titleRef={(element) => {
        if (element === null) titleRefs.current.delete(item.id);
        else titleRefs.current.set(item.id, element);
      }}
      onDragStart={() => {
        setDragged(item.id);
      }}
      onDragEnd={() => {
        setDragged(null);
      }}
      onMove={(to) => {
        move(item, to);
      }}
      onWrite={(itemId, propertyKey, value) =>
        container.setProperties(itemId, { [propertyKey]: value })
      }
      onOpen={onOpen}
    />
  );

  const dropTarget = (address: CellAddress) => ({
    onDragOver: (event: DragEvent<HTMLElement>) => {
      if (dragged === null) return;
      event.preventDefault();
      setDropCell(cellValue(address));
    },
    onDragLeave: () => {
      setDropCell(null);
    },
    onDrop: (event: DragEvent<HTMLElement>) => {
      event.preventDefault();
      const item = chrome.items.find((candidate) => candidate.id === dragged);
      setDragged(null);
      setDropCell(null);
      if (item !== undefined) move(item, address);
    },
  });
  // The board's own drop-target outline, so a held card shows where it will land.
  const dropOutline = (address: CellAddress): string =>
    dragged !== null && dropCell === cellValue(address)
      ? 'outline-2 -outline-offset-2 outline-accent'
      : '';

  /** A create control already in a cell: the new item gets both of the cell's values. */
  const addTo = (row: AxisGroup, column: AxisGroup): ReactNode => {
    const writeRow = rows.valueFor;
    const writeColumn = columns.valueFor;
    if (writeRow === undefined || writeColumn === undefined) return null;
    return (
      <CreateItemControl
        compact
        label={`Add an item to ${row.label}, ${column.label}`}
        properties={{ [rows.key]: writeRow(row.group), [columns.key]: writeColumn(column.group) }}
        onCreate={container.create}
        className="self-start"
      />
    );
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-col gap-3">
      {moveError === null ? null : (
        <div role="alert" className="flex items-start gap-2 rounded-md border border-divider p-3">
          <Icon icon={CircleAlert} size="sm" className="text-accent-text" />
          <Text variant="bodySmall" as="span" tone="accent">
            {moveError} The card is back in the cell it was in; nothing was changed.
          </Text>
        </div>
      )}

      {chrome.notice}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="subtle"
          aria-pressed={showEmpty}
          onClick={() => {
            setShowEmpty((current) => !current);
          }}
        >
          Show empty rows and columns
        </Button>
      </div>

      {narrow ? (
        <div className="flex flex-col gap-3">
          {rowGroups.map((row) => (
            <section key={row.group} aria-label={row.label} className="flex flex-col gap-2">
              <Text as="h3" variant="h6">
                {row.label}
              </Text>
              {columnGroups.map((column) => {
                const items = cellItems({ row: row.group, column: column.group });
                return items.length === 0 && !showEmpty ? null : (
                  <div key={column.group} className="flex flex-col gap-1.5">
                    <Text as="h4" variant="caption" tone="muted">
                      {column.label}
                    </Text>
                    <CellCards
                      items={items}
                      label={`${row.label}, ${column.label}`}
                      render={cardFor}
                    />
                    {addTo(row, column)}
                  </div>
                );
              })}
            </section>
          ))}
        </div>
      ) : (
        <ScrollRegion
          aria-label={`${view.name} matrix`}
          className={cn('min-w-0 max-w-full overflow-x-auto', focusRing)}
        >
          <table className="w-full border-collapse">
            <caption className="sr-only">
              {`${view.name}: ${rows.label} in rows, ${columns.label} in columns`}
            </caption>
            <thead>
              <tr>
                <td />
                {columnGroups.map((column) => (
                  <ColumnHeader key={column.group} column={column} />
                ))}
              </tr>
            </thead>
            <tbody>
              {rowGroups.map((row) => (
                <tr key={row.group}>
                  <th scope="row" className="border border-divider p-3 text-left align-top">
                    <Text as="span" variant="h6">
                      {row.label}
                    </Text>
                  </th>
                  {columnGroups.map((column) => {
                    const address = { row: row.group, column: column.group };
                    return (
                      <td
                        key={column.group}
                        {...dropTarget(address)}
                        className={cn(
                          'min-w-48 border border-divider p-3 align-top',
                          dropOutline(address),
                        )}
                      >
                        <div className="flex flex-col gap-2">
                          <CellCards
                            items={cellItems(address)}
                            label={`${row.label}, ${column.label}`}
                            render={cardFor}
                          />
                          {addTo(row, column)}
                        </div>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollRegion>
      )}

      <CreateItemControl
        label="Add an item"
        onCreate={container.create}
        className="mt-1 self-start"
      />
    </div>
  );
}
