import { act, renderHook, waitFor } from '@testing-library/react';
import type { HabitTracker } from '@nix/api-client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useHabits } from '../../../views/habit-tracker/use-habits';

const query = vi.fn<() => Promise<HabitTracker>>();
const client = { query };
vi.mock('@nix/web-platform/api/api-client-provider', () => ({ useApiClient: () => client }));
const tracker: HabitTracker = {
  habitId: 'read',
  frequency: 'daily',
  weekdays: [],
  timezone: 'UTC',
  startDate: '2026-03-01',
  target: 1,
  unit: 'times',
  reminderTime: null,
  status: 'active',
  checkIns: [],
  weeks: [],
  occurrences: null,
  progress: null,
  months: null,
};
const ids = ['read'];

describe('habit refresh feedback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    query.mockResolvedValue(tracker);
  });
  it('marks retained totals as partial when a saved habit cannot be refreshed', async () => {
    const { result } = renderHook(() => useHabits(ids, '2026-03-16', '2026-03-22'));
    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
    query.mockRejectedValueOnce(new Error('Connection lost.'));
    await act(async () => {
      await result.current.refetchHabit('read');
    });
    expect(result.current.status).toBe('partial');
    expect(result.current.error).toContain('Reload to verify the latest totals');
    expect(result.current.trackers.get('read')).toBe(tracker);
    expect(result.current.refreshingIds.size).toBe(0);
  });
  it('refreshes one tracker without a full reload generation and keeps its loading flag until the read resolves', async () => {
    const { result } = renderHook(() => useHabits(ids, '2026-03-16', '2026-03-22'));
    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
    let resolveRead: (tracker: HabitTracker) => void = () => undefined;
    query.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve;
        }),
    );
    let refresh: Promise<string | null> | undefined;
    act(() => {
      refresh = result.current.refetchHabit('read');
    });
    expect(result.current.refreshingIds.has('read')).toBe(true);
    const changed = { ...tracker, target: 2 };
    await act(async () => {
      resolveRead(changed);
      await refresh;
    });
    expect(result.current.trackers.get('read')).toBe(changed);
    expect(result.current.version).toBe(0);
    expect(query).toHaveBeenCalledTimes(2);
    expect(result.current.refreshingIds.size).toBe(0);
  });
});
