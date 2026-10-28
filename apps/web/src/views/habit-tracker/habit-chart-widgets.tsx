import { Button, Field, Input, Select, Text, cn, focusRing } from '@nix/ui';
import type { HabitTracker } from '@nix/api-client';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ErrorPanel, LoadingPanel } from '../../components/states/status-panels';
import { formatShortDate } from '../../lib/date-format';
import { useHabits } from './use-habits';
import {
  HabitConsistency,
  habitDays,
  habitDayLabel,
  habitPeriodSummary,
  HabitQuantityTrend,
} from './habit-progress';

type HabitWidgetKind = 'completion' | 'quantity' | 'heatmap';

export interface HabitWidgetConfig {
  readonly id: string;
  readonly kind: HabitWidgetKind;
  readonly habitId: string;
  readonly from: string;
  readonly to: string;
}

export interface HabitChartWidgetsProps {
  readonly widgets: readonly HabitWidgetConfig[] | undefined;
  readonly trackers: ReadonlyMap<string, HabitTracker>;
  readonly availableHabits: readonly { readonly id: string; readonly title: string }[];
  readonly onChange: (widgets: readonly HabitWidgetConfig[]) => void;
  readonly renderDay?:
    ((habitId: string, day: string, tracker: HabitTracker) => ReactNode) | undefined;
}

const labels: Record<HabitWidgetKind, string> = {
  completion: 'Completion',
  quantity: 'Quantity',
  heatmap: 'Activity heatmap',
};

/** Embedded habit progress charts. Configuration is controlled so the parent can persist it with its view. */
export function HabitChartWidgets({
  widgets,
  trackers,
  availableHabits,
  onChange,
  renderDay,
}: HabitChartWidgetsProps): ReactNode {
  widgets ??= [];
  const [kind, setKind] = useState<HabitWidgetKind>('completion');
  const [habitId, setHabitId] = useState(availableHabits[0]?.id ?? '');
  const [range, setRange] = useState(30);
  const selectedHabitId = availableHabits.some((habit) => habit.id === habitId)
    ? habitId
    : (availableHabits[0]?.id ?? '');
  const add = () => {
    if (selectedHabitId === '') return;
    const timezone = trackers.get(selectedHabitId)?.timezone ?? 'UTC';
    const to = formatShortDate(new Date(), timezone);
    const fromDate = new Date(`${to}T00:00:00Z`);
    fromDate.setUTCDate(fromDate.getUTCDate() - range + 1);
    const from = fromDate.toISOString().slice(0, 10);
    if (range < 1 || range > 366 || widgets.length >= 12) return;
    onChange([...widgets, { id: crypto.randomUUID(), kind, habitId: selectedHabitId, from, to }]);
  };
  const remove = (id: string) => {
    onChange(widgets.filter((widget) => widget.id !== id));
  };
  const move = (index: number, direction: -1 | 1) => {
    const next = index + direction;
    if (next < 0 || next >= widgets.length) return;
    const copy = [...widgets];
    const current = copy[index];
    const replacement = copy[next];
    if (current === undefined || replacement === undefined) return;
    copy[index] = replacement;
    copy[next] = current;
    onChange(copy);
  };
  const update = (id: string, changes: Partial<HabitWidgetConfig>) => {
    const next = widgets.map((widget) => (widget.id === id ? { ...widget, ...changes } : widget));
    const changed = next.find((widget) => widget.id === id);
    if (changed !== undefined && validRange(changed.from, changed.to)) onChange(next);
  };

  return (
    <section
      className="@container flex min-w-0 flex-col gap-3"
      aria-labelledby="habit-chart-widgets-title"
    >
      <Text as="h3" variant="h3" id="habit-chart-widgets-title">
        Progress charts
      </Text>
      <details>
        <summary
          className={cn(
            'cursor-pointer rounded-sm py-1 any-pointer-coarse:min-h-(--control-lg)',
            focusRing,
          )}
        >
          <Text as="span" variant="bodySmall">
            Add a custom chart
          </Text>
        </summary>
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <label className="flex min-w-0 max-w-full flex-col gap-1">
            <Text variant="note" tone="muted" as="span">
              Chart
            </Text>
            <Select
              value={kind}
              onChange={(event) => {
                setKind(event.target.value as HabitWidgetKind);
              }}
            >
              {Object.entries(labels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </label>
          <label className="flex min-w-0 max-w-full flex-col gap-1">
            <Text variant="note" tone="muted" as="span">
              Habit
            </Text>
            <Select
              value={selectedHabitId}
              onChange={(event) => {
                setHabitId(event.target.value);
              }}
            >
              {availableHabits.map((habit) => (
                <option key={habit.id} value={habit.id}>
                  {habit.title}
                </option>
              ))}
            </Select>
          </label>
          <label className="flex min-w-0 max-w-full flex-col gap-1">
            <Text variant="note" tone="muted" as="span">
              Days
            </Text>
            <Select
              value={range}
              onChange={(event) => {
                setRange(Number(event.target.value));
              }}
            >
              {[7, 30, 90].map((days) => (
                <option key={days} value={days}>
                  {days}
                </option>
              ))}
            </Select>
          </label>
          <Button
            variant="secondary"
            onClick={add}
            disabled={selectedHabitId === '' || widgets.length >= 12}
          >
            Add chart
          </Button>
        </div>
      </details>
      {widgets.length === 0 ? (
        <Text variant="bodySmall" tone="muted">
          Add a chart to see progress over time.
        </Text>
      ) : null}
      {widgets.map((widget, index) => {
        const tracker = trackers.get(widget.habitId);
        return (
          <article key={widget.id} className="min-w-0 rounded-md border border-divider p-3">
            <header className="flex flex-wrap items-center justify-between gap-2">
              <Text as="h4" variant="body" className="font-medium">
                {labels[widget.kind]}
              </Text>
              <div className="flex flex-wrap gap-1">
                <Button
                  variant="ghost"
                  disabled={index === 0}
                  onClick={() => {
                    move(index, -1);
                  }}
                  aria-label="Move chart up"
                >
                  Up
                </Button>
                <Button
                  variant="ghost"
                  disabled={index === widgets.length - 1}
                  onClick={() => {
                    move(index, 1);
                  }}
                  aria-label="Move chart down"
                >
                  Down
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    remove(widget.id);
                  }}
                >
                  Remove
                </Button>
              </div>
            </header>
            <details>
              <summary
                className={cn(
                  'cursor-pointer rounded-sm py-1 any-pointer-coarse:min-h-(--control-lg)',
                  focusRing,
                )}
              >
                <Text as="span" variant="caption">
                  Edit chart settings
                </Text>
              </summary>
              <div className="flex flex-wrap items-end gap-2 py-2">
                <label className="flex min-w-0 max-w-full flex-col gap-1">
                  <Text variant="note" tone="muted" as="span">
                    Chart
                  </Text>
                  <Select
                    value={widget.kind}
                    onChange={(event) => {
                      update(widget.id, { kind: event.target.value as HabitWidgetKind });
                    }}
                  >
                    {Object.entries(labels).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </Select>
                </label>
                <label className="flex min-w-0 max-w-full flex-col gap-1">
                  <Text variant="note" tone="muted" as="span">
                    Habit
                  </Text>
                  <Select
                    value={widget.habitId}
                    onChange={(event) => {
                      update(widget.id, { habitId: event.target.value });
                    }}
                  >
                    {availableHabits.map((habit) => (
                      <option key={habit.id} value={habit.id}>
                        {habit.title}
                      </option>
                    ))}
                  </Select>
                </label>
                <Field label="From">
                  {(control) => (
                    <Input
                      {...control}
                      className="w-40"
                      type="date"
                      value={widget.from}
                      onChange={(event) => {
                        update(widget.id, { from: event.target.value });
                      }}
                    />
                  )}
                </Field>
                <Field label="To">
                  {(control) => (
                    <Input
                      {...control}
                      className="w-40"
                      type="date"
                      value={widget.to}
                      onChange={(event) => {
                        update(widget.id, { to: event.target.value });
                      }}
                    />
                  )}
                </Field>
              </div>
            </details>
            <WidgetData widget={widget} refreshKey={tracker} renderDay={renderDay} />
          </article>
        );
      })}
    </section>
  );
}

function WidgetData({
  widget,
  refreshKey,
  renderDay,
}: {
  readonly widget: HabitWidgetConfig;
  readonly refreshKey: HabitTracker | undefined;
  readonly renderDay: HabitChartWidgetsProps['renderDay'];
}): ReactNode {
  const [selected, setSelected] = useState<string | null>(null);
  // Stable identity keeps unrelated editor changes from restarting this range query.
  const ids = useMemo(() => [widget.habitId], [widget.habitId]);
  const state = useHabits(ids, widget.from, widget.to);
  const { reload } = state;
  useEffect(() => {
    if (refreshKey !== undefined) reload();
    // The parent tracker identity changes after a successful check-in/settings mutation. The
    // widget owns a separate range query, so explicitly revalidate it at that boundary.
  }, [refreshKey, reload]);
  if (state.status === 'loading') return <LoadingPanel label="chart data" />;
  if (state.status === 'error') {
    return (
      <ErrorPanel
        title="Chart data could not be loaded"
        detail={state.error ?? 'Try again to reload this chart.'}
        action={
          <Button variant="secondary" onClick={state.reload}>
            Try again
          </Button>
        }
      />
    );
  }
  const tracker = state.trackers.get(widget.habitId);
  return tracker === undefined ? (
    <Text variant="bodySmall" tone="muted">
      This habit is unavailable for the selected range.
    </Text>
  ) : (
    <Chart
      widget={widget}
      tracker={tracker}
      selected={selected}
      onSelect={setSelected}
      renderDay={renderDay}
    />
  );
}

function Chart({
  widget,
  tracker,
  selected,
  onSelect,
  renderDay,
}: {
  readonly widget: HabitWidgetConfig;
  readonly tracker: HabitTracker;
  readonly selected: string | null;
  readonly onSelect: (day: string | null) => void;
  readonly renderDay: HabitChartWidgetsProps['renderDay'];
}): ReactNode {
  const today = formatShortDate(new Date(), tracker.timezone);
  const days = habitDays(tracker, widget.from, widget.to, today);
  if (widget.kind === 'heatmap' || widget.kind === 'quantity') {
    const selectedEntry = days.find((day) => day.date === selected);
    return (
      <div className="flex flex-col gap-4">
        {widget.kind === 'heatmap' ? (
          <HabitConsistency
            days={days}
            selected={selected}
            onSelect={onSelect}
            editable={renderDay !== undefined}
          />
        ) : (
          <HabitQuantityTrend
            days={days}
            unit={tracker.unit}
            onSelect={onSelect}
            editable={renderDay !== undefined}
          />
        )}
        {selectedEntry === undefined ? null : (
          <div className="border-t border-divider pt-4" aria-label="Selected chart day">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <Text as="h4" variant="h4">
                Check-in for {selectedEntry.date}
              </Text>
              <Button
                variant="ghost"
                onClick={() => {
                  onSelect(null);
                }}
              >
                Close day
              </Button>
            </div>
            {renderDay === undefined ? (
              <Text variant="bodySmall">{habitDayLabel(selectedEntry)}</Text>
            ) : (
              renderDay(widget.habitId, selectedEntry.date, tracker)
            )}
          </div>
        )}
      </div>
    );
  }
  const values = tracker.weeks.map((week) => {
    const start = new Date(`${week.weekStart}T00:00:00Z`);
    start.setUTCDate(start.getUTCDate() + 6);
    const end = start.toISOString().slice(0, 10);
    const summary = habitPeriodSummary(
      days.filter((day) => day.date >= week.weekStart && day.date <= end),
      today,
    );
    return {
      label: week.weekStart,
      value: summary.rate,
      completed: summary.completed,
      planned: summary.planned,
    };
  });
  return (
    <div className="mt-4 flex flex-col gap-3" aria-label="Weekly completion chart">
      <Text variant="caption" tone="muted">
        Share of elapsed scheduled days completed
      </Text>
      {values.length === 0 ? (
        <Text variant="bodySmall" tone="muted">
          No scheduled history in this range.
        </Text>
      ) : null}
      {values.map((value) => (
        <div key={value.label} className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <Text variant="caption" tone="muted" className="min-w-0 flex-1 @sm:w-24 @sm:flex-none">
            {value.label}
          </Text>
          <span
            className="order-last h-3 w-full rounded-full bg-surface-raised @sm:order-none @sm:w-auto @sm:flex-1"
            aria-hidden="true"
          >
            <DataBar value={(value.value ?? 0) * 100} maximum={100} />
          </span>
          <Text variant="bodySmall" className="shrink-0 text-right @sm:w-20">
            {value.value === null ? '—' : `${String(Math.round(value.value * 100))}%`}
          </Text>
          <Text variant="caption" tone="muted">
            {value.completed}/{value.planned}
          </Text>
        </div>
      ))}
    </div>
  );
}

function validRange(from: string, to: string): boolean {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  return (
    Number.isFinite(start) &&
    Number.isFinite(end) &&
    end >= start &&
    end - start <= 365 * 86_400_000
  );
}

function DataBar({
  value,
  maximum,
}: {
  readonly value: number;
  readonly maximum: number;
}): ReactNode {
  const width = `${String((value / maximum) * 100)}%`;
  return <span className="block h-3 rounded-full bg-accent-fill" style={{ width }} />; // design-token-exempt: width encodes the data percentage rather than a chosen design dimension.
}
