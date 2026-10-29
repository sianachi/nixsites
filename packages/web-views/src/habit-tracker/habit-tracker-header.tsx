import { Button, cn, focusRing, Text } from '@nix/ui';
import type { ReactNode } from 'react';

/** The tracker's title, Today/Week/Insights switch, display options and week stepper. */
export function HabitTrackerHeader({
  screen,
  todayOnly,
  weekOffset,
  windowFrom,
  windowTo,
  showSetup,
  showArchived,
  onToday,
  onWeek,
  onInsights,
  onToggleSetup,
  onToggleArchived,
  onShiftWeek,
  onThisWeek,
}: {
  readonly screen: 'checkins' | 'insights';
  readonly todayOnly: boolean;
  readonly weekOffset: number;
  readonly windowFrom: string;
  readonly windowTo: string;
  readonly showSetup: boolean;
  readonly showArchived: boolean;
  readonly onToday: () => void;
  readonly onWeek: () => void;
  readonly onInsights: () => void;
  readonly onToggleSetup: () => void;
  readonly onToggleArchived: () => void;
  readonly onShiftWeek: (delta: -1 | 1) => void;
  readonly onThisWeek: () => void;
}): ReactNode {
  return (
    <header className="flex flex-col gap-4 border-b border-divider pb-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Text as="h2" variant="h4" id="habit-tracker-title">
            {screen === 'insights'
              ? 'Your progress'
              : todayOnly
                ? 'Today'
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
                ? 'One day at a time. Check in with your habits below.'
                : `${windowFrom} to ${windowTo}`}
          </Text>
        </div>
        <Button variant="secondary" onClick={onToggleSetup}>
          {showSetup ? 'Close setup' : 'Add a habit'}
        </Button>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav
          className="flex max-w-full flex-wrap gap-1 rounded-lg bg-surface-raised p-1"
          aria-label="Habit screens"
        >
          <Button
            variant={screen === 'checkins' && todayOnly ? 'primary' : 'ghost'}
            aria-pressed={screen === 'checkins' && todayOnly}
            onClick={onToday}
          >
            Today
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
        <details>
          <summary
            className={cn(
              'flex min-h-6 cursor-pointer items-center rounded-md px-2 py-1 text-sm text-muted any-pointer-coarse:min-h-(--control-lg)',
              focusRing,
            )}
          >
            Display options
          </summary>
          <Button variant="ghost" aria-pressed={showArchived} onClick={onToggleArchived}>
            {showArchived ? 'Hide archived' : 'Show archived'}
          </Button>
        </details>
      </div>
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
          <Button variant="ghost" onClick={onThisWeek}>
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
          <Text as="span" variant="caption" tone="muted">
            Tap a day to check in or correct it.
          </Text>
        </div>
      ) : null}
    </header>
  );
}
