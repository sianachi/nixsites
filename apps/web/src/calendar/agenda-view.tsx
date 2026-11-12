import type { CalendarEntry } from '@nix/api-client';
import { Button, Icon, Text, cn, focusRing } from '@nix/ui';
import { CircleCheck, Plus } from 'lucide-react';
import type { ReactNode } from 'react';

import {
  addDays,
  dayLabel,
  dayText,
  monthEntry,
  monthLabel,
  WEEKDAY_NAMES,
  weekdayIndex,
  type CalendarDay,
} from '@nix/web-collections/core/calendar-dates';
import { readTimestampValue, readerZone } from '@nix/web-collections/core/timestamps';
import { isDailyNote } from './collated-entries';

// design-token-exempt: the preferred card width gives event rows room for a time, title and action.
const AGENDA_GRID = 'grid grid-cols-[repeat(auto-fill,minmax(min(100%,17rem),1fr))] gap-3'; // design-token-exempt: see above

/** The time of day a timed entry is at, in the reader's zone, or nothing if it cannot be read. */
export function timeOf(entry: CalendarEntry): string {
  const moment = readTimestampValue({ value: entry.value }, 'value');
  return moment === null ? '' : moment.at.setZone(readerZone()).toFormat('HH:mm');
}

export interface AgendaViewProps {
  /** Entries already bucketed by `yyyy-MM-dd`. */
  readonly byDay: ReadonlyMap<string, readonly CalendarEntry[]>;
  readonly anchor: CalendarDay;
  readonly today: CalendarDay;
  readonly onOpen: (itemId: string, entry?: CalendarEntry) => void;
  readonly onReschedule: (itemId: string) => void;
  readonly onAdd?: ((day: string) => void) | undefined;
  readonly onComplete?: ((entry: CalendarEntry, occurredOn: string) => void) | undefined;
}

/**
 * The next seven days as a list: what a person opens a calendar to see. One section per day, each
 * with its own "Add" and a visible "Move" on every entry, so nothing needs a drag or a hover.
 * Repeating occurrences and daily notes cannot be moved, and say so in place of the control.
 */
export function AgendaView(props: AgendaViewProps): ReactNode {
  const { byDay, anchor, today, onOpen, onReschedule, onAdd, onComplete } = props;
  const todayText = dayText(today);
  const tomorrowText = dayText(addDays(today, 1));

  return (
    <div className={AGENDA_GRID}>
      {Array.from({ length: 7 }, (_, i) => addDays(anchor, i)).map((day) => {
        const text = dayText(day);
        const entries = [...(byDay.get(text) ?? [])].sort((a, b) => a.value.localeCompare(b.value));
        const label = dayLabel(day);
        const weekday = monthEntry(WEEKDAY_NAMES, weekdayIndex(day.year, day.month, day.day));
        const heading = text === todayText ? 'Today' : text === tomorrowText ? 'Tomorrow' : weekday;

        return (
          <section
            key={text}
            data-calendar-pick={text}
            aria-label={label}
            aria-current={text === todayText ? 'date' : undefined}
            className={cn(
              'flex flex-col gap-1.5 rounded-lg border p-2',
              text === todayText ? 'border-accent' : 'border-border',
            )}
          >
            <header className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <Text as="h2" variant="h6">
                  {heading}
                </Text>
                <Text as="p" variant="bodySmall" tone="muted">
                  {day.day} {monthLabel(day)}
                </Text>
              </div>
              {onAdd === undefined ? null : (
                <Button
                  variant="secondary"
                  className="shrink-0 py-0.5 text-sm whitespace-nowrap pointer-coarse:min-h-11"
                  aria-label={`Add entry on ${label}`}
                  onClick={() => {
                    onAdd(text);
                  }}
                >
                  <Icon icon={Plus} size="sm" />
                  Add
                </Button>
              )}
            </header>

            {entries.length === 0 ? (
              <Text as="p" variant="note" tone="muted">
                Nothing planned
              </Text>
            ) : (
              <ul className="flex flex-col gap-0.5">
                {entries.map((entry) => (
                  <AgendaRow
                    key={`${entry.itemId}:${entry.value}`}
                    entry={entry}
                    onOpen={onOpen}
                    onReschedule={onReschedule}
                    onComplete={onComplete}
                  />
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}

function AgendaRow(props: {
  readonly entry: CalendarEntry;
  readonly onOpen: (itemId: string, entry?: CalendarEntry) => void;
  readonly onReschedule: (itemId: string) => void;
  readonly onComplete?: ((entry: CalendarEntry, occurredOn: string) => void) | undefined;
}): ReactNode {
  const { entry, onOpen, onReschedule, onComplete } = props;
  const title = entry.title ?? '';
  const container = entry.containerTitle ?? 'Untitled';
  const done = entry.completed === true;

  return (
    <li className="flex items-center gap-1">
      <button
        type="button"
        onClick={() => {
          onOpen(entry.itemId, entry);
        }}
        aria-label={`${title}, in ${container}`}
        className={cn(
          focusRing,
          'flex min-w-0 flex-1 items-baseline gap-2 rounded-sm px-1.5 py-1.5 text-left hover:bg-accent/15 pointer-coarse:min-h-11',
        )}
      >
        <Text as="span" variant="caption" tone="muted" className="w-12 shrink-0">
          {entry.kind === 'timestamp' ? timeOf(entry) : 'All day'}
        </Text>
        <span className={cn('min-w-0 flex-1 break-words', done ? 'text-muted line-through' : '')}>
          {title}
        </span>
        <Text as="span" variant="caption" tone="muted" className="hidden truncate sm:inline">
          {container}
        </Text>
      </button>

      {entry.generated ? (
        done ? (
          <Icon icon={CircleCheck} size="sm" label="Done" />
        ) : onComplete === undefined ? (
          <Text as="span" variant="note" tone="muted">
            Repeats
          </Text>
        ) : (
          <Button
            variant="secondary"
            className="py-0.5 text-sm pointer-coarse:min-h-11"
            aria-label={`Mark ${title || 'Untitled'} done`}
            onClick={() => {
              onComplete(entry, entry.value.slice(0, 10));
            }}
          >
            Done
          </Button>
        )
      ) : isDailyNote(entry) ? null : (
        <Button
          variant="secondary"
          className="py-0.5 text-sm pointer-coarse:min-h-11"
          aria-label={`Reschedule ${title || 'Untitled'}`}
          aria-haspopup="dialog"
          onClick={() => {
            onReschedule(entry.itemId);
          }}
        >
          Move
        </Button>
      )}
    </li>
  );
}
