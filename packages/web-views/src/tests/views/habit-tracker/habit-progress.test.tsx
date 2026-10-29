import { fireEvent, render, screen } from '@testing-library/react';
import type { HabitTracker } from '@nix/api-client';
import { describe, expect, it, vi } from 'vitest';
import {
  HabitConsistency,
  habitDays,
  habitPeriodSummary,
  HabitQuantityTrend,
  rollingHabitWindow,
} from '../../../habit-tracker/habit-progress';

const tracker: HabitTracker = {
  habitId: 'habit',
  frequency: 'daily',
  weekdays: [],
  timezone: 'UTC',
  startDate: '2026-03-01',
  target: 8,
  unit: 'glasses',
  reminderTime: null,
  status: 'active',
  weeks: [],
  occurrences: null,
  progress: null,
  months: null,
  checkIns: [
    { id: 'zero', occurredOn: '2026-03-16', completed: false, quantity: 0 },
    { id: 'partial', occurredOn: '2026-03-17', completed: false, quantity: 5 },
  ],
};

describe('habit progress history', () => {
  it('uses inclusive rolling ranges and equal previous periods across month/year boundaries', () => {
    expect(rollingHabitWindow('2026-01-03', 7)).toEqual({
      from: '2025-12-28',
      to: '2026-01-03',
      previousFrom: '2025-12-21',
      previousTo: '2025-12-27',
    });
    expect(rollingHabitWindow('2024-12-31', 'year')).toEqual({
      from: '2024-01-01',
      to: '2024-12-31',
      previousFrom: '2022-12-31',
      previousTo: '2023-12-31',
    });
  });

  it('preserves recorded zero and missing amounts, and does not call future days missed', () => {
    const days = habitDays(tracker, '2026-03-16', '2026-03-20', '2026-03-18');
    expect(days.map((day) => [day.quantity, day.state])).toEqual([
      [0, 'missed'],
      [5, 'partial'],
      [null, 'scheduled'],
      [null, 'upcoming'],
      [null, 'upcoming'],
    ]);
    expect(habitPeriodSummary(days, '2026-03-18')).toEqual({
      planned: 2,
      completed: 0,
      rate: 0,
      recorded: 2,
      quantity: 5,
    });
  });

  it('uses saved occurrence schedules and targets rather than applying current settings to history', () => {
    const days = habitDays(
      {
        ...tracker,
        target: 10,
        occurrences: [
          {
            date: '2026-03-16',
            scheduled: false,
            completed: false,
            quantity: null,
            target: 4,
            unit: 'glasses',
            state: 'unscheduled',
          },
        ],
      },
      '2026-03-16',
      '2026-03-16',
      '2026-03-18',
    );
    expect(days[0]).toMatchObject({ scheduled: false, state: 'unscheduled', target: 4 });
    expect(habitPeriodSummary(days, '2026-03-18').rate).toBeNull();
  });

  it('selects a historical day and supports arrow navigation with one initial tab stop', () => {
    const days = habitDays(tracker, '2026-03-16', '2026-03-20', '2026-03-18');
    const onSelect = vi.fn();
    render(<HabitConsistency days={days} onSelect={onSelect} />);
    const first = screen.getByRole('button', { name: '2026-03-16: No check-in, 0 of 8 glasses' });
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowDown' });
    const second = screen.getByRole('button', { name: '2026-03-17: Partly done, 5 of 8 glasses' });
    expect(second).toHaveFocus();
    fireEvent.click(second);
    expect(onSelect).toHaveBeenCalledWith('2026-03-17');
    expect(screen.getAllByRole('button').filter((button) => button.tabIndex === 0)).toHaveLength(1);
  });

  it('gives the quantity graph a unit, target and explicit missing-data meaning with accessible daily correction actions', () => {
    const days = habitDays(tracker, '2026-03-16', '2026-03-18', '2026-03-18');
    const onSelect = vi.fn();
    render(<HabitQuantityTrend days={days} unit="glasses" onSelect={onSelect} />);
    expect(
      screen.getByRole('img', { name: /Recorded glasses over time. Target 8 glasses/ }),
    ).toBeVisible();
    fireEvent.click(screen.getByText('Daily values and corrections'));
    fireEvent.click(
      screen.getByRole('button', { name: 'Edit 2026-03-16: No check-in, 0 of 8 glasses' }),
    );
    expect(onSelect).toHaveBeenCalledWith('2026-03-16');
    expect(screen.getByRole('button', { name: 'Edit 2026-03-18: Due today' })).toHaveTextContent(
      'No amount recorded',
    );
  });
});
