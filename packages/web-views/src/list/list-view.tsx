import { useNarrowViewport } from '@nix/web-foundation/layout/viewport';
import {
  Menu,
  Button,
  Select,
  Text,
  useUndo,
  type MenuEntry,
  type TableColumn,
  type TableRowDrag,
  type TableSort,
} from '@nix/ui';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { dropRefusal } from '@nix/web-collections/items/bulk-move';
import { useOptionalItemCommands } from '@nix/web-collections/items/item-commands-context';

import { PartialNotice } from '@nix/web-foundation/components/states/status-panels';

import {
  type Item,
  type PropertyValue,
  type View,
  type ViewFilterRule,
} from '@nix/web-collections/core/container-model';
import { CreateItemControl } from '../core/create-item-control';
import { suggestSourceOf } from '../suggest/suggest-source';
import { useItemContextActions } from '@nix/web-collections/core/use-item-context-actions';
import {
  resetColumnWidth,
  setColumnWidth,
  useColumnWidths,
} from '@nix/web-collections/core/column-widths';
import {
  ShownItems,
  useOptionalItemSelection,
} from '@nix/web-collections/core/item-selection-context';
import { useClickSelects } from '@nix/web-collections/core/item-open-click';
import { SelectCheckbox } from '../core/select-checkbox';
import { rowGestures } from '@nix/web-collections/core/use-item-selection';
import { cellFor, isCellMoveKey, moveFocusedCell } from './cell-nav';
import {
  SELECT_COLUMN_KEY,
  buildColumns,
  cellRefusalKey,
  type CellRefusalStore,
  type RowGestures,
} from './list-columns';
import { ListRows, type RowSelection } from './list-rows';
import { ListSections } from './list-sections';
import { MobileListRows } from './mobile-list-rows';
import type { ContainerData } from '@nix/web-collections/core/use-container';
import { drawable, useViewChrome, ViewSettingsLink } from '../core/view-chrome';
import { viewConfigureHref } from '@nix/web-collections/core/view-configure-route';
import { useCompactCollection } from '@nix/web-foundation/layout/zen-presentation';
import { capabilitiesOf } from '@nix/web-collections/core/view-capabilities';
import { useViewState, type SortDirection } from '@nix/web-collections/core/view-state';
import {
  describeAxisProblem,
  groupItems,
  resolveViewAxis,
} from '@nix/web-collections/core/view-axis';

/**
 * The list view: a container's children as a table, edited in place.
 *
 * The plainest of the three views and the one every container falls back to, so it is also the one
 * that has to be right about the least interesting things - what the columns are, what order the
 * rows are in, and above all what it says when there are no rows. Those five answers are not
 * decided here: they are the shared view chrome, which the board and the calendar also ask, because
 * four copies of one decision is four chances to drop the branch nobody meets while building.
 *
 * **Every cell is a control, always drawn as one.** Not click-to-edit: that needs a focus transfer
 * effect of its own, and it hides from a screen reader the one fact the table is trying to convey,
 * which is that these values can be changed. The cost is a tab stop per cell - kept, deliberately:
 * goal 3.8 adds Alt+Arrow cell-to-cell movement (`./cell-nav.ts`) rather than roving tabindex, so
 * this table never trades a long tab order for the focus-restoration problem a roving tabindex
 * would reopen on every re-sort, optimistic update and refusal rollback (see the note below).
 *
 * **Plain table semantics.** A real `<table>` with `<th scope="row">` row headers, not `role="grid"`
 * with a roving tabindex. A roving tabindex is focus state with no source - it cannot come from the
 * URL - so it would be local state plus an effect moving DOM focus, and focus jumping on a re-sort,
 * on an optimistic update or on a refusal rollback is worse than a long tab order.
 *
 * **The sort is not held here.** It lives in the URL, because a sorted table that cannot be linked
 * or restored by the back button is a table somebody has to re-sort every time they arrive. This
 * component reads the sort out of `useViewState` and writes a header click back to it; between
 * those two the state is the address bar's, and React re-renders because the address changed.
 */

/** A stable empty rule set for the container that defines no view, so the filter memo holds. */
const NO_RULES: readonly ViewFilterRule[] = [];

export interface ListViewProps {
  readonly container: ContainerData;

  /** The view being rendered, or null for a container that defines none. */
  readonly view: View | null;

  /**
   * Opens one item. A callback rather than a router import: which route an item opens at is the
   * hosting page's business, and a view that navigated on its own could not be put in a dialog, a
   * split pane, or a story.
   */
  readonly onOpen: (itemId: string) => void;
  readonly onOpenWithRows?: ((itemId: string, rows: readonly string[]) => void) | undefined;
}

export function ListView(props: ListViewProps): ReactNode {
  const { container, view, onOpen, onOpenWithRows } = props;
  const narrow = useNarrowViewport();
  const viewState = useViewState();
  const [refusals, setRefusals] = useState<ReadonlyMap<string, string>>(() => new Map());
  const compact = useCompactCollection();
  const clickSelects = useClickSelects();
  const itemActions = useItemContextActions(onOpen);
  const rowContextMenu = (item: Item): MenuEntry[] => itemActions(item.id, item.title);
  const selection = useOptionalItemSelection();
  const commands = useOptionalItemCommands();
  // The rows being dragged and the row a drop would land on; null when nothing is mid-drag.
  const [dragging, setDragging] = useState<readonly string[] | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const viewId = view?.id ?? null;
  const columnWidths = useColumnWidths(viewId);
  const undo = useUndo();
  const latest = useRef(container);
  useEffect(() => {
    latest.current = container;
  });
  const [bulkProblem, setBulkProblem] = useState<string | null>(null);

  // The tray's bulk fields: the single-choice field called status (else the first), and the text
  // field called owner. Nothing is offered when the schema has neither.
  const schemaProps = container.schema?.properties ?? [];
  const statusProperty =
    schemaProps.find((p) => p.type === 'select' && p.key === 'status') ??
    schemaProps.find((p) => p.type === 'select') ??
    null;
  const ownerProperty = schemaProps.find((p) => p.key === 'owner' && p.type === 'text') ?? null;
  const owners = [
    ...new Set(
      container.children.flatMap((child) => {
        const value = ownerProperty === null ? null : child.properties[ownerProperty.key];
        return typeof value === 'string' && value !== '' ? [value] : [];
      }),
    ),
  ];
  const setTrayActions = selection?.setTrayActions;
  const selectedKey = selection === null ? '' : [...selection.selected].join('\u0000');
  const bulk = useRef<(key: string, label: string, value: string | null) => Promise<void>>(() =>
    Promise.resolve(),
  );
  useEffect(() => {
    bulk.current = async (key, label, value) => {
      if (selection === null) return;
      const targets = latest.current.children.filter((child) => selection.selected.has(child.id));
      const before = new Map(targets.map((child) => [child.id, child.properties[key] ?? null]));
      const write = (valueFor: (id: string) => unknown) =>
        latest.current.setPropertiesMany(
          targets.map((child) => ({
            itemId: child.id,
            label: child.title || 'Untitled',
            properties: { [key]: valueFor(child.id) },
          })),
        );
      const outcome = await write(() => value);
      setBulkProblem(
        outcome.refused.length === 0
          ? null
          : `${String(outcome.refused.length)} could not be changed: ${outcome.refused[0]?.reason ?? ''}`,
      );
      if (outcome.saved > 0) {
        const what = outcome.saved === 1 ? 'item' : 'items';
        undo.push(
          value === null
            ? `Cleared ${label.toLowerCase()} on ${String(outcome.saved)} ${what}`
            : `Set ${label.toLowerCase()} to ${value} on ${String(outcome.saved)} ${what}`,
          async () => {
            await write((id) => before.get(id));
          },
        );
      }
    };
  });
  const ownersKey = owners.join('\u0000');
  useEffect(() => {
    if (setTrayActions === undefined || selectedKey === '') return;
    if (statusProperty === null && ownerProperty === null) return;
    setTrayActions(
      <>
        {statusProperty === null ? null : (
          <Select
            aria-label={`Set ${statusProperty.label.toLowerCase()} of the selected items`}
            value=""
            onChange={(event) => {
              if (event.target.value !== '')
                void bulk.current(statusProperty.key, statusProperty.label, event.target.value);
            }}
          >
            <option value="">Set {statusProperty.label.toLowerCase()}…</option>
            {statusProperty.options.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </Select>
        )}
        {ownerProperty === null ? null : (
          <Menu
            label="Set owner of the selected items"
            items={[
              ...owners.map((name) => ({
                kind: 'action' as const,
                label: name,
                onSelect: () => {
                  void bulk.current(ownerProperty.key, ownerProperty.label, name);
                },
              })),
              {
                kind: 'action' as const,
                label: 'Unassigned',
                onSelect: () => {
                  void bulk.current(ownerProperty.key, ownerProperty.label, null);
                },
              },
            ]}
          >
            {(trigger) => (
              <Button {...trigger} variant="secondary">
                Set owner
              </Button>
            )}
          </Menu>
        )}
      </>,
    );
    return () => {
      setTrayActions(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rebuilt on selection and owner-list change only
  }, [setTrayActions, selectedKey, statusProperty?.key, ownerProperty?.key, ownersKey]);

  // Which sections are folded away. Seeded from the view's stored `collapsedGroups` (ADR-0054) and
  // then held here: folding a section is somebody reading, not somebody rearranging the view for
  // everyone, so it is not written back to the shared view on every click.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(
    () => new Set(view?.collapsedGroups ?? []),
  );

  // The URL wins, the stored view is the starting point. A view configured to sort by owner is
  // what somebody arriving with no sort in the address should see; the moment they click a header
  // the address is the more specific statement and this falls through to it.
  const sortBy = viewState.sortBy ?? view?.sortBy ?? null;
  const direction: SortDirection =
    viewState.sortBy !== null
      ? viewState.direction
      : view?.sortDescending === true
        ? 'descending'
        : 'ascending';

  const chrome = useViewChrome({
    container,
    viewState,
    subject: 'this list',
    // A list needs nothing configured to be drawable: it has titles to show even with no schema,
    // which is exactly why it is what every container falls back to.
    drawable: drawable(null),
    emptyTitle: 'Nothing in here yet',
    emptyDetail: 'Items added to this one appear here as rows.',
    emptyAction: <CreateItemControl label="Add an item" onCreate={container.create} />,
    filtered: (total) => ({
      title: 'No items match the filters',
      // Says how many are hidden, because "no items match" leaves open the possibility that the
      // item was empty all along, and the count is the proof that it was not.
      detail: hiddenByFilters(total),
    }),
    savedRules: view?.filters ?? NO_RULES,
    view: view ?? null,
    sortBy,
    descending: direction === 'descending',
  });

  if (chrome.kind === 'chrome') {
    return chrome.node;
  }

  async function write(itemId: string, key: string, value: PropertyValue): Promise<string | null> {
    const row = container.children.find((child) => child.id === itemId);
    const before = (row?.properties[key] ?? null) as PropertyValue;
    const refusal = await container.setProperties(itemId, { [key]: value });
    if (refusal === null && row !== undefined) {
      const label = schemaProps.find((p) => p.key === key)?.label ?? key;
      undo.push(`Changed ${label.toLowerCase()} of "${row.title || 'Untitled'}"`, async () => {
        await container.setProperties(itemId, { [key]: before });
      });
    }
    return refusal;
  }

  // Progress in place, only when the list has a status with a "Done" option.
  const doneOption = statusProperty?.options.find((o) => o.toLowerCase() === 'done');
  const doneCount =
    statusProperty === null || doneOption === undefined
      ? 0
      : chrome.items.filter((item) => item.properties[statusProperty.key] === doneOption).length;
  const progress =
    doneOption === undefined || chrome.items.length === 0 ? null : (
      <div className="mb-2 flex items-center gap-2">
        <Text as="span" variant="caption" tone="muted">
          {String(doneCount)} of {String(chrome.items.length)} done
        </Text>
        <div
          role="progressbar"
          aria-label="Done"
          aria-valuemin={0}
          aria-valuemax={chrome.items.length}
          aria-valuenow={doneCount}
          className="h-1.5 w-24 overflow-hidden rounded-full bg-divider"
        >
          <div
            className="h-full bg-accent transition-[width] duration-300"
            style={{ width: `${String((doneCount / chrome.items.length) * 100)}%` }} // design-token-exempt: a progress bar's fill is a runtime ratio, not a design-scale value.
          />
        </div>
      </div>
    );

  const refusalStore: CellRefusalStore = {
    read: (itemId, key) => refusals.get(cellRefusalKey(itemId, key)) ?? null,
    write: (itemId, key, refusal) => {
      setRefusals((current) => {
        const next = new Map(current);
        const cacheKey = cellRefusalKey(itemId, key);
        if (refusal === null) {
          next.delete(cacheKey);
        } else {
          next.set(cacheKey, refusal);
        }
        return next;
      });
    },
  };
  const orderIds = chrome.items.map((item) => item.id);
  // Sections (plan 3.3). A grouping that cannot be resolved does not cost the list its rows: the
  // list is what every container falls back to, so it draws flat and says why the headings are
  // missing rather than refusing to draw at all, which is what a board does without its columns.
  const settingsHref = view === null ? null : viewConfigureHref(container.itemId, view);
  const sectioning = resolveViewAxis(container.schema?.properties ?? [], view?.groupBy, {
    allowType: true,
  });
  const sections =
    sectioning.kind === 'ready'
      ? groupItems(sectioning.axis, chrome.items, view?.groupOrder ?? [])
      : null;
  const visibleOrder =
    sections === null
      ? orderIds
      : sections.flatMap((section) =>
          collapsed.has(section.group) ? [] : section.items.map((item) => item.id),
        );
  const besideOf = selection?.openBeside;
  const gesturesFor = (item: Item): RowGestures =>
    rowGestures(
      selection,
      item.id,
      orderIds,
      () => {
        if (onOpenWithRows === undefined) onOpen(item.id);
        else onOpenWithRows(item.id, visibleOrder);
      },
      besideOf === undefined
        ? undefined
        : () => {
            besideOf(item.id);
          },
      clickSelects,
    );
  // A touch long-press starts a selection; once one exists it opens the row menu as before.
  const longPress = (item: Item): boolean => {
    if (selection === null || selection.selected.size > 0) return false;
    selection.toggle(item.id, orderIds);
    return true;
  };
  // Dropping a row on another puts it inside (capabilities `drag: 'parent'`). A selected row drags
  // the whole selection. An invalid target is still a drop target so the refusal is said, but it is
  // never outlined as one. The keyboard path is "Move to…" in the row menu and the selection tray:
  // Alt+Arrow here already moves between cells.
  const rowDrag = (item: Item): TableRowDrag => {
    const alone = dragging?.length === 1 && dragging[0] === item.id;
    return {
      draggable: true,
      onDragStart: (event) => {
        const ids = selection?.selected.has(item.id) === true ? [...selection.selected] : [item.id];
        setDragging(ids);
        event.dataTransfer.effectAllowed = 'move';
        // Set, though nothing reads it: without data attached, Firefox refuses to start the drag.
        event.dataTransfer.setData('text/plain', ids.join(','));
      },
      onDragOver: (event) => {
        if (dragging === null || alone || commands === null) return;
        event.preventDefault();
        setOverId(dropRefusal(dragging, item.id, commands.tree.find) === null ? item.id : null);
      },
      onDragLeave: () => {
        setOverId(null);
      },
      onDragEnd: () => {
        setDragging(null);
        setOverId(null);
      },
      onDrop: (event) => {
        event.preventDefault();
        const ids = dragging;
        setDragging(null);
        setOverId(null);
        if (ids === null || alone || commands === null) return;
        // Rows that left this list are gone from the next read, with the destination named.
        void commands
          .dropItems(ids, item.id)
          .then((moved) => (moved.length > 0 ? container.reload() : undefined));
      },
      dropTarget: overId === item.id,
    };
  };
  const rowSelection: RowSelection = {
    selected: (item) => selection?.selected.has(item.id) === true,
    longPress: selection === null ? undefined : longPress,
    drag:
      commands === null || container.locked || !capabilitiesOf('list').move ? undefined : rowDrag,
  };
  const columns = [
    // A box per row while the container selects (requirement 7): a plain toggle, Shift extends.
    // It sits in a fixed gutter and is only drawn on row hover or focus until something is selected,
    // so the 95% of visits that never select see no column of boxes - and nothing shifts when one
    // appears.
    ...(selection === null
      ? []
      : [
          {
            key: SELECT_COLUMN_KEY,
            header: 'Select',
            gutter: true,
            cell: (item: Item) => <SelectCheckbox item={item} />,
          } satisfies TableColumn<Item>,
        ]),
    ...buildColumns(view, container.schema, gesturesFor, write, refusalStore, compact),
  ];
  const sort = sortBy === null ? undefined : { columnKey: sortBy, direction };
  const onSortChange = (next: TableSort): void => {
    viewState.setSort(next.columnKey, next.direction);
  };

  const sectionNotice =
    sectioning.kind === 'missing' || sectioning.kind === 'wrongType' ? (
      <PartialNotice
        pending={`This list is shown without sections. ${describeAxisProblem(sectioning, 'sections')}`}
        {...(settingsHref === null ? {} : { action: <ViewSettingsLink href={settingsHref} /> })}
      />
    ) : null;
  const toggleSection = (group: string): void => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(group)) {
        next.delete(group);
      } else {
        next.add(group);
      }
      return next;
    });
  };
  const rowsFor = (items: readonly Item[], caption: string): ReactNode =>
    narrow ? (
      <MobileListRows
        items={items}
        columns={columns}
        sort={sort}
        onSortChange={onSortChange}
        rowContextMenu={rowContextMenu}
        rowSelection={rowSelection}
        caption={caption}
      />
    ) : (
      <ListRows
        items={items}
        columns={columns}
        sort={sort}
        onSortChange={onSortChange}
        rowContextMenu={rowContextMenu}
        rowSelection={rowSelection}
        caption={caption}
        widths={
          viewId === null
            ? undefined
            : {
                columnWidths,
                onColumnResize: (columnKey, width) => {
                  setColumnWidth(viewId, columnKey, width);
                },
                onColumnWidthReset: (columnKey) => {
                  resetColumnWidth(viewId, columnKey);
                },
              }
        }
      />
    );

  return (
    // The table's own horizontal scroller. A `w-full` table is laid out `auto`, so it cannot render
    // narrower than its min-content width - enough property columns and it paints straight past a
    // `min-w-0` parent. Now that the pane scrolls only vertically, this is the sole owner of the
    // wide axis.
    //
    // Justification: this div is not itself interactive - it only delegates a keydown listener
    // that catches Alt+Arrow bubbling up from its own focusable descendants (the real per-cell
    // controls, see `cell-nav.ts`). A role or tabIndex here would make the div itself a tab stop
    // or a widget, which is exactly what goal 3.8's ruling says not to build.
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <div
      className="min-w-0 overflow-x-auto"
      onKeyDown={(event) => {
        // Alt is the gate: a plain arrow, Home or End belongs to whatever control is focused (a
        // caret, a date stepper, a select, a checkbox) and must reach it untouched - see
        // `cell-nav.ts` for why this table cannot use the spreadsheet's own arrow-key ladder.
        if (!event.altKey || event.ctrlKey || event.metaKey || !isCellMoveKey(event.key)) {
          return;
        }
        if (!(event.target instanceof Element)) {
          return;
        }
        const cell = cellFor(event.target);
        if (cell === null) {
          // Not one of the list's own cells (a sort header, the "Add an item" control): this
          // shortcut has nothing to say here, so the key is left alone rather than claimed.
          return;
        }
        // Claimed once it is known to be ours, whether or not a destination exists - an edge does
        // nothing to the table, but the keystroke must still not fall through to the browser's own
        // Alt+Arrow history navigation or a native `<select>`'s Alt+ArrowDown.
        event.preventDefault();
        moveFocusedCell(cell, event.key);
      }}
    >
      {selection === null ? null : <ShownItems ids={visibleOrder} />}
      {chrome.notice}
      {sectionNotice}
      {progress}
      {bulkProblem === null ? null : <PartialNotice pending={bulkProblem} />}

      {sections === null ? (
        rowsFor(chrome.items, ITEMS_CAPTION)
      ) : (
        <ListSections
          sections={sections}
          collapsed={collapsed}
          onToggle={toggleSection}
          renderRows={(section) => rowsFor(section.items, section.label)}
        />
      )}

      {/* Below the table rather than as a last row. `<Table>` has no footer seam, and a row would
          enter the row-header inventory that eleven assertions compare against exactly - so it
          would be a create affordance that broke tests about columns. */}
      <CreateItemControl
        label="Add an item"
        onCreate={container.create}
        suggest={suggestSourceOf(container, onOpen)}
        className="mt-2"
      />
    </div>
  );
}

/** What an ungrouped list's table is called; a section's table is called after its heading. */
const ITEMS_CAPTION = 'Items in this one';

/**
 * What the list says when the filters have removed everything.
 *
 * Says how many are hidden, because "no items match" leaves open the possibility that the item was
 * empty all along, and the count is the proof that it was not.
 */
function hiddenByFilters(total: number): string {
  return total === 1
    ? 'The one item in here is hidden by the current filters.'
    : `All ${String(total)} items in here are hidden by the current filters.`;
}
