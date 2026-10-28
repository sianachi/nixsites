import { Text, cn } from '@nix/ui';
import { useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';

import { CreateItemControl } from '../core/create-item-control';
import { useVirtualWindow } from '../core/use-virtual-window';
import { boardCard, type BoardCardListProps } from './board-card';
import type { BoardColumn } from './board-grouping';
import type { CreateSuggestSource } from '../suggest/suggest-source';

const VIRTUALIZATION_THRESHOLD = 100;
const ESTIMATED_CARD_HEIGHT = 150;
const BOARD_CARD_GAP = 8;

interface BoardColumnPanelProps extends Pick<
  BoardCardListProps,
  | 'columns'
  | 'property'
  | 'cardProperties'
  | 'schema'
  | 'dragged'
  | 'setDragged'
  | 'onMove'
  | 'onWrite'
  | 'onOpen'
  | 'stale'
  | 'dismissedStale'
  | 'onDismissStale'
> {
  readonly compact: boolean;
  readonly column: BoardColumn;
  readonly onCreate: (
    title: string,
    properties?: Record<string, unknown>,
  ) => Promise<string | null>;
  readonly groupKey: string;

  /** What the column's create field learns its suggestions from; see `CreateItemControl`. */
  readonly suggest: CreateSuggestSource;
}

export function BoardColumnPanel(props: BoardColumnPanelProps): ReactNode {
  const {
    column,
    compact,
    columns,
    property,
    cardProperties,
    schema,
    dragged,
    setDragged,
    onMove,
    onWrite,
    onOpen,
    onCreate,
    groupKey,
    suggest,
    stale,
    dismissedStale,
    onDismissStale,
  } = props;

  const [dropTarget, setDropTarget] = useState(false);

  function onDrop(event: DragEvent<HTMLElement>): void {
    event.preventDefault();
    setDropTarget(false);
    setDragged(null);

    if (dragged === null) {
      return;
    }

    // The dragged id is read from state rather than from `dataTransfer`, which the drag start
    // fills only so Firefox will begin the gesture at all. State is the same fact and is available
    // during dragover, where the payload deliberately is not.
    const item = columns
      .flatMap((candidate) => candidate.items)
      .find((candidate) => candidate.id === dragged);

    if (item !== undefined) {
      onMove(item, column.value);
    }
  }

  return (
    <section
      aria-label={column.label}
      onDragOver={(event) => {
        // Preventing the default is what marks this element as a drop target at all; without it
        // the browser refuses the drop and the gesture silently does nothing.
        event.preventDefault();
        setDropTarget(true);
      }}
      onDragLeave={() => {
        setDropTarget(false);
      }}
      onDrop={onDrop}
      className={cn(
        // p-3, not p-2: every other bordered `flex-col gap-2` panel in the views layer - the
        // calendar's unscheduled tray, the timeline's off-axis lists and reschedule panel, the
        // schema and view editors' draft rows - pads at p-3. A column was the one place this rhythm
        // had drifted, and cards inside it sat visibly closer to the frame than the same shape does
        // everywhere else it appears.
        'flex w-full min-w-0 shrink-0 flex-col gap-2 border border-divider p-3',
        compact ? '' : 'sm:w-80',
        dropTarget && dragged !== null ? 'outline-2 -outline-offset-2 outline-accent' : '',
      )}
    >
      <div className={cn('flex items-baseline justify-between gap-2', compact && 'sr-only')}>
        {/* `break-words` is `Text`'s default now; `min-w-0` is what lets a flex child actually
            shrink and wrap instead of pushing the count beside it out of the fixed-width column. */}
        <Text variant="h6" as="h3" className="min-w-0">
          {column.label}
        </Text>
        <Text variant="caption" tone="muted" as="span">
          {column.items.length}
        </Text>
      </div>

      {column.items.length === 0 ? (
        <Text variant="caption" tone="muted" as="p">
          {column.value === null ? `Nothing without a ${property.label.toLowerCase()}.` : 'Empty.'}
        </Text>
      ) : (
        <BoardCardList
          items={column.items}
          label={column.label}
          columns={columns}
          property={property}
          cardProperties={cardProperties}
          schema={schema}
          dragged={dragged}
          setDragged={setDragged}
          onMove={onMove}
          onWrite={onWrite}
          onOpen={onOpen}
          stale={stale}
          dismissedStale={dismissedStale}
          onDismissStale={onDismissStale}
        />
      )}

      {/* Created already in this column, rather than created loose and then dragged. The value the
          column stands for is the value the item gets, which is the same write a drag makes - see
          `move` above. */}
      <CreateItemControl
        label={
          column.value === null
            ? `Add an item without a ${property.label.toLowerCase()}`
            : `Add an item to ${column.label}`
        }
        properties={{ [groupKey]: column.value }}
        onCreate={onCreate}
        suggest={suggest}
        className="mt-1 self-start"
      />
    </section>
  );
}

function BoardCardList(props: BoardCardListProps): ReactNode {
  const { items } = props;
  if (items.length <= VIRTUALIZATION_THRESHOLD) {
    return (
      <ul className="flex min-h-0 flex-col gap-2">
        {items.map((item, index) => boardCard(props, item, index))}
      </ul>
    );
  }
  return <VirtualBoardCardList {...props} />;
}

function VirtualBoardCardList(props: BoardCardListProps): ReactNode {
  const { items, label, dragged } = props;
  const rootRef = useRef<HTMLDivElement>(null);
  // Stable identity keeps the virtualizer's measurement subscriptions intact between renders.
  const keys = useMemo(() => items.map((item) => item.id), [items]);
  const windowed = useVirtualWindow({
    keys,
    rootRef,
    estimate: ESTIMATED_CARD_HEIGHT,
    measurementGap: BOARD_CARD_GAP,
    overscan: 500,
    retainedIndexes:
      dragged === null ? [] : [items.findIndex((candidate) => candidate.id === dragged)],
  });

  return (
    <div
      ref={rootRef}
      role="list"
      aria-label={`${label} cards`}
      className="relative min-h-0"
      style={{ height: windowed.totalSize }} // design-token-exempt: virtual content height is derived from measured cards at runtime and cannot be represented by a design token
    >
      {windowed.segments.map((segment) => (
        <ul
          key={`${String(segment.first)}-${String(segment.last)}`}
          role="presentation"
          className="absolute inset-x-0 flex flex-col gap-2"
          style={{ top: windowed.offsets[segment.first] ?? 0 }} // design-token-exempt: virtual segment position is calculated from measured card offsets at runtime
        >
          {items
            .slice(segment.first, segment.last + 1)
            .map((item, offset) =>
              boardCard(props, item, segment.first + offset, segment.first + offset),
            )}
        </ul>
      ))}
    </div>
  );
}
