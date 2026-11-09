import { useLayoutKind } from '@nix/web-foundation/layout/viewport';
import { Button, Field, Menu, Select, Icon, Text, cn, useUndo } from '@nix/ui';
import { CircleAlert } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { PartialNotice } from '@nix/web-foundation/components/states/status-panels';
import {
  ShownItems,
  useOptionalItemSelection,
} from '@nix/web-collections/core/item-selection-context';
import {
  UNSET_LABEL,
  UNSET_VALUE,
  readSelectValue,
  type Item,
  type PropertyDefinition,
  type View,
} from '@nix/web-collections/core/container-model';
import { CreateItemControl } from '../core/create-item-control';
import { staleMembers, type StaleMember } from '@nix/web-foundation/lib/suggest/staleness';
import { readDismissals, rememberDismissal } from '@nix/web-foundation/lib/suggestion-dismissals';
import { suggestSourceOf } from '../suggest/suggest-source';
import { useViewSuggestionPreference } from '@nix/web-foundation/lib/suggestion-preferences';
import type { ContainerData } from '@nix/web-collections/core/use-container';
import { drawable, undrawable, useViewChrome } from '../core/view-chrome';
import { useViewState } from '@nix/web-collections/core/view-state';
import { BoardColumnPanel } from './board-column';
import {
  NO_STALE,
  columnAges,
  describeUnrenderable,
  resolveGrouping,
  staleDismissalKey,
  type BoardColumn,
} from './board-grouping';

/**
 * The board: a container's children as cards, in columns, grouped by one select property.
 *
 * **Where a card sits *is* its property value.** The board holds no column of its own - no
 * "which column is this card in" stored anywhere. Dropping a card into "Done" writes
 * `status = "Done"`, so the same fact is true in the list view, in search, and in whatever reads
 * the property next. The order *within* a column is the item's sibling order (`placeAfter`), the
 * order every view already falls back to, so there is still no per-view ordering to disagree.
 * It applies only while the view is not sorted by a property. A board that kept its own copy of the placement
 * would have two answers to one question, and the day they disagreed the person would be right to
 * trust neither.
 *
 * **Columns are freely definable and are not the property's allowed values.** The view's
 * `groupOrder` names the columns and their order when it says anything at all; the property's
 * declared `options` are only the fallback for a view that has not chosen. This is deliberate and
 * load-bearing: a status property with six options can be shown as a three-column board in an
 * order somebody picked, and adding a seventh option must not silently rearrange every board in
 * the workspace. The cost is that a card whose value is not one of the chosen columns has nowhere
 * to sit, which this view reports rather than hides - see `hidden` below.
 */

export interface BoardViewProps {
  readonly container: ContainerData;
  readonly view: View;

  /** Opening an item is the page's business, not the board's - so the board is told how. */
  readonly onOpen: (itemId: string) => void;
}

export function BoardView(props: BoardViewProps): ReactNode {
  const { container, view, onOpen } = props;
  const viewState = useViewState();

  // The one piece of genuinely view-local state on this screen: which card the pointer is
  // currently holding. It describes a gesture in progress, not the document, so it is right here
  // and not in the URL or in a store.
  // Only a phone gets the one-column picker; a portrait tablet has room for columns side by side.
  const narrow = useLayoutKind() === 'phone';
  const [mobileColumn, setMobileColumn] = useState<string | null>(null);
  const [dragged, setDragged] = useState<string | null>(null);
  const selection = useOptionalItemSelection();
  const undo = useUndo();
  const latest = useRef(container);
  useEffect(() => {
    latest.current = container;
  });

  // The banner below is specifically about a column move, so its sentence has to be true only of
  // one: `container.writeError` is set by every failed `setProperties` call, including a field
  // edit made through a card's own `ListCell` - which already reports its own refusal beside the
  // field (see `list-cell.tsx`). Reading that shared channel here would print "the card has
  // returned to the column it was in" over a field edit that never touched the column, so the
  // move failure is tracked locally instead and the shared channel is left alone.
  const [moveError, setMoveError] = useState<string | null>(null);

  // The stale-card hint's clock and its dismissals. The clock is read once per mount rather than
  // per render: ages that crept forward on every keystroke would re-sort nothing and only make the
  // sentence's day count jump at midnight mid-gesture. Dismissals are remembered in this browser
  // under a key that includes the card's `updatedAt` (`staleDismissalKey`), so a waved-away note
  // stays away until the card changes and goes stale again; read once here, written on dismiss.
  const [mountedAt] = useState(() => Date.now());
  const viewSuggestions = useViewSuggestionPreference((state) => state.setting);
  const [dismissedStale, setDismissedStale] = useState<ReadonlySet<string>>(() => readDismissals());

  // Whether the board can be drawn at all is resolved before the chrome so the chrome can report
  // it, and handed back by the chrome so this does not have to check it twice. An empty board and a
  // broken board look identical if you let them, and somebody staring at an empty board goes
  // looking for their missing items rather than for the missing property.
  const grouping = resolveGrouping(container, view);

  // The URL's sort wins over the view's own, because it is the more specific statement - somebody
  // chose it just now, possibly in a link they were handed.
  const chrome = useViewChrome({
    container,
    viewState,
    subject: 'this board',
    drawable:
      grouping.kind === 'ready'
        ? drawable(grouping.property)
        : undrawable<PropertyDefinition>(describeUnrenderable(grouping, view)),
    emptyTitle: 'Nothing in here yet',
    emptyDetail:
      'Nothing has been added here yet. Items added to this one appear on the board as cards.',
    // Without a column to add to there is no value to set, so this makes an item with none - it
    // lands in the unset column, which is where an item with no status belongs.
    emptyAction: <CreateItemControl label="Add the first item" onCreate={container.create} />,
    filtered: (total) => ({
      title: 'No items match the filters',
      detail: `This holds ${String(total)} items. The filters in the address are hiding all of them, so the board is empty by request rather than because there is nothing here.`,
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

  const property = chrome.drawable;
  const key = property.key;

  const buckets = new Map<string | null, Item[]>();
  for (const item of chrome.items) {
    const value = readSelectValue(item, key);
    const bucket = buckets.get(value);
    if (bucket === undefined) {
      buckets.set(value, [item]);
    } else {
      bucket.push(item);
    }
  }

  const chosen = [...new Set(view.groupOrder.length > 0 ? view.groupOrder : property.options)];

  const columns: readonly BoardColumn[] = [
    ...chosen.map((value) => ({ value, label: value, items: buckets.get(value) ?? [] })),

    // The unset column is not optional. Without it, every item whose grouping property has no
    // value disappears from the board - the single most alarming thing a board can do, because
    // nothing on screen says the items exist. It is rendered even when empty, so the board always
    // shows that it has somewhere to put them.
    { value: null, label: UNSET_LABEL, items: buckets.get(null) ?? [] },
  ];

  const columnId = (column: BoardColumn): string =>
    column.value === null ? 'unset' : `value:${column.value}`;
  const selectedColumn = columns.find((column) => columnId(column) === mobileColumn) ?? columns[0];
  const visibleColumns = narrow && selectedColumn ? [selectedColumn] : columns;

  // Cards untouched far longer than their column's usual, by `updatedAt` - see `StaleCardHint` for
  // why that is the only clock available and why no "move it to" suggestion comes with it. The
  // unset column is a column like any other here: an item nobody has triaged in a month is exactly
  // what the hint is for.
  //
  // The usual is the whole column's, bucketed by the same grouping value from every loaded child,
  // never just the cards a filter leaves on screen: a filter that shows only old cards would make
  // them look ordinary, and one that shows a few would leave too few to judge. The filtered cards
  // only decide which hints are drawn, by id. A truncated container's columns are a sample, and a
  // median over a sample is a guess, so then nothing is said at all.
  const stale: ReadonlyMap<string, StaleMember> =
    viewSuggestions === 'off' || container.truncated
      ? NO_STALE
      : staleMembers(columnAges(container.children, key, mountedAt));

  const placed = new Set<string | null>([...chosen, null]);
  const hidden = [...buckets].filter(([value]) => !placed.has(value)).flatMap(([, items]) => items);

  // Grabbing a selected card carries the whole selection; any other card goes alone.
  const draggedIds: ReadonlySet<string> =
    dragged !== null &&
    selection !== null &&
    selection.selected.has(dragged) &&
    selection.selected.size > 1
      ? selection.selected
      : new Set(dragged === null ? [] : [dragged]);
  const reorderable = (viewState.sortBy ?? view.sortBy) === null;

  /**
   * Moves cards to a column and, when `afterId` is given (null: first), to that place in it.
   * The column is the grouping write; the place is the sibling order. One undo entry reverses
   * both from the current state.
   */
  async function place(
    moving: readonly Item[],
    value: string | null,
    afterId?: string | null,
  ): Promise<void> {
    const all = container.children;
    const was = all.flatMap((item, index) =>
      moving.some((m) => m.id === item.id)
        ? [{ item, value: readSelectValue(item, key), after: all[index - 1]?.id ?? null }]
        : [],
    );
    const changed = was.filter((w) => w.value !== value);
    const ordered = afterId !== undefined && reorderable;
    if (changed.length === 0 && !ordered) {
      return;
    }

    setMoveError(null);
    let failure: string | null = null;
    const only = changed[0];
    if (changed.length === 1 && only !== undefined) {
      failure = await container.setProperties(only.item.id, { [key]: value });
    } else if (changed.length > 1) {
      const outcome = await container.setPropertiesMany(
        changed.map((w) => ({
          itemId: w.item.id,
          label: w.item.title || 'Untitled',
          properties: { [key]: value },
        })),
      );
      const refused = outcome.refused[0];
      failure = refused === undefined ? null : `${refused.label}: ${refused.reason}`;
    }
    let anchor = afterId ?? null;
    for (const w of ordered && failure === null ? was : []) {
      failure = await container.placeAfter(w.item.id, anchor);
      if (failure !== null) break;
      anchor = w.item.id;
    }
    setMoveError(failure);
    if (failure !== null) return;

    const what = was.length === 1 ? titleOf(was[0]?.item) : `${String(was.length)} cards`;
    const column = columns.find((c) => c.value === value)?.label ?? UNSET_LABEL;
    undo.push(changed.length > 0 ? `Moved ${what} to ${column}` : `Reordered ${what}`, async () => {
      const current = latest.current;
      await current.setPropertiesMany(
        changed.map((w) => ({
          itemId: w.item.id,
          label: w.item.title || 'Untitled',
          properties: { [key]: w.value },
        })),
      );
      for (const w of ordered ? was : []) await current.placeAfter(w.item.id, w.after);
    });
  }

  function move(item: Item, value: string | null): void {
    void place([item], value);
  }

  function dropCards(value: string | null, afterId: string | null): void {
    void place(
      container.children.filter((child) => draggedIds.has(child.id)),
      value,
      afterId,
    );
  }

  function reorder(item: Item, direction: 'up' | 'down'): void {
    const cards = columns.find((c) => c.items.some((i) => i.id === item.id))?.items ?? [];
    const at = cards.findIndex((i) => i.id === item.id);
    const afterId = direction === 'up' ? (cards[at - 2]?.id ?? null) : (cards[at + 1]?.id ?? null);
    if (at >= 0) void place([item], readSelectValue(item, key), afterId);
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-col gap-3">
      <ShownItems ids={visibleColumns.flatMap((column) => column.items.map((card) => card.id))} />
      <MoveSelectedTray
        columns={columns}
        onMove={(ids, value) => {
          void place(
            container.children.filter((child) => ids.has(child.id)),
            value,
          );
        }}
      />
      {moveError === null ? null : (
        <div role="alert" className="flex items-start gap-2 rounded-md border border-divider p-3">
          <Icon icon={CircleAlert} size="sm" className="text-accent-text" />
          <Text variant="bodySmall" as="span" tone="accent">
            {moveError} Anything refused has returned to where it was.
          </Text>
        </div>
      )}

      {/* Two different partial states, said separately: the chrome's is about what the address is
          hiding, and the board's own is about what its columns cannot hold. */}
      {chrome.notice}

      {hidden.length === 0 ? null : (
        <PartialNotice
          pending={`${String(hidden.length)} ${hidden.length === 1 ? 'item is' : 'items are'} not on this board: their ${property.label} is not one of its columns. They are still here.`}
        />
      )}

      {narrow && selectedColumn ? (
        <Field label="Board column">
          {(control) => (
            <Select
              {...control}
              value={columnId(selectedColumn)}
              onChange={(event) => {
                setMobileColumn(event.target.value);
              }}
            >
              {columns.map((column) => (
                <option key={columnId(column)} value={columnId(column)}>
                  {column.label} ({column.items.length})
                </option>
              ))}
            </Select>
          )}
        </Field>
      ) : null}
      <div
        className={cn(
          'flex min-h-0 min-w-0 flex-col items-stretch gap-3 pb-2',
          narrow ? '' : 'sm:flex-row sm:items-start sm:overflow-x-auto',
        )}
      >
        {visibleColumns.map((column) => (
          <BoardColumnPanel
            onCreate={container.create}
            suggest={suggestSourceOf(container, onOpen)}
            groupKey={key}
            key={column.value ?? UNSET_VALUE}
            column={column}
            compact={narrow}
            columns={columns}
            property={property}
            cardProperties={view.columns.filter((candidate) => candidate !== key)}
            schema={container.schema?.properties ?? []}
            dragged={dragged}
            draggedIds={draggedIds}
            reorderable={reorderable}
            onReorder={reorder}
            onDropCards={dropCards}
            setDragged={setDragged}
            onMove={move}
            onWrite={(itemId, propertyKey, value) =>
              container.setProperties(itemId, { [propertyKey]: value })
            }
            onOpen={onOpen}
            stale={stale}
            dismissedStale={dismissedStale}
            onDismissStale={(item) => {
              const key = staleDismissalKey(item);
              rememberDismissal(key);
              setDismissedStale((current) => new Set([...current, key]));
            }}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * Adds "Move to column" to the selection tray: send every selected card to one column at once.
 * Renders nothing itself. The tray node is rebuilt only when the selection's size or the columns
 * change, so a fresh `columns` array each render does not loop through the parent's state.
 */
function MoveSelectedTray(props: {
  readonly columns: readonly BoardColumn[];
  readonly onMove: (ids: ReadonlySet<string>, value: string | null) => void;
}): ReactNode {
  const selection = useOptionalItemSelection();
  const setTray = selection?.setTrayActions;
  const size = selection?.selected.size ?? 0;
  const latest = useRef({ ...props, selected: selection?.selected });
  useEffect(() => {
    latest.current = { ...props, selected: selection?.selected };
  });
  const columnsKey = JSON.stringify(props.columns.map((c) => [c.value, c.label]));

  useEffect(() => {
    if (setTray === undefined || size === 0) return;
    setTray(
      <Menu
        label="Move selected cards to column"
        items={latest.current.columns.map((column) => ({
          kind: 'action' as const,
          label: column.label,
          onSelect: () => {
            const { selected, onMove } = latest.current;
            if (selected !== undefined) onMove(selected, column.value);
          },
        }))}
      >
        {(trigger) => (
          <Button {...trigger} variant="secondary">
            Move to column
          </Button>
        )}
      </Menu>,
    );
    return () => {
      setTray(null);
    };
  }, [setTray, size, columnsKey]);
  return null;
}

function titleOf(item: Item | undefined): string {
  return item?.title === undefined || item.title === '' ? 'Untitled' : item.title;
}
