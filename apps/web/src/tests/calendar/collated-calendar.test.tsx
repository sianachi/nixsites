import type { CalendarEntry } from '@nix/api-client';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CollatedCalendar } from '../../calendar/collated-calendar';
import type { CalendarDay } from '@nix/web-collections/core/calendar-dates';

/**
 * Creating a dated entry from the collated calendar, at the component's own layer.
 *
 * `use-workspace-calendar.test.ts` proves the property a create actually writes is resolved from
 * the chosen container's own view configuration, never from a calendar entry. These tests are about
 * the other half of goal 3.10: what the person is offered, what they are told when nothing
 * qualifies, and what the screen looks like when a create is refused. `onCreate` is a stub here on
 * purpose - this component never resolves a property itself, so nothing it does could leak one from
 * whatever entries happen to be on screen. That is provable from its own type signature:
 * `onCreate(containerId, title, day)` has no property parameter to leak in the first place.
 */

process.env.TZ = 'Pacific/Honolulu';

const CONTAINER_ONE = 'cccccccc-3333-4333-8333-cccccccccccc';
const CONTAINER_TWO = 'dddddddd-4444-4444-8444-dddddddddddd';

const MARCH: CalendarDay = { year: 2026, month: 2, day: 17 };
const APRIL: CalendarDay = { year: 2026, month: 3, day: 5 };

const MARCH_ENTRIES: readonly CalendarEntry[] = [
  {
    itemId: 'a1',
    title: 'Filing deadline',
    containerId: CONTAINER_ONE,
    containerTitle: 'Deadlines',
    dateProperty: 'due',
    value: '2026-03-12',
    kind: 'date',
    // A stored entry, not one a rule produced.
    generated: false,
    endProperty: null,
    endValue: null,
    completed: null,
  },
  {
    itemId: 'a2',
    title: 'Standup',
    containerId: CONTAINER_TWO,
    containerTitle: 'Sessions',
    dateProperty: 'starts',
    value: '2026-03-17T09:00:00+00:00[Europe/London]',
    kind: 'timestamp',
    // A stored entry, not one a rule produced.
    generated: false,
    endProperty: null,
    endValue: null,
    completed: null,
  },
];

/** A different window's entries - same containers, a value that would mislead a guess. */
const APRIL_ENTRIES: readonly CalendarEntry[] = [
  {
    itemId: 'b1',
    title: 'Renewal',
    containerId: CONTAINER_ONE,
    containerTitle: 'Deadlines',
    dateProperty: 'due',
    value: '2026-04-09',
    kind: 'date',
    // A stored entry, not one a rule produced.
    generated: false,
    endProperty: null,
    endValue: null,
    completed: null,
  },
];

function noop(): void {
  // Intentionally does nothing - these props are exercised elsewhere in this suite.
}

function renderCalendar(
  entries: readonly CalendarEntry[],
  anchor: CalendarDay,
  onCreate?: (containerId: string, title: string, day: string) => Promise<string | null>,
): ReturnType<typeof render> {
  return render(
    <CollatedCalendar
      entries={entries}
      grain="month"
      onGrain={noop}
      anchor={anchor}
      onAnchor={noop}
      today={MARCH}
      onOpen={noop}
      onReschedule={noop}
      onCreate={onCreate}
    />,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('offering a destination for a new entry', () => {
  it('offers exactly the notes that placed something, since those are the only ones proven to have a calendar and a date property', async () => {
    renderCalendar(MARCH_ENTRIES, MARCH, () => Promise.resolve(null));

    await userEvent.click(screen.getByRole('button', { name: 'New entry' }));

    const note = screen.getByRole('combobox', { name: 'Note' });
    const options = within(note)
      .getAllByRole('option')
      .map((option) => option.textContent);

    expect(options).toEqual(['Deadlines', 'Sessions']);
  });

  it('says what would make a container eligible, rather than showing an empty menu', () => {
    renderCalendar([], MARCH, () => Promise.resolve(null));

    expect(screen.queryByRole('button', { name: 'New entry' })).not.toBeInTheDocument();
    expect(
      screen.getByText(/no note here offers a calendar with a date property/i),
    ).toBeInTheDocument();
  });

  it('offers no way to create at all when the caller has not wired one', () => {
    renderCalendar(MARCH_ENTRIES, MARCH);

    expect(screen.queryByRole('button', { name: 'New entry' })).not.toBeInTheDocument();
    expect(screen.queryByText(/no note here offers a calendar/i)).not.toBeInTheDocument();
  });
});

describe('creating an entry', () => {
  it('asks for the chosen container, a title and a day - nothing else', async () => {
    const onCreate = vi.fn(() => Promise.resolve(null));
    renderCalendar(MARCH_ENTRIES, MARCH, onCreate);

    await userEvent.click(screen.getByRole('button', { name: 'New entry' }));
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Note' }), 'Sessions');
    await userEvent.type(screen.getByRole('textbox', { name: 'Title' }), 'Kickoff');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));

    expect(onCreate).toHaveBeenCalledWith(CONTAINER_TWO, 'Kickoff', '2026-03-17');
  });

  /**
   * The destination must not depend on which month is on screen. Goal 3.10's own words: a page
   * cannot tell what a note places by unless that note happens to have an entry in the window on
   * screen - so this drives the same container through two different windows, one of which carries
   * a value for it that would mislead a guess, and checks the call this component makes carries no
   * property at all for either window to leak through.
   */
  it('does not change what is asked for when the visible month changes', async () => {
    const onCreate = vi.fn(() => Promise.resolve(null));
    const { rerender } = renderCalendar(MARCH_ENTRIES, MARCH, onCreate);

    await userEvent.click(screen.getByRole('button', { name: 'New entry' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Title' }), 'March pick');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));

    expect(onCreate).toHaveBeenNthCalledWith(1, CONTAINER_ONE, 'March pick', '2026-03-17');

    rerender(
      <CollatedCalendar
        entries={APRIL_ENTRIES}
        grain="month"
        onGrain={noop}
        anchor={APRIL}
        onAnchor={noop}
        today={MARCH}
        onOpen={noop}
        onReschedule={noop}
        onCreate={onCreate}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'New entry' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Title' }), 'April pick');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));

    // The day tracks where the reader is looking, as it should - only the day, and the same
    // container id both times. There is no property in either call for a window to have coloured.
    expect(onCreate).toHaveBeenNthCalledWith(2, CONTAINER_ONE, 'April pick', '2026-04-05');
  });

  it("shows the service's own words when creation is refused, and draws nothing new", async () => {
    const onCreate = vi.fn(() => Promise.resolve('This note could not be written to right now.'));
    renderCalendar(MARCH_ENTRIES, MARCH, onCreate);

    await userEvent.click(screen.getByRole('button', { name: 'New entry' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Title' }), 'Refused item');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));

    const alert = await screen.findByRole('alert');
    expect(
      within(alert).getByText(/this note could not be written to right now/i),
    ).toBeInTheDocument();

    // No phantom entry: the grid still shows only the two items the props actually carry.
    // Anchored at the start: each item now also carries a "Reschedule <title>" control beside it,
    // which would match a bare substring just as well.
    expect(screen.getByRole('button', { name: /^Filing deadline/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Standup/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Refused item/i })).not.toBeInTheDocument();
  });
});

/**
 * A month cell used to answer only to a drag - the collated calendar's own counterpart to the
 * container calendar's `DayCell`, which has always carried a keyboard-reachable reschedule control
 * beside the drag. Goal 3.11 gives this one the same `RescheduleDialog` the container calendar and
 * the hour grid both already reuse.
 */
describe('rescheduling a month cell by tap rather than by drag', () => {
  function renderWithReschedule(onReschedule = vi.fn()): {
    readonly onReschedule: typeof onReschedule;
  } {
    render(
      <CollatedCalendar
        entries={MARCH_ENTRIES}
        grain="month"
        onGrain={noop}
        anchor={MARCH}
        onAnchor={noop}
        today={MARCH}
        onOpen={noop}
        onReschedule={onReschedule}
      />,
    );
    return { onReschedule };
  }

  it('opens a dialog seeded with the entry own date, from a tap rather than a drag', async () => {
    renderWithReschedule();

    await userEvent.click(screen.getByRole('button', { name: 'Reschedule Filing deadline' }));

    const dialog = screen.getByRole('dialog', { name: 'Reschedule Filing deadline' });
    expect(within(dialog).getByLabelText('New date')).toHaveValue('2026-03-12');

    // No "Remove date": this calendar has no unscheduled list for that write to be the
    // counterpart of, and offering it anyway would be a control that silently did nothing.
    expect(within(dialog).queryByRole('button', { name: 'Remove date' })).not.toBeInTheDocument();
  });

  it('writes the date typed into the dialog, the same write a drop onto the cell makes', async () => {
    const { onReschedule } = renderWithReschedule();

    await userEvent.click(screen.getByRole('button', { name: 'Reschedule Filing deadline' }));

    const field = screen.getByLabelText('New date');
    await userEvent.clear(field);
    await userEvent.type(field, '2026-03-20');
    await userEvent.click(screen.getByRole('button', { name: 'Move' }));

    expect(onReschedule).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: 'a1' }),
      '2026-03-20',
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('offers a time as well as a date for an entry placed by a timestamp property', async () => {
    renderWithReschedule();

    await userEvent.click(screen.getByRole('button', { name: 'Reschedule Standup' }));

    expect(screen.getByLabelText('New date and time')).toHaveAttribute('type', 'datetime-local');
  });

  it('closes on cancel and reschedules nothing', async () => {
    const { onReschedule } = renderWithReschedule();

    await userEvent.click(screen.getByRole('button', { name: 'Reschedule Filing deadline' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(onReschedule).not.toHaveBeenCalled();
  });
});

/**
 * The same "Show N more" behaviour `DayCell` gives the container calendar's own month grid,
 * extended to the collated one so a busy day does not grow the whole cell without bound.
 */
/**
 * A generated occurrence has no row of its own - it is drawn from a recurrence rule, not read from
 * storage - so it must not offer the writes only a stored row supports (drag, the reschedule
 * dialog), and it must say so with a marker a reader can see rather than leaving the two kinds of
 * entry looking alike. "Mark done" is the one write it does offer, through the recurrence
 * completion endpoint the goal 3.2 lane added.
 */
describe('a generated occurrence', () => {
  function generatedEntry(completed: boolean | null): CalendarEntry {
    return {
      itemId: 'c1',
      title: 'Water the plants',
      containerId: CONTAINER_ONE,
      containerTitle: 'Chores',
      dateProperty: 'due',
      value: '2026-03-12',
      kind: 'date',
      generated: true,
      endProperty: null,
      endValue: null,
      completed,
    };
  }

  it('is not draggable and offers no reschedule button, only a "Repeats" marker', () => {
    render(
      <CollatedCalendar
        entries={[generatedEntry(false)]}
        grain="month"
        onGrain={noop}
        anchor={MARCH}
        onAnchor={noop}
        today={MARCH}
        onOpen={noop}
        onReschedule={noop}
      />,
    );

    const button = screen.getByRole('button', { name: /water the plants/i });
    expect(button).toHaveAttribute('aria-label', 'Water the plants, in Chores, repeats');
    expect(button).not.toHaveAttribute('draggable', 'true');
    expect(
      screen.queryByRole('button', { name: 'Reschedule Water the plants' }),
    ).not.toBeInTheDocument();
  });

  it('offers "Mark done", calling back with the entry and the day it occurred on', async () => {
    const onComplete = vi.fn();
    render(
      <CollatedCalendar
        entries={[generatedEntry(false)]}
        grain="month"
        onGrain={noop}
        anchor={MARCH}
        onAnchor={noop}
        today={MARCH}
        onOpen={noop}
        onReschedule={noop}
        onComplete={onComplete}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Mark Water the plants done' }));

    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: 'c1' }),
      '2026-03-12',
    );
  });

  it('offers no "Mark done" control when the caller has not wired one', () => {
    render(
      <CollatedCalendar
        entries={[generatedEntry(false)]}
        grain="month"
        onGrain={noop}
        anchor={MARCH}
        onAnchor={noop}
        today={MARCH}
        onOpen={noop}
        onReschedule={noop}
      />,
    );

    expect(
      screen.queryByRole('button', { name: 'Mark Water the plants done' }),
    ).not.toBeInTheDocument();
  });

  it('renders a completed occurrence as done, with no further "Mark done" control', () => {
    const onComplete = vi.fn();
    render(
      <CollatedCalendar
        entries={[generatedEntry(true)]}
        grain="month"
        onGrain={noop}
        anchor={MARCH}
        onAnchor={noop}
        today={MARCH}
        onOpen={noop}
        onReschedule={noop}
        onComplete={onComplete}
      />,
    );

    expect(screen.getByRole('img', { name: 'Done' })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Mark Water the plants done' }),
    ).not.toBeInTheDocument();
  });
});

describe('a busy month cell', () => {
  function entryOn(id: string, day: string): CalendarEntry {
    return {
      itemId: id,
      title: `Item ${id}`,
      containerId: CONTAINER_ONE,
      containerTitle: 'Deadlines',
      dateProperty: 'due',
      value: day,
      kind: 'date',
      generated: false,
      endProperty: null,
      endValue: null,
      completed: null,
    };
  }

  const BUSY_DAY: readonly CalendarEntry[] = Array.from({ length: 8 }, (_unused, index) =>
    entryOn(`busy-${String(index)}`, '2026-03-12'),
  );

  it('collapses a busy day until its accessible overflow control is opened', async () => {
    render(
      <CollatedCalendar
        entries={BUSY_DAY}
        grain="month"
        onGrain={noop}
        anchor={MARCH}
        onAnchor={noop}
        today={MARCH}
        onOpen={noop}
        onReschedule={noop}
      />,
    );

    const day = screen.getByRole('cell', { name: 'Thursday 12 March 2026' });
    expect(within(day).getAllByRole('listitem')).toHaveLength(3);

    await userEvent.click(within(day).getByRole('button', { name: 'Show 5 more' }));
    expect(within(day).getAllByRole('listitem')).toHaveLength(8);
    expect(within(day).getByRole('button', { name: 'Show fewer' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });
});
