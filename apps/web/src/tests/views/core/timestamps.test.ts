import { describe, expect, it } from 'vitest';

import type { Timestamp } from '../../../collections/core/timestamps';
import {
  dayFor,
  formatTime,
  minutesFor,
  readTimestampValue,
  writeTimestampValue,
} from '../../../collections/core/timestamps';

/**
 * Reading and writing a moment.
 *
 * **The assertions that matter are the ones about a reader in a different zone.** A timestamp
 * placed without being converted lands in whatever zone it was written in, which for somebody ten
 * hours away is the wrong day about half the time - and it is the kind of wrong that looks right
 * from wherever the author happened to be sitting.
 */

const LONDON_MORNING = '2026-03-17T09:00:00+00:00[Europe/London]';

/**
 * Reads a value that is expected to be readable.
 *
 * A `!` would turn a parse that unexpectedly failed into "cannot read properties of null" three
 * lines later. This says which value could not be read.
 */
function stored(value: string): Timestamp {
  const read = readTimestampValue({ at: value }, 'at');
  if (read === null) {
    throw new Error(`Expected "${value}" to read as a timestamp.`);
  }

  return read;
}

describe('reading a stored timestamp', () => {
  it('keeps the zone it was written in', () => {
    const read = stored(LONDON_MORNING);

    expect(read.zone).toBe('Europe/London');
    expect(formatTime(read, 'Europe/London')).toBe('09:00');
  });

  it('refuses a moment with no zone', () => {
    // An offset says what the clock read, not which rules it was following. Accepting one here
    // would silently disagree with the server, which refuses the same thing.
    for (const value of ['2026-03-17T09:00:00Z', '2026-03-17T09:00:00+00:00', '2026-03-17']) {
      expect(readTimestampValue({ at: value }, 'at')).toBeNull();
    }
  });

  it('refuses a zone that does not exist', () => {
    expect(readTimestampValue({ at: '2026-03-17T09:00:00+00:00[Middle/Earth]' }, 'at')).toBeNull();
  });

  it('refuses anything that is not a string', () => {
    for (const value of [42, true, null, { at: 'now' }, ['2026-03-17']]) {
      expect(readTimestampValue({ at: value }, 'at')).toBeNull();
    }
  });
});

describe('placing a timestamp for a reader', () => {
  it('puts it on the reader s day, not the author s', () => {
    // 09:00 in London on the 17th is 23:00 in Honolulu on the *16th*. A calendar that placed this
    // without converting would show it on the wrong day to half the world.
    const read = stored(LONDON_MORNING);

    expect(dayFor(read, 'Europe/London')).toBe('2026-03-17');
    expect(dayFor(read, 'Pacific/Honolulu')).toBe('2026-03-16');
  });

  it('puts it at the reader s time', () => {
    const read = stored(LONDON_MORNING);

    expect(formatTime(read, 'Pacific/Honolulu')).toBe('23:00');
    expect(minutesFor(read, 'Europe/London')).toBe(9 * 60);
    expect(minutesFor(read, 'Pacific/Honolulu')).toBe(23 * 60);
  });
});

describe('writing a timestamp', () => {
  it('derives the offset from the zone rather than being told it', () => {
    // London is on GMT in March and BST in July. The same wall time is a different moment in each,
    // and deriving the offset is what makes that impossible to get wrong.
    expect(writeTimestampValue('2026-03-17T09:00', 'Europe/London')).toBe(
      '2026-03-17T09:00:00+00:00[Europe/London]',
    );
    expect(writeTimestampValue('2026-07-17T09:00', 'Europe/London')).toBe(
      '2026-07-17T09:00:00+01:00[Europe/London]',
    );
  });

  it('round-trips through reading', () => {
    const written = writeTimestampValue('2026-07-17T14:30', 'Pacific/Honolulu');

    expect(written).not.toBeNull();
    const read = stored(written ?? '');

    expect(read.zone).toBe('Pacific/Honolulu');
    expect(formatTime(read, 'Pacific/Honolulu')).toBe('14:30');
  });

  it('refuses a wall time it cannot make sense of', () => {
    expect(writeTimestampValue('not a time', 'Europe/London')).toBeNull();
    expect(writeTimestampValue('2026-03-17T09:00', 'Middle/Earth')).toBeNull();
  });

  it('keeps the wall time across a clock change rather than the moment', () => {
    // The whole reason the zone is stored. Both of these are 09:00 to somebody in London, and they
    // are an hour apart as instants; keeping only the instant would turn a 09:00 standup into a
    // 10:00 one the day the clocks went forward.
    const march = stored(writeTimestampValue('2026-03-17T09:00', 'Europe/London') ?? '');
    const july = stored(writeTimestampValue('2026-07-17T09:00', 'Europe/London') ?? '');

    expect(formatTime(march, 'Europe/London')).toBe('09:00');
    expect(formatTime(july, 'Europe/London')).toBe('09:00');
    expect(march.at.toUTC().toFormat('HH:mm')).toBe('09:00');
    expect(july.at.toUTC().toFormat('HH:mm')).toBe('08:00');
  });
});
