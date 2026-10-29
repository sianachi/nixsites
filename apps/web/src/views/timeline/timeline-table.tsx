import { Text, cn } from '@nix/ui';
import { useMemo, useRef, type ReactNode, type RefObject } from 'react';

import { CalendarEntryMenu } from '../calendar/calendar-entry-menu';
import { SelectCheckbox } from '../core/select-checkbox';
import { useVirtualWindow } from '../../collections/core/use-virtual-window';
import { virtualSpacers } from '../../collections/core/virtual-window';
import { Bar, Milestone } from './timeline-bars';
import type { AsideContext, Placed } from './timeline-model';
import { titleOf } from './timeline-model';
import { RescheduleToggle } from './timeline-reschedule';
import type { TimelineColumn, TimelineWindow } from './timeline-scale';

const VIRTUALIZATION_THRESHOLD = 100;
const ESTIMATED_TIMELINE_ROW_HEIGHT = 45;

/**
 * The sticky label column's width.
 *
 * Narrower below the `sm` breakpoint: twelve rem of a 375px screen is more than half of it, which
 * leaves about five day columns and a gantt nobody can read.
 */
const LABEL_COLUMN = 'sticky left-0 z-10 min-w-[8rem] sm:min-w-[12rem]';

interface ColumnHeadingProps {
  readonly column: TimelineColumn;
  readonly isToday: boolean;
}

function ColumnHeading({ column, isToday }: ColumnHeadingProps): ReactNode {
  return (
    <th
      scope="col"
      // The whole date, spelt out, so somebody moving through the row with a screen reader always
      // knows which day they are on rather than hearing a bare "17".
      aria-label={column.name}
      aria-current={isToday ? 'date' : undefined}
      className={cn(
        'min-w-(--control-md) border-b border-divider p-1 text-center',
        isToday ? 'bg-accent/18' : '',
      )}
    >
      <Text variant="kicker" as="span" tone={isToday ? 'accent' : 'muted'}>
        {column.label}
      </Text>
    </th>
  );
}

interface TimelineRowProps {
  readonly placed: Placed;

  /** How many columns the axis has, for the spanning cells either side of the bar. */
  readonly columns: number;
  readonly aside: AsideContext;
  readonly virtualIndex?: number;
}

function TimelineRow({ placed, columns, aside, virtualIndex }: TimelineRowProps): ReactNode {
  const { item, placement } = placed;

  // Every branch that reaches here is a span or a milestone; the other three are lists, not rows.
  if (placement.kind !== 'span' && placement.kind !== 'milestone') {
    return null;
  }

  const first = placement.kind === 'span' ? placement.first : placement.column;
  const last = placement.kind === 'span' ? placement.last : placement.column;

  return (
    <CalendarEntryMenu
      itemId={item.id}
      title={titleOf(item)}
      onOpen={aside.onOpen}
      onReschedule={aside.setRescheduling}
    >
      {(contextTarget) => (
        <tr
          {...contextTarget}
          className="group align-middle"
          data-virtual-index={virtualIndex}
          aria-rowindex={virtualIndex === undefined ? undefined : virtualIndex + 2}
        >
          <th
            scope="row"
            className={cn(
              LABEL_COLUMN,
              'border-b border-divider bg-surface p-1 text-left font-normal',
            )}
          >
            <div className="flex items-center justify-between gap-2">
              <SelectCheckbox item={item} />
              <Text variant="bodySmall" as="span" className="truncate">
                {titleOf(item)}
              </Text>

              <RescheduleToggle item={item} aside={aside} />
            </div>
          </th>

          {/* One spanning cell rather than a run of empty ones. At the month scale a four-day bar would
          otherwise emit twenty-seven `td`s of nothing, per row - the largest allocation in this
          view and the only part of it that grows with rows times columns.

          The zero guard is load-bearing rather than defensive: `colSpan={0}` does not mean "span
          nothing" in HTML, it means "span to the end of the column group", so a bar starting in the
          first column would silently swallow the whole row. */}
          {first === 0 ? null : <td colSpan={first} className="border-b border-divider p-0" />}

          <td colSpan={last - first + 1} className="border-b border-divider p-1">
            {placement.kind === 'milestone' ? (
              <Milestone placed={placed} onOpen={aside.onOpen} />
            ) : (
              <Bar
                placed={placed}
                onOpen={aside.onOpen}
                continuesBefore={placement.continuesBefore}
                continuesAfter={placement.continuesAfter}
              />
            )}
          </td>

          {columns - last - 1 === 0 ? null : (
            <td colSpan={columns - last - 1} className="border-b border-divider p-0" />
          )}
        </tr>
      )}
    </CalendarEntryMenu>
  );
}

interface TimelineTableProps {
  readonly name: string;
  readonly axis: TimelineWindow;
  readonly rows: readonly Placed[];
  readonly todayText: string;
  readonly aside: AsideContext;
}

export function TimelineTable(props: TimelineTableProps): ReactNode {
  const { rows } = props;
  if (rows.length <= VIRTUALIZATION_THRESHOLD) {
    return <TimelineTableContent {...props} indexes={rows.map((_entry, index) => index)} />;
  }
  return <VirtualTimelineTable {...props} />;
}

function VirtualTimelineTable(props: TimelineTableProps): ReactNode {
  const { rows } = props;
  const rootRef = useRef<HTMLTableElement>(null);
  // Stable identity keeps the virtualizer's measurement subscriptions intact between renders.
  const keys = useMemo(() => rows.map((entry) => entry.item.id), [rows]);
  const windowed = useVirtualWindow({
    keys,
    rootRef,
    estimate: ESTIMATED_TIMELINE_ROW_HEIGHT,
  });
  return (
    <TimelineTableContent
      {...props}
      rootRef={rootRef}
      indexes={windowed.indexes}
      offsets={windowed.offsets}
    />
  );
}

function TimelineTableContent(
  props: TimelineTableProps & {
    readonly indexes: readonly number[];
    readonly rootRef?: RefObject<HTMLTableElement | null>;
    readonly offsets?: readonly number[];
  },
): ReactNode {
  const { name, axis, rows, todayText, aside, indexes, rootRef, offsets } = props;
  const spacers = offsets === undefined ? [] : virtualSpacers(offsets, indexes);
  return (
    <table
      ref={rootRef}
      aria-rowcount={offsets === undefined ? undefined : rows.length + 1}
      className="w-full border-collapse"
    >
      <Text as="caption" variant="caption" className="sr-only">
        {`${name}: ${axis.label}, each item drawn across the days between its start and its end`}
      </Text>

      <thead>
        <tr>
          <th scope="col" className={cn(LABEL_COLUMN, 'bg-surface p-1 text-left')}>
            <Text variant="kicker" as="span" tone="muted">
              Item
            </Text>
          </th>
          {axis.columns.map((column) => (
            <ColumnHeading
              key={column.fromText}
              column={column}
              isToday={column.fromText <= todayText && todayText <= column.toText}
            />
          ))}
        </tr>
      </thead>

      <tbody>
        {rows.length === 0 ? (
          <tr>
            <td colSpan={axis.columns.length + 1} className="p-3">
              <Text variant="caption" tone="muted">
                {`Nothing falls inside ${axis.label}. Every item this holds is listed below.`}
              </Text>
            </td>
          </tr>
        ) : (
          indexes.flatMap((index, offset) => {
            const entry = rows[index];
            const before = spacers[offset] ?? 0;
            if (entry === undefined) {
              return [];
            }
            return [
              before > 0 ? (
                <tr key={`spacer-before-${String(index)}`} aria-hidden="true">
                  <td
                    colSpan={axis.columns.length + 1}
                    className="border-0 p-0"
                    style={{ height: before }} // design-token-exempt: the spacer height is measured runtime geometry from the shared virtual window, not a design value
                  />
                </tr>
              ) : null,
              <TimelineRow
                key={entry.item.id}
                placed={entry}
                columns={axis.columns.length}
                aside={aside}
                {...(offsets === undefined ? {} : { virtualIndex: index })}
              />,
              offset === indexes.length - 1 && (spacers[indexes.length] ?? 0) > 0 ? (
                <tr key="spacer-after" aria-hidden="true">
                  <td
                    colSpan={axis.columns.length + 1}
                    className="border-0 p-0"
                    style={{ height: spacers[indexes.length] }} // design-token-exempt: the spacer height is measured runtime geometry from the shared virtual window, not a design value
                  />
                </tr>
              ) : null,
            ];
          })
        )}
      </tbody>
    </table>
  );
}
