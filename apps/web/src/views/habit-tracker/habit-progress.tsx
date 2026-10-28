import type { HabitTracker } from '@nix/api-client';
import { Button, cn, focusRing, Text } from '@nix/ui';
import { useState, type ReactNode } from 'react';
import { formatShortDate } from '@nix/web-foundation/lib/date-format';

export function shiftHabitDay(day: string, offset: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

export function habitDateRange(from: string, to: string): string[] {
  const days: string[] = [];
  for (let day = from; day <= to && days.length < 366; day = shiftHabitDay(day, 1)) days.push(day);
  return days;
}

export function rollingHabitWindow(
  today: string,
  range: number | 'year',
): { from: string; to: string; previousFrom: string; previousTo: string } {
  const from = range === 'year' ? `${today.slice(0, 4)}-01-01` : shiftHabitDay(today, 1 - range);
  const days = habitDateRange(from, today).length;
  const previousTo = shiftHabitDay(from, -1);
  return { from, to: today, previousFrom: shiftHabitDay(previousTo, 1 - days), previousTo };
}

export interface HabitDay {
  readonly date: string;
  readonly state: string;
  readonly scheduled: boolean;
  readonly completed: boolean;
  readonly quantity: number | null;
  readonly target: number;
  readonly unit: string;
}

export function habitDays(
  tracker: HabitTracker,
  from: string,
  to: string,
  today = formatShortDate(new Date(), tracker.timezone),
): HabitDay[] {
  const occurrences = new Map((tracker.occurrences ?? []).map((entry) => [entry.date, entry]));
  const checkIns = new Map(tracker.checkIns.map((entry) => [entry.occurredOn, entry]));
  return habitDateRange(from, to).map((date) => {
    const occurrence = occurrences.get(date);
    const entry = checkIns.get(date);
    const scheduled =
      occurrence?.scheduled ??
      (entry !== undefined ||
        (date >= tracker.startDate &&
          tracker.status === 'active' &&
          (tracker.frequency === 'daily' ||
            tracker.weekdays.includes(new Date(`${date}T00:00:00Z`).getUTCDay()))));
    const completed = occurrence?.completed ?? entry?.completed ?? false;
    const quantity = occurrence?.quantity ?? entry?.quantity ?? null;
    return {
      date,
      scheduled,
      completed,
      quantity,
      target: occurrence?.target ?? tracker.target,
      unit: occurrence?.unit ?? tracker.unit,
      state:
        date > today
          ? 'upcoming'
          : !scheduled
            ? 'unscheduled'
            : completed
              ? 'completed'
              : quantity !== null && quantity > 0
                ? 'partial'
                : date === today
                  ? 'scheduled'
                  : 'missed',
    };
  });
}

export function habitPeriodSummary(
  days: readonly HabitDay[],
  today: string,
): { planned: number; completed: number; rate: number | null; recorded: number; quantity: number } {
  const elapsed = days.filter(
    (day) => day.scheduled && (day.date < today || (day.date === today && day.completed)),
  );
  const completed = elapsed.filter((day) => day.completed).length;
  const recorded = days.filter((day) => day.quantity !== null).length;
  return {
    planned: elapsed.length,
    completed,
    rate: elapsed.length === 0 ? null : completed / elapsed.length,
    recorded,
    quantity: days.reduce((total, day) => total + (day.quantity ?? 0), 0),
  };
}

const stateLabels: Record<string, string> = {
  completed: 'Completed',
  partial: 'Partly done',
  missed: 'No check-in',
  scheduled: 'Due today',
  unscheduled: 'Not scheduled',
  upcoming: 'Upcoming',
};
const stateClasses: Record<string, string> = {
  completed: 'bg-accent-fill text-background',
  partial: 'bg-accent/30 text-foreground',
  missed: 'bg-surface-raised text-muted',
  scheduled: 'border border-accent text-foreground',
  unscheduled: 'border border-divider/50 bg-surface text-muted',
  upcoming: 'border border-divider bg-surface text-muted',
};
export function habitDayLabel(day: HabitDay): string {
  return `${day.date}: ${stateLabels[day.state] ?? day.state}${day.quantity !== null ? `, ${String(day.quantity)} of ${String(day.target)} ${day.unit}` : ''}`;
}

/** A compact, keyboard-navigable history. A missing check-in is never plotted as zero. */
export function HabitConsistency({
  days,
  selected,
  onSelect,
  editable = true,
}: {
  readonly days: readonly HabitDay[];
  readonly selected?: string | null;
  readonly onSelect: (day: string) => void;
  readonly editable?: boolean;
}): ReactNode {
  const [inspected, setInspected] = useState<HabitDay | null>(null);
  const first = days[0];
  const offset =
    first === undefined ? 0 : (new Date(`${first.date}T00:00:00Z`).getUTCDay() + 6) % 7;
  const columns = Math.ceil((days.length + offset) / 7);
  // Calendar geometry comes from the data, with a token-sized cell width.
  const calendarStyle = {
    gridTemplateColumns: `repeat(${String(columns)}, var(--habit-cell))`,
  };
  return (
    <div className="flex min-w-0 flex-col gap-3 [--habit-cell:calc(var(--spacing)*7)] any-pointer-coarse:[--habit-cell:var(--control-lg)]">
      <div className="min-w-0 max-w-full overflow-x-auto pb-2">
        <div className="flex gap-2">
          <div className="flex shrink-0 flex-col justify-around pt-6" aria-hidden="true">
            {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((day, index) => (
              <Text key={index} variant="caption" tone="muted">
                {day}
              </Text>
            ))}
          </div>
          <div className="min-w-fit flex-1">
            <div className="mb-2 grid gap-1" style={calendarStyle}>
              {Array.from({ length: columns }, (_, index) => {
                const day = days[Math.max(0, index * 7 - offset)];
                const previous = days[Math.max(0, (index - 1) * 7 - offset)];
                return (
                  <Text
                    key={index}
                    variant="caption"
                    tone="muted"
                    className="overflow-visible whitespace-nowrap"
                  >
                    {day !== undefined &&
                    (index === 0 || day.date.slice(0, 7) !== previous?.date.slice(0, 7))
                      ? new Date(`${day.date}T00:00:00Z`).toLocaleDateString(undefined, {
                          month: 'short',
                          timeZone: 'UTC',
                        })
                      : ''}
                  </Text>
                );
              })}
            </div>
            <div
              className="grid grid-flow-col grid-rows-7 gap-1"
              aria-label="Habit consistency calendar"
              style={calendarStyle}
            >
              {Array.from({ length: offset }, (_, index) => (
                <span key={`pad-${String(index)}`} aria-hidden="true" />
              ))}
              {days.map((day, index) => (
                <button
                  key={day.date}
                  type="button"
                  tabIndex={day.date === (selected ?? first?.date) ? 0 : -1}
                  aria-label={habitDayLabel(day)}
                  aria-pressed={selected === day.date}
                  title={habitDayLabel(day)}
                  className={cn(
                    'flex h-7 min-w-6 items-center justify-center rounded-sm text-xs transition-colors any-pointer-coarse:h-(--control-lg) any-pointer-coarse:min-w-(--control-lg)',
                    stateClasses[day.state],
                    selected === day.date && 'ring-2 ring-accent ring-offset-2 ring-offset-surface',
                    focusRing,
                  )}
                  onMouseEnter={() => {
                    setInspected(day);
                  }}
                  onFocus={() => {
                    setInspected(day);
                  }}
                  onClick={() => {
                    onSelect(day.date);
                  }}
                  onKeyDown={(event) => {
                    const change =
                      event.key === 'ArrowRight'
                        ? 7
                        : event.key === 'ArrowLeft'
                          ? -7
                          : event.key === 'ArrowDown'
                            ? 1
                            : event.key === 'ArrowUp'
                              ? -1
                              : null;
                    const target =
                      event.key === 'Home'
                        ? 0
                        : event.key === 'End'
                          ? days.length - 1
                          : change === null
                            ? null
                            : Math.min(days.length - 1, Math.max(0, index + change));
                    if (target !== null) {
                      event.preventDefault();
                      const buttons =
                        event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
                          'button',
                        );
                      buttons?.item(target).focus();
                    }
                  }}
                >
                  {day.state === 'unscheduled' ? (
                    <span aria-hidden="true">·</span>
                  ) : (
                    day.date.slice(8)
                  )}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
      <Text variant="bodySmall" tone="muted" aria-live="polite">
        {inspected === null
          ? editable
            ? 'Choose a day to see or correct its check-in. Use arrow keys to move through the calendar.'
            : 'Choose a day to inspect its check-in. Use arrow keys to move through the calendar.'
          : habitDayLabel(inspected)}
      </Text>
      <div className="flex flex-wrap gap-x-4 gap-y-2" aria-label="Calendar legend">
        {['completed', 'partial', 'missed', 'unscheduled'].map((state) => (
          <div key={state} className="flex items-center gap-2">
            <span className={cn('h-3 w-3 rounded-sm', stateClasses[state])} aria-hidden="true" />
            <Text as="span" variant="caption" tone="muted">
              {stateLabels[state]}
            </Text>
          </div>
        ))}
      </div>
    </div>
  );
}

export function HabitQuantityTrend({
  days,
  unit,
  onSelect,
  editable = true,
}: {
  readonly days: readonly HabitDay[];
  readonly unit: string;
  readonly onSelect: (day: string) => void;
  readonly editable?: boolean;
}): ReactNode {
  const values = days.filter((day) => day.quantity !== null && day.unit === unit);
  const maximum = Math.max(
    1,
    ...days.filter((day) => day.unit === unit).flatMap((day) => [day.quantity ?? 0, day.target]),
  );
  const x = (index: number) => (days.length < 2 ? 300 : (index / (days.length - 1)) * 600);
  const y = (value: number) => 200 - (value / maximum) * 200;
  let path = '';
  let connected = false;
  days.forEach((day, index) => {
    if (day.quantity === null || day.unit !== unit) {
      connected = false;
      return;
    }
    path += `${connected ? ' L' : ' M'}${String(x(index))},${String(y(day.quantity))}`;
    connected = true;
  });
  const target = days.at(-1)?.target ?? 1;
  if (values.length === 0)
    return (
      <Text variant="bodySmall" tone="muted">
        Record an amount to see your {unit} trend. Days without a recorded amount are left blank.
      </Text>
    );
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex gap-3">
        <div
          className="flex h-56 w-12 shrink-0 flex-col justify-between text-right"
          aria-hidden="true"
        >
          {[maximum, maximum / 2, 0].map((value) => (
            <Text key={value} variant="caption" tone="muted">
              {Number(value.toFixed(1))}
            </Text>
          ))}
        </div>
        <div className="min-w-0 flex-1">
          <svg
            role="img"
            aria-label={`Recorded ${unit} over time. Target ${String(target)} ${unit}. Missing amounts are blank; recorded zero remains zero.`}
            viewBox="0 0 600 200"
            preserveAspectRatio="none"
            className="h-56 w-full overflow-visible text-accent"
          >
            {[0, 100, 200].map((height) => (
              <line
                key={height}
                x1="0"
                x2="600"
                y1={height}
                y2={height}
                className="text-divider"
                stroke="currentColor"
                strokeWidth="1"
                vectorEffect="non-scaling-stroke"
              />
            ))}
            <line
              x1="0"
              x2="600"
              y1={y(target)}
              y2={y(target)}
              className="text-muted"
              stroke="currentColor"
              strokeDasharray="4 4"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
            <path
              d={path}
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              vectorEffect="non-scaling-stroke"
            />
            {days.map((day, index) =>
              day.quantity === null || day.unit !== unit ? null : (
                <circle
                  key={day.date}
                  cx={x(index)}
                  cy={y(day.quantity)}
                  r="0.01"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="6"
                  vectorEffect="non-scaling-stroke"
                >
                  <title>{habitDayLabel(day)}</title>
                </circle>
              ),
            )}
          </svg>
          <div className="mt-2 flex justify-between gap-2">
            {[days[0]?.date, days[Math.floor(days.length / 2)]?.date, days.at(-1)?.date].map(
              (date, index) => (
                <Text key={index} variant="caption" tone="muted">
                  {date === undefined
                    ? ''
                    : new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, {
                        day: 'numeric',
                        month: 'short',
                        timeZone: 'UTC',
                      })}
                </Text>
              ),
            )}
          </div>
        </div>
      </div>
      <Text variant="caption" tone="muted">
        {unit}. Dashed line: current target of {target}. Gaps: no amount recorded
        {days.some((day) => day.unit !== unit) ? ` or a different unit` : ''}.
      </Text>
      <details>
        <summary
          className={cn(
            'cursor-pointer rounded-md py-2 text-sm any-pointer-coarse:min-h-(--control-lg)',
            focusRing,
          )}
        >
          {editable ? 'Daily values and corrections' : 'Daily values'}
        </summary>
        <div className="mt-2 max-h-64 overflow-y-auto">
          {days.map((day) => (
            <div
              key={day.date}
              className="flex flex-wrap items-center justify-between gap-3 border-b border-divider py-1"
            >
              <Text as="span" variant="bodySmall">
                {day.date}
              </Text>
              <Button
                variant="ghost"
                aria-label={`${editable ? 'Edit' : 'Inspect'} ${habitDayLabel(day)}`}
                onClick={() => {
                  onSelect(day.date);
                }}
              >
                {day.quantity === null
                  ? 'No amount recorded'
                  : `${String(day.quantity)} ${day.unit}`}
              </Button>
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}
