import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';

import {
  durationOf,
  nextHalfHour,
  suggestSlot,
  workingWindows,
} from '../../../calendar/schedule-slot';
import { anItem } from '../../../testing/suggest-fixtures';

const ZONE = 'Europe/London';

function at(local: string): number {
  return DateTime.fromISO(local, { zone: ZONE }).toMillis();
}

function stamp(local: string): string {
  const moment = DateTime.fromISO(local, { zone: ZONE }).toISO({ suppressMilliseconds: true });
  return `${moment ?? ''}[${ZONE}]`;
}

describe('the calendar free slot', () => {
  it('builds weekday working windows only', () => {
    // Thursday 2026-10-01.
    const windows = workingWindows(at('2026-10-01T08:00'), ZONE);
    const days = windows.map((window) =>
      DateTime.fromMillis(window.start, { zone: ZONE }).toFormat('ccc HH:mm'),
    );
    expect(days.slice(0, 3)).toEqual(['Thu 09:00', 'Fri 09:00', 'Mon 09:00']);
  });

  it('rounds up to the next half hour', () => {
    expect(nextHalfHour(at('2026-10-01T10:07'), ZONE)).toBe(at('2026-10-01T10:30'));
    expect(nextHalfHour(at('2026-10-01T10:31'), ZONE)).toBe(at('2026-10-01T11:00'));
    expect(nextHalfHour(at('2026-10-01T10:30'), ZONE)).toBe(at('2026-10-01T10:30'));
  });

  it('takes the item’s own span as its duration, else an hour', () => {
    const spanned = anItem('Workshop', {
      start: stamp('2026-10-05T09:00'),
      end: stamp('2026-10-05T11:00'),
    });
    expect(durationOf(spanned, 'start', 'end')).toBe(2 * 60 * 60 * 1000);
    expect(durationOf(anItem('Loose'), 'start', 'end')).toBe(60 * 60 * 1000);
  });

  it('finds the first gap after the loaded events, ignoring the item itself', () => {
    const item = anItem('Move me', { start: stamp('2026-10-01T09:00') });
    const siblings = [
      item,
      anItem('Standup', { start: stamp('2026-10-01T09:00'), end: stamp('2026-10-01T10:00') }),
      anItem('Review', { start: stamp('2026-10-01T10:00') }),
    ];
    const slot = suggestSlot(item, siblings, 'start', 'end', at('2026-10-01T08:00'), ZONE);
    expect(slot).toEqual({
      start: '2026-10-01T11:00',
      end: '2026-10-01T12:00',
      label: 'Thu 1 Oct, 11:00 to 12:00',
    });
  });

  it('moves to the next working day after hours', () => {
    const item = anItem('Late');
    const slot = suggestSlot(item, [], 'start', null, at('2026-10-02T18:00'), ZONE);
    expect(slot?.start).toBe('2026-10-05T09:00');
  });
});
