import { useNarrowViewport } from '@nix/web-foundation/layout/viewport';
import { useCompactCollection } from '@nix/web-foundation/layout/zen-presentation';
import { Button, cn, focusRing, Select, Text } from '@nix/ui';
import type { ReactNode } from 'react';

/** The tracker's title, Today/Week/Insights switch, display options and week stepper. */
export function HabitTrackerHeader({
  screen,
  todayOnly,
  dayTitle,
  dayDone,
  dayTotal,
  viewingEarlierDay,
  nextDayDisabled,
  missedYesterday,
  weekOffset,
  windowFrom,
  windowTo,
  showSetup,
  showArchived,
  onToday,
  onShiftDay,
  onReviewYesterday,
  onWeek,
  onInsights,
  onToggleSetup,
  onToggleArchived,
  onShiftWeek,
  onThisWeek,
}: {
  readonly screen: 'checkins' | 'insights';
  readonly todayOnly: boolean;
  readonly dayTitle: string;
  readonly dayDone: number;
  readonly dayTotal: number;
  readonly viewingEarlierDay: boolean;
  readonly nextDayDisabled: boolean;
  readonly missedYesterday: number;
  readonly weekOffset: number;
  readonly windowFrom: string;
  readonly windowTo: string;
  readonly showSetup: boolean;
  readonly showArchived: boolean;
  readonly onToday: () => void;
  readonly onShiftDay: (delta: -1 | 1) => void;
  readonly onReviewYesterday: () => void;
  readonly onWeek: () => void;
  readonly onInsights: () => void;
  readonly onToggleSetup: () => void;
  readonly onToggleArchived: () => void;
  readonly onShiftWeek: (delta: -1 | 1) => void;
  readonly onThisWeek: () => void;
}): ReactNode {
  const compact = useCompactCollection();
  const narrow = useNarrowViewport();
  return (
    <header className="flex flex-col gap-4 border-b border-divider pb-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Text as="h2" variant="h4" id="habit-tracker-title">
            {screen === 'insights'
              ? 'Your progress'
              : todayOnly
                ? dayTitle
                : weekOffset === 0
                  ? 'This week'
                  : weekOffset < 0
                    ? 'Previous week'
                    : 'Next week'}
          </Text>
          <Text variant="bodySmall" tone="muted">
            {screen === 'insights'
              ? 'See the pattern, then choose a day to update it.'
              : todayOnly
                ? `${String(dayDone)} of ${String(dayTotal)} done`
                : `${windowFrom} to ${windowTo}`}
          </Text>
        </div>
        <Button variant="secondary" onClick={onToggleSetup}>
          {showSetup ? 'Close setup' : 'Add a habit'}
        </Button>
      </div>
      {!compact && screen === 'checkins' && todayOnly ? (
        <div
          role="progressbar"
          aria-label="Habits done"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={dayTotal === 0 ? 0 : Math.round((dayDone / dayTotal) * 100)}
          className="h-1.5 overflow-hidden rounded-full bg-surface-raised"
        >
          <div
            className="h-full bg-accent transition-[width] duration-300 ease-out motion-reduce:transition-none"
            style={{ width: `${String(dayTotal === 0 ? 0 : (dayDone / dayTotal) * 100)}%` }} // design-token-exempt: a progress bar's fill is a runtime ratio, not a design-scale value.
          />
        </div>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-3">
        {compact ? (
          <Select
            aria-label="Habit screen"
            className="w-auto"
            value={screen === 'insights' ? 'insights' : todayOnly ? 'day' : 'week'}
            onChange={(event) => {
              if (event.target.value === 'day') onToday();
              else if (event.target.value === 'week') onWeek();
              else onInsights();
            }}
          >
            <option value="day">Day</option>
            <option value="week">Week</option>
            <option value="insights">Insights</option>
          </Select>
        ) : (
          <nav
            className="flex max-w-full flex-wrap gap-1 rounded-lg bg-surface-raised p-1"
            aria-label="Habit screens"
          >
            <Button
              variant={screen === 'checkins' && todayOnly ? 'primary' : 'ghost'}
              aria-pressed={screen === 'checkins' && todayOnly}
              onClick={onToday}
            >
              Day
            </Button>
            <Button
              variant={screen === 'checkins' && !todayOnly ? 'primary' : 'ghost'}
              aria-label="Show week"
              aria-pressed={screen === 'checkins' && !todayOnly}
              onClick={onWeek}
            >
              Week
            </Button>
            <Button
              variant={screen === 'insights' ? 'primary' : 'ghost'}
              aria-pressed={screen === 'insights'}
              onClick={onInsights}
            >
              Insights
            </Button>
          </nav>
        )}
        <details>
          <summary
            className={cn(
              'flex min-h-6 cursor-pointer items-center rounded-md px-2 py-1 text-sm text-muted any-pointer-coarse:min-h-(--control-lg)',
              focusRing,
            )}
          >
            Display options
          </summary>
          <Button variant="subtle" aria-pressed={showArchived} onClick={onToggleArchived}>
            {showArchived ? 'Hide archived' : 'Show archived'}
          </Button>
        </details>
      </div>
      {screen === 'checkins' && todayOnly ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant={narrow && !viewingEarlierDay ? 'subtle' : 'secondary'}
            aria-label={
              narrow && !viewingEarlierDay && missedYesterday > 0 ? undefined : 'Previous day'
            }
            onClick={() => {
              onShiftDay(-1);
            }}
          >
            {narrow && !viewingEarlierDay
              ? missedYesterday === 0
                ? 'Previous day'
                : `Previous day · ${String(missedYesterday)} left to review`
              : '‹ Previous'}
          </Button>
          {narrow && !viewingEarlierDay ? null : (
            <Button
              variant="secondary"
              aria-label="Next day"
              disabled={nextDayDisabled}
              onClick={() => {
                onShiftDay(1);
              }}
            >
              Next ›
            </Button>
          )}
          {viewingEarlierDay ? (
            <>
              <Button variant="primary" onClick={onToday}>
                Back to today
              </Button>
              <Text as="span" variant="caption" tone="muted">
                Editing an earlier day.
              </Text>
            </>
          ) : null}
          {!narrow && missedYesterday > 0 ? (
            <Button variant="secondary" onClick={onReviewYesterday}>
              {`Yesterday: ${String(missedYesterday)} not done. Review`}
            </Button>
          ) : null}
        </div>
      ) : null}
      {screen === 'checkins' && !todayOnly ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            aria-label="Previous week"
            onClick={() => {
              onShiftWeek(-1);
            }}
          >
            Previous
          </Button>
          <Button variant="secondary" onClick={onThisWeek}>
            This week
          </Button>
          <Button
            variant="secondary"
            aria-label="Next week"
            onClick={() => {
              onShiftWeek(1);
            }}
          >
            Next
          </Button>
          {!compact && (
            <Text as="span" variant="caption" tone="muted">
              Tap a day to check in or correct it.
            </Text>
          )}
        </div>
      ) : null}
    </header>
  );
}
