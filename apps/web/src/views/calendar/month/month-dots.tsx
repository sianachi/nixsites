import { Text, cn, focusRing } from '@nix/ui';
import type { ReactNode } from 'react';

import {
  monthLabel,
  WEEKDAY_ABBREVIATIONS,
  type CalendarMonth,
} from '@nix/web-collections/core/calendar-dates';
import type { Item } from '@nix/web-collections/core/container-model';
import { DayNumber, buildWeeks } from '../month-grid';

/** Dots drawn under a day: enough to say "busy", never a count to read. */
const MAX_DOTS = 3;

interface MonthDotsProps {
  readonly month: CalendarMonth;
  readonly todayText: string;
  readonly byDate: ReadonlyMap<string, readonly Item[]>;

  /** The chosen day, or null for the whole month. */
  readonly picked: string | null;
  readonly onPick: (date: string | null) => void;
}

/**
 * The phone's month: seven columns of day numbers with a dot under each busy day, in place of a
 * 728px grid that scrolls sideways. Tapping a day shows just that day below; tapping it again
 * returns to the whole month.
 */
export function MonthDots(props: MonthDotsProps): ReactNode {
  const { month, todayText, byDate, picked, onPick } = props;

  return (
    <div role="group" aria-label={monthLabel(month)} className="flex flex-col">
      <div aria-hidden="true" className="grid grid-cols-7 text-center">
        {WEEKDAY_ABBREVIATIONS.map((abbreviation) => (
          <Text key={abbreviation} variant="kicker" as="span" tone="muted">
            {abbreviation}
          </Text>
        ))}
      </div>

      {buildWeeks(month).map((week) => (
        <div key={week[0]?.date} className="grid grid-cols-7">
          {week.map((cell) => {
            const count = byDate.get(cell.date)?.length ?? 0;
            const chosen = picked === cell.date;

            return (
              <button
                key={cell.date}
                type="button"
                aria-pressed={chosen}
                aria-label={
                  count === 0
                    ? cell.name
                    : `${cell.name}, ${String(count)} ${count === 1 ? 'item' : 'items'}`
                }
                onClick={() => {
                  onPick(chosen ? null : cell.date);
                }}
                className={cn(
                  'flex min-h-(--control-lg) flex-col items-center justify-center gap-0.5 rounded-md',
                  focusRing,
                  chosen ? 'bg-foreground/7' : 'hover:bg-foreground/7',
                )}
              >
                <DayNumber
                  day={cell.day}
                  isToday={cell.date === todayText}
                  outside={cell.outside}
                />
                <span aria-hidden="true" className="flex h-1 gap-0.5">
                  {Array.from({ length: Math.min(count, MAX_DOTS) }, (_, dot) => (
                    <span key={dot} className="size-1 rounded-full bg-accent" />
                  ))}
                </span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
