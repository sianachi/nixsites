import { fireEvent, render, screen } from '@testing-library/react';
import { DateTime } from 'luxon';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RescheduleDialog } from '../../../calendar/reschedule-dialog';
import { useViewSuggestionPreference } from '@nix/web-foundation/lib/suggestion-preferences';
import { anItem } from '../../../testing/suggest-fixtures';

/**
 * The reschedule dialog's free-slot suggestion: found among the calendar's own items, offered in
 * working hours, and only ever a way to fill the fields - Move still makes the write.
 */

const ZONE = 'Europe/London';

function stamp(local: string): string {
  const moment = DateTime.fromISO(local, { zone: ZONE }).toISO({ suppressMilliseconds: true });
  return `${moment ?? ''}[${ZONE}]`;
}

beforeEach(() => {
  useViewSuggestionPreference.getState().setSetting('on');
  // Only the clock is faked, so the dialog's timers and the test's events behave normally.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(DateTime.fromISO('2026-10-01T08:00', { zone: ZONE }).toJSDate());
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the free slot in the reschedule dialog', () => {
  const item = anItem('Planning', {
    start: stamp('2026-10-01T09:00'),
    end: stamp('2026-10-01T10:00'),
  });
  const siblings = [
    item,
    anItem('Standup', { start: stamp('2026-10-01T09:00'), end: stamp('2026-10-01T10:30') }),
  ];

  it('offers the next free hour and fills the fields without moving anything', () => {
    const onMove = vi.fn();
    render(
      <RescheduleDialog
        item={item}
        dateProperty="start"
        endDateProperty="end"
        placesByTime
        zone={ZONE}
        siblings={siblings}
        onCancel={vi.fn()}
        onMove={onMove}
      />,
    );

    expect(screen.getByText(/Next free slot here/)).toHaveTextContent(
      'Next free slot here, in working hours: Thu 1 Oct, 10:30 to 11:30',
    );

    const use = screen.getByRole('button', { name: 'Use the free slot Thu 1 Oct, 10:30 to 11:30' });
    use.focus();
    fireEvent.click(use);

    expect(screen.getByLabelText('New date and time')).toHaveValue('2026-10-01T10:30');
    expect(screen.getByLabelText('New end date and time')).toHaveValue('2026-10-01T11:30');
    expect(onMove).not.toHaveBeenCalled();
    // The new start is where focus lands, so a screen reader hears the value that was filled in.
    expect(screen.getByLabelText('New date and time')).toHaveFocus();
  });

  it('works the slot out once, when the dialog opens', () => {
    const props = {
      item,
      dateProperty: 'start',
      endDateProperty: 'end',
      placesByTime: true,
      zone: ZONE,
      onCancel: vi.fn(),
      onMove: vi.fn(),
    };
    const { rerender } = render(<RescheduleDialog {...props} siblings={siblings} />);

    // A later render with the 10:30 slot taken must not move the suggestion under the reader.
    rerender(
      <RescheduleDialog
        {...props}
        siblings={[
          ...siblings,
          anItem('Review', { start: stamp('2026-10-01T10:30'), end: stamp('2026-10-01T12:00') }),
        ]}
      />,
    );

    expect(screen.getByText(/Next free slot here/)).toHaveTextContent('10:30 to 11:30');
  });

  it('is not offered when suggestions in views are switched off', () => {
    useViewSuggestionPreference.getState().setSetting('off');
    render(
      <RescheduleDialog
        item={item}
        dateProperty="start"
        endDateProperty="end"
        placesByTime
        zone={ZONE}
        siblings={siblings}
        onCancel={vi.fn()}
        onMove={vi.fn()}
      />,
    );

    expect(screen.queryByText(/Next free slot/)).not.toBeInTheDocument();
  });

  it('offers nothing for a calendar of days, or without the loaded items', () => {
    const { rerender } = render(
      <RescheduleDialog
        item={item}
        dateProperty="start"
        placesByTime={false}
        zone={ZONE}
        siblings={siblings}
        onCancel={vi.fn()}
        onMove={vi.fn()}
      />,
    );
    expect(screen.queryByText(/Next free slot/)).not.toBeInTheDocument();

    rerender(
      <RescheduleDialog
        item={item}
        dateProperty="start"
        placesByTime
        zone={ZONE}
        onCancel={vi.fn()}
        onMove={vi.fn()}
      />,
    );
    expect(screen.queryByText(/Next free slot/)).not.toBeInTheDocument();
  });
});
