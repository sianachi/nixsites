import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HabitTracker } from '@nix/api-client';
import { HabitChartWidgets } from '../../../habit-tracker/habit-chart-widgets';

vi.mock('../../../habit-tracker/use-habits', () => ({
  useHabits: () => ({
    status: 'ready',
    trackers: new Map([[tracker.habitId, loadedTracker ?? tracker]]),
    error: null,
    reload: vi.fn(),
  }),
}));

let loadedTracker: HabitTracker | undefined;
const tracker: HabitTracker = {
  habitId: '11111111-1111-4111-8111-111111111111',
  frequency: 'daily' as const,
  weekdays: [],
  timezone: 'UTC',
  startDate: '2026-01-01',
  target: 1,
  unit: 'pages',
  checkIns: [],
  weeks: [],
  status: 'active' as const,
  occurrences: null,
  progress: null,
  months: null,
  reminderTime: null,
};

describe('habit chart widgets', () => {
  beforeEach(() => {
    loadedTracker = undefined;
  });
  it('adds a selected chart and edits its date range', () => {
    const onChange = vi.fn();
    render(
      <HabitChartWidgets
        widgets={[]}
        trackers={new Map([[tracker.habitId, tracker]])}
        availableHabits={[{ id: tracker.habitId, title: 'Read' }]}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByText('Add a custom chart'));
    fireEvent.click(screen.getByRole('button', { name: 'Add chart' }));
    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({ kind: 'completion', habitId: tracker.habitId }),
    ]);
  });

  it('removes an existing chart and exposes range editing', () => {
    const onChange = vi.fn();
    render(
      <HabitChartWidgets
        widgets={[
          {
            id: 'w1',
            kind: 'quantity',
            habitId: tracker.habitId,
            from: '2026-03-01',
            to: '2026-03-30',
          },
        ]}
        trackers={new Map([[tracker.habitId, tracker]])}
        availableHabits={[{ id: tracker.habitId, title: 'Read' }]}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByText('Edit chart settings'));
    expect(screen.getByLabelText('From')).toHaveValue('2026-03-01');
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });
  it('opens the shared historical editor when a quantity value is selected', () => {
    loadedTracker = {
      ...tracker,
      checkIns: [{ id: 'entry', occurredOn: '2026-03-16', completed: true, quantity: 3 }],
    };
    const renderDay = vi.fn((_habitId: string, day: string) => (
      <button type="button">Save correction for {day}</button>
    ));
    render(
      <HabitChartWidgets
        widgets={[
          {
            id: 'quantity',
            kind: 'quantity',
            habitId: tracker.habitId,
            from: '2026-03-16',
            to: '2026-03-17',
          },
        ]}
        trackers={new Map([[tracker.habitId, loadedTracker]])}
        availableHabits={[{ id: tracker.habitId, title: 'Read' }]}
        onChange={vi.fn()}
        renderDay={renderDay}
      />,
    );
    fireEvent.click(screen.getByText('Daily values and corrections'));
    fireEvent.click(
      screen.getByRole('button', { name: 'Edit 2026-03-16: Completed, 3 of 1 pages' }),
    );
    expect(screen.getByRole('button', { name: 'Save correction for 2026-03-16' })).toBeVisible();
    expect(renderDay).toHaveBeenCalledWith(tracker.habitId, '2026-03-16', loadedTracker);
    fireEvent.click(screen.getByRole('button', { name: 'Close day' }));
    expect(
      screen.queryByRole('button', { name: 'Save correction for 2026-03-16' }),
    ).not.toBeInTheDocument();
  });

  it('opens the same editor from a custom consistency calendar', () => {
    const renderDay = vi.fn((_habitId: string, day: string) => (
      <button type="button">Save correction for {day}</button>
    ));
    render(
      <HabitChartWidgets
        widgets={[
          {
            id: 'heatmap',
            kind: 'heatmap',
            habitId: tracker.habitId,
            from: '2026-03-16',
            to: '2026-03-17',
          },
        ]}
        trackers={new Map([[tracker.habitId, tracker]])}
        availableHabits={[{ id: tracker.habitId, title: 'Read' }]}
        onChange={vi.fn()}
        renderDay={renderDay}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '2026-03-16: No check-in' }));
    expect(screen.getByRole('button', { name: 'Save correction for 2026-03-16' })).toBeVisible();
    expect(renderDay).toHaveBeenCalledWith(tracker.habitId, '2026-03-16', tracker);
  });

  it('uses inspection wording and shows the selected value when no editor is supplied', () => {
    loadedTracker = {
      ...tracker,
      checkIns: [{ id: 'entry', occurredOn: '2026-03-16', completed: true, quantity: 3 }],
    };
    render(
      <HabitChartWidgets
        widgets={[
          {
            id: 'quantity',
            kind: 'quantity',
            habitId: tracker.habitId,
            from: '2026-03-16',
            to: '2026-03-17',
          },
        ]}
        trackers={new Map([[tracker.habitId, loadedTracker]])}
        availableHabits={[{ id: tracker.habitId, title: 'Read' }]}
        onChange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText('Daily values'));
    expect(screen.queryByRole('button', { name: /^Edit / })).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', { name: 'Inspect 2026-03-16: Completed, 3 of 1 pages' }),
    );
    expect(screen.getByLabelText('Selected chart day')).toHaveTextContent(
      '2026-03-16: Completed, 3 of 1 pages',
    );
  });
});
