import { describe, expect, it } from 'vitest';

import { formatClock } from '../../audio/clock';

/** The clock face of the audio player: a wrong digit here is read aloud by the slider's label. */
describe('formatClock', () => {
  it.each([
    [0, '0:00'],
    [7, '0:07'],
    [247, '4:07'],
    [3600, '1:00:00'],
    [3729, '1:02:09'],
    [59.9, '0:59'],
  ])('reads %s seconds as %s', (seconds, expected) => {
    expect(formatClock(seconds)).toBe(expected);
  });

  it('shows zero for a duration the file has not yet reported', () => {
    expect(formatClock(Number.NaN)).toBe('0:00');
    expect(formatClock(Number.POSITIVE_INFINITY)).toBe('0:00');
    expect(formatClock(-5)).toBe('0:00');
  });
});
