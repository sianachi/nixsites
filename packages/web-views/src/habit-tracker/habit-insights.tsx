import type { HabitTracker } from '@nix/api-client';
import { Button, Field, Input, Select, Text } from '@nix/ui';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ErrorPanel, LoadingPanel } from '@nix/web-foundation/components/states/status-panels';
import { formatCalendarDay, formatShortDate } from '@nix/web-foundation/lib/date-format';
import { YearGrid } from '../chart/year-grid';
import {
  HabitConsistency,
  habitDayLabel,
  habitDays,
  habitPeriodSummary,
  HabitQuantityTrend,
  rollingHabitWindow,
  shiftHabitDay,
} from './habit-progress';
import { useHabits } from './use-habits';

interface Habit {
  readonly id: string;
  readonly title: string;
  readonly tracker: HabitTracker;
}

export function HabitInsights({
  habits,
  renderDay,
}: {
  readonly habits: readonly Habit[];
  readonly renderDay: (habit: Habit, day: string, tracker: HabitTracker) => ReactNode;
}): ReactNode {
  const [habitId, setHabitId] = useState(habits[0]?.id ?? '');
  const [range, setRange] = useState<number | 'year'>(30);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const habit = habits.find((candidate) => candidate.id === habitId) ?? habits[0];
  const today = formatShortDate(new Date(), habit?.tracker.timezone ?? 'UTC');
  const window = rollingHabitWindow(today, range);
  // Only the selected habit is requested, and only while Insights is open.
  const selectedHabitId = habit?.id;
  const ids = useMemo(
    () => (selectedHabitId === undefined ? [] : [selectedHabitId]),
    [selectedHabitId],
  );
  const state = useHabits(ids, window.from, window.to);
  const previous = useHabits(ids, window.previousFrom, window.previousTo);
  // The year grid's own read: the longest range the habit endpoint serves, 366 days to today.
  const yearFrom = shiftHabitDay(today, -365);
  const year = useHabits(ids, yearFrom, today);
  const refreshKey = habit?.tracker;
  const { reload } = state;
  const { reload: reloadPrevious } = previous;
  const { reload: reloadYear } = year;
  useEffect(() => {
    if (refreshKey !== undefined) {
      reload();
      reloadPrevious();
      reloadYear();
    }
  }, [refreshKey, reload, reloadPrevious, reloadYear]);
  const yearTracker = habit === undefined ? undefined : year.trackers.get(habit.id);
  const yearDays = yearTracker === undefined ? [] : habitDays(yearTracker, yearFrom, today, today);
  const tracker = habit === undefined ? undefined : state.trackers.get(habit.id);
  const previousTracker = habit === undefined ? undefined : previous.trackers.get(habit.id);
  const days = tracker === undefined ? [] : habitDays(tracker, window.from, window.to, today);
  const summary = habitPeriodSummary(days, today);
  const prior =
    previousTracker === undefined
      ? null
      : habitPeriodSummary(
          habitDays(previousTracker, window.previousFrom, window.previousTo, today),
          today,
        );
  const difference =
    previous.status !== 'ready' ||
    summary.rate === null ||
    prior?.rate === null ||
    prior?.rate === undefined
      ? null
      : Math.round((summary.rate - prior.rate) * 100);
  return (
    <section className="flex min-w-0 flex-col gap-6" aria-label="Habit insights">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <Field label="Habit to explore" className="min-w-0 max-w-full">
          {(control) => (
            <Select
              {...control}
              value={habit?.id ?? ''}
              onChange={(event) => {
                setHabitId(event.target.value);
                setSelectedDay(null);
              }}
            >
              {habits.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.title || 'Untitled habit'}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Progress range" className="min-w-0 max-w-full">
          {(control) => (
            <Select
              {...control}
              value={range}
              onChange={(event) => {
                setRange(event.target.value === 'year' ? 'year' : Number(event.target.value));
                setSelectedDay(null);
              }}
            >
              <option value="7">Last 7 days</option>
              <option value="30">Last 30 days</option>
              <option value="90">Last 90 days</option>
              <option value="year">This year</option>
            </Select>
          )}
        </Field>
      </div>
      {state.status === 'loading' ? <LoadingPanel label="habit progress" /> : null}
      {state.status === 'error' ? (
        <ErrorPanel
          title="Progress could not be loaded"
          detail={state.error ?? 'Try again.'}
          action={<Button onClick={state.reload}>Retry</Button>}
        />
      ) : null}
      {state.status !== 'loading' && state.status !== 'error' && tracker !== undefined ? (
        <>
          <div
            className="flex flex-wrap gap-x-8 gap-y-4 border-b border-divider pb-4"
            aria-label="Progress summary"
          >
            <div>
              <Text variant="caption" tone="muted">
                Scheduled days completed
              </Text>
              <Text variant="h2">
                {summary.rate === null ? '—' : `${String(Math.round(summary.rate * 100))}%`}
              </Text>
              <Text variant="bodySmall" tone="muted">
                {summary.completed} of {summary.planned} elapsed days
                {days.some((day) => day.date === today && day.scheduled && !day.completed)
                  ? '; today is still in progress'
                  : ''}
              </Text>
            </div>
            <div>
              <Text variant="caption" tone="muted">
                Current streak
              </Text>
              <Text variant="h2">{tracker.progress?.currentStreak ?? 0} days</Text>
              <Text variant="bodySmall" tone="muted">
                Best: {tracker.progress?.bestStreak ?? 0} days
              </Text>
            </div>
            <div>
              <Text variant="caption" tone="muted">
                Previous period
              </Text>
              <Text variant="h2">
                {previous.status === 'loading'
                  ? 'Loading'
                  : difference === null
                    ? '—'
                    : difference === 0
                      ? 'Unchanged'
                      : `${difference > 0 ? '+' : ''}${String(difference)} pts`}
              </Text>
              <Text variant="bodySmall" tone="muted">
                {previous.status === 'error'
                  ? 'Comparison unavailable'
                  : difference === null
                    ? 'More scheduled history is needed'
                    : `Compared with ${window.previousFrom} to ${window.previousTo}`}
              </Text>
            </div>
          </div>
          <div className="flex flex-col gap-4">
            <div>
              <Text as="h3" variant="h3">
                Consistency
              </Text>
              <Text variant="bodySmall" tone="muted">
                {window.from} to {window.to}. Filled days show your progress.
              </Text>
            </div>
            <HabitConsistency days={days} selected={selectedDay} onSelect={setSelectedDay} />
          </div>
          <div className="flex flex-wrap items-end gap-3 border-y border-divider py-4">
            <Field
              label="Inspect or correct a day"
              hint="Pick a date or select it in the calendar."
              className="min-w-0 max-w-full"
            >
              {(control) => (
                <Input
                  {...control}
                  type="date"
                  min={window.from}
                  max={window.to}
                  value={selectedDay ?? ''}
                  onChange={(event) => {
                    setSelectedDay(event.target.value || null);
                  }}
                />
              )}
            </Field>
            {selectedDay !== null ? (
              <Button
                variant="ghost"
                onClick={() => {
                  setSelectedDay(null);
                }}
              >
                Close day
              </Button>
            ) : null}
            {selectedDay !== null &&
            selectedDay >= window.from &&
            selectedDay <= window.to &&
            habit !== undefined ? (
              <div className="w-full">
                <Text as="h3" variant="h3">
                  Check-in for {selectedDay}
                </Text>
                {renderDay(habit, selectedDay, tracker)}
              </div>
            ) : null}
          </div>
          <div className="flex flex-col gap-4">
            <div>
              <Text as="h3" variant="h3">
                Year at a glance
              </Text>
              <Text variant="bodySmall" tone="muted">
                {formatCalendarDay(yearFrom) ?? yearFrom} to {formatCalendarDay(today) ?? today}.
                Stronger days recorded more; empty days recorded nothing.
              </Text>
            </div>
            {year.status === 'loading' ? <LoadingPanel label="the year" /> : null}
            {year.status === 'error' ? (
              <ErrorPanel
                title="The year could not be loaded"
                detail={year.error ?? 'Try again.'}
                action={<Button onClick={year.reload}>Try again</Button>}
              />
            ) : null}
            {year.status !== 'loading' && year.status !== 'error' ? (
              <YearGrid
                label={`${habit === undefined || habit.title === '' ? 'Habit' : habit.title}, the last year`}
                unit={tracker.target !== 1 || tracker.unit !== 'times' ? tracker.unit : 'check-ins'}
                cells={yearDays.map((day) => ({
                  date: day.date,
                  // A quantity where one was recorded, otherwise a completed check-in counts once.
                  // Unscheduled and upcoming days are empty, never zero-valued misses.
                  value:
                    day.state === 'upcoming' || day.state === 'unscheduled'
                      ? null
                      : (day.quantity ?? (day.completed ? 1 : 0)),
                  label: habitDayLabel(day),
                }))}
              />
            ) : null}
          </div>
          {tracker.target !== 1 || tracker.unit !== 'times' ? (
            <div className="flex flex-col gap-4">
              <div>
                <Text as="h3" variant="h3">
                  Recorded {tracker.unit}
                </Text>
                <Text variant="bodySmall" tone="muted">
                  Actual amounts against your target. Zero is a recorded value; a gap means no
                  amount.
                </Text>
              </div>
              <HabitQuantityTrend days={days} unit={tracker.unit} onSelect={setSelectedDay} />
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
