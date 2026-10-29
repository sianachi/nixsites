import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { item, stubCoreApi } from '@nix/web-foundation/testing/api-stub';
import { renderAt, signedIn } from '@nix/web-editor/testing/render-with-router';
import { stubViewport } from '@nix/web-foundation/testing/stub-viewport';
import { App } from '../../app';

/**
 * The calendar destination.
 *
 * Driven through the whole application, because most of what this page promises is only true in a
 * router and against a real fetch: which states it moves through, that the address carries the
 * grain and the anchor, and that what it cannot read reaches a reader in words.
 *
 * `process.env.TZ` is ten hours west of UTC, deliberately, so an accidental `new Date(string)`
 * anywhere in the placement path shows up as an off-by-one day rather than passing in CI and
 * failing for somebody in Auckland. The same reason `calendar-view.test.tsx` picks it.
 */
process.env.TZ = 'Pacific/Honolulu';

const ONE = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const TWO = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const CONTAINER_ONE = 'cccccccc-3333-4333-8333-cccccccccccc';
const CONTAINER_TWO = 'dddddddd-4444-4444-8444-dddddddddddd';

/** Two entries from two containers, placed by two differently named properties. */
const ENTRIES = [
  {
    itemId: ONE,
    title: 'Filing deadline',
    containerId: CONTAINER_ONE,
    containerTitle: 'Deadlines',
    dateProperty: 'due',
    value: '2026-03-12',
    kind: 'date' as const,
  },
  {
    itemId: TWO,
    title: 'Standup',
    containerId: CONTAINER_TWO,
    containerTitle: 'Sessions',
    dateProperty: 'starts',
    value: '2026-03-17T09:00:00+00:00[Europe/London]',
    kind: 'timestamp' as const,
  },
];

beforeEach(() => {
  signedIn();
  stubViewport(true);
  vi.useFakeTimers({ shouldAdvanceTime: true });
  // Built from local parts, so "today" is the 17th of March here rather than whatever the 17th of
  // March UTC happens to be in this zone.
  vi.setSystemTime(new Date(2026, 2, 17, 12, 0, 0));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the calendar destination', () => {
  it('draws a date wherever it was set, from every container at once', async () => {
    stubCoreApi({ calendarEntries: ENTRIES });
    renderAt(<App />, '/calendar');

    expect(await screen.findByRole('heading', { name: 'Calendar' })).toBeInTheDocument();

    expect(await screen.findByRole('button', { name: /^Filing deadline/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Standup/i })).toBeInTheDocument();
  });

  /**
   * The whole point of collating: two notes called "Review" from different projects would otherwise
   * be indistinguishable. A day cell is too narrow to print the container, so it is said rather
   * than truncated.
   */
  it('says which container an entry came from', async () => {
    stubCoreApi({ calendarEntries: ENTRIES });
    renderAt(<App />, '/calendar');

    expect(
      await screen.findByRole('button', { name: /Filing deadline, in Deadlines/i }),
    ).toBeInTheDocument();
  });

  it('names itself while it is still loading, so a reader knows where they landed', async () => {
    stubCoreApi({ calendarEntries: ENTRIES });
    renderAt(<App />, '/calendar');

    // The heading is outside the state fork, so it is on screen before the first entry is.
    expect(await screen.findByRole('heading', { name: 'Calendar' })).toBeInTheDocument();
  });

  it('offers the three grains and lets the address choose one', async () => {
    stubCoreApi({ calendarEntries: ENTRIES });
    renderAt(<App />, '/calendar?grain=week');

    await screen.findByRole('heading', { name: 'Calendar' });
    const grains = await screen.findByRole('group', { name: /calendar grain/i });
    expect(within(grains).getAllByRole('button')).toHaveLength(3);
    expect(within(grains).getByRole('button', { name: 'Week' })).toHaveAttribute(
      'aria-current',
      'true',
    );
  });

  it('falls back to a month for a grain this build does not know', async () => {
    stubCoreApi({ calendarEntries: ENTRIES });
    renderAt(<App />, '/calendar?grain=fortnight');

    await screen.findByRole('heading', { name: 'Calendar' });

    const grains = await screen.findByRole('group', { name: /calendar grain/i });
    expect(within(grains).getByRole('button', { name: 'Month' })).toHaveAttribute(
      'aria-current',
      'true',
    );
  });

  it('opens the anchor the address names rather than today', async () => {
    stubCoreApi({ calendarEntries: ENTRIES });
    renderAt(<App />, '/calendar?on=2026-07-04');

    await screen.findByRole('heading', { name: 'Calendar' });

    // The grid's own region name, rather than the live label beside it: the month appears in
    // three places on screen (the label, the region's name, the table's caption) and the region is
    // the one that says what is actually drawn.
    expect(await screen.findByRole('region', { name: /July 2026/i })).toBeInTheDocument();
  });

  it('steps through time and says where it got to', async () => {
    stubCoreApi({ calendarEntries: ENTRIES });
    renderAt(<App />, '/calendar');

    await screen.findByRole('heading', { name: 'Calendar' });
    expect(await screen.findByRole('region', { name: /March 2026/i })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /next month/i }));
    expect(await screen.findByRole('region', { name: /April 2026/i })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /previous month/i }));
    expect(await screen.findByRole('region', { name: /March 2026/i })).toBeInTheDocument();
  });

  it('opens the item an entry stands for', async () => {
    stubCoreApi({
      items: [item({ id: ONE, title: 'Filing deadline' })],
      calendarEntries: ENTRIES,
    });
    renderAt(<App />, '/calendar');

    await screen.findByRole('heading', { name: 'Calendar' });
    await userEvent.click(
      await screen.findByRole('button', { name: 'Filing deadline, in Deadlines' }),
    );

    // An item id in `/calendar`'s query would still render the calendar. The editable title proves
    // this crossed back to the document route and mounted the note it points at.
    expect(await screen.findByRole('textbox', { name: /note title/i })).toHaveValue(
      'Filing deadline',
    );
  });

  /**
   * The container calendar can create and reschedule because it knows which property it places by.
   * This one cannot, so it must not offer controls that would have to guess.
   */
  it('offers no way to create, because it could not know where a new item would go', async () => {
    stubCoreApi({ calendarEntries: ENTRIES });
    renderAt(<App />, '/calendar?grain=week');

    await screen.findByRole('heading', { name: 'Calendar' });

    expect(screen.queryByRole('button', { name: /add an item at/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /add an all-day item/i })).not.toBeInTheDocument();
  });
});

/**
 * What the calendar admits to. A truncated list looks short and announces itself; a truncated
 * calendar looks like a calendar, so every gap has to be said out loud.
 */
describe('what the calendar admits to', () => {
  it('says so when the entry ceiling was reached', async () => {
    stubCoreApi({ calendarEntries: ENTRIES, calendarTruncated: true });
    renderAt(<App />, '/calendar');

    await screen.findByRole('heading', { name: 'Calendar' });

    expect(await screen.findByText(/first 2000 items/i)).toBeInTheDocument();
    expect(screen.getByText(/not drawn/i)).toBeInTheDocument();
  });

  /**
   * A container somebody configured and did not finish. Passed over in silence it would look
   * exactly like a container with nothing scheduled, and a reader would believe the second.
   */
  it('names a container that offers a calendar and places nothing', async () => {
    stubCoreApi({
      calendarEntries: ENTRIES,
      calendarUnplaceable: [
        { containerId: CONTAINER_ONE, containerTitle: 'Roadmap', reason: 'no_date_property' },
      ],
    });
    renderAt(<App />, '/calendar');

    await screen.findByRole('heading', { name: 'Calendar' });

    expect(await screen.findByText(/Roadmap.*names no date property/i)).toBeInTheDocument();
  });

  it('claims nothing when the calendar is complete', async () => {
    stubCoreApi({ calendarEntries: ENTRIES });
    renderAt(<App />, '/calendar');

    await screen.findByRole('heading', { name: 'Calendar' });

    expect(screen.queryByText(/not drawn/i)).not.toBeInTheDocument();
  });

  it('offers a way out when the read fails, and does not call it empty', async () => {
    stubCoreApi({ calendarFails: true });
    renderAt(<App />, '/calendar');

    const alert = await screen.findByRole('alert');

    expect(within(alert).getByText(/could not be loaded/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('says a workspace with nothing scheduled is empty, not broken', async () => {
    stubCoreApi({ calendarEntries: [] });
    renderAt(<App />, '/calendar');

    expect(await screen.findByText(/nothing scheduled/i)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next month' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Next month' }));
    expect(await screen.findByRole('region', { name: /April 2026/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Today' })).toBeInTheDocument();
  });

  /**
   * A workspace whose only calendar is misconfigured is not empty. Calling it empty would hide the
   * one thing on screen worth acting on.
   */
  it('does not call a workspace empty when the only thing in it is a misconfigured calendar', async () => {
    stubCoreApi({
      calendarEntries: [],
      calendarUnplaceable: [
        { containerId: CONTAINER_ONE, containerTitle: 'Roadmap', reason: 'no_date_property' },
      ],
    });
    renderAt(<App />, '/calendar');

    await screen.findByRole('heading', { name: 'Calendar' });

    expect(screen.queryByText(/nothing scheduled/i)).not.toBeInTheDocument();
    expect(await screen.findByText(/Roadmap.*names no date property/i)).toBeInTheDocument();
  });
});

/**
 * Filtering by note.
 *
 * The calendar is workspace-wide by default and the filter narrows it, so nothing checked means
 * every note - said out loud, because an empty selection and a selection showing nothing look the
 * same on a grid and only one of them is what happened.
 */
describe('filtering the calendar by note', () => {
  it('offers the notes that actually placed something, not every note in the workspace', async () => {
    stubCoreApi({ calendarEntries: ENTRIES });
    renderAt(<App />, '/calendar');

    await screen.findByRole('heading', { name: 'Calendar' });

    expect(await screen.findByRole('checkbox', { name: 'Deadlines' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Sessions' })).toBeInTheDocument();
  });

  it('shows every note until one is chosen', async () => {
    stubCoreApi({ calendarEntries: ENTRIES });
    renderAt(<App />, '/calendar');

    await screen.findByRole('heading', { name: 'Calendar' });

    expect(await screen.findByText(/showing every note/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Filing deadline/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Standup/i })).toBeInTheDocument();
  });

  it('narrows to the notes that are checked', async () => {
    stubCoreApi({ calendarEntries: ENTRIES });
    renderAt(<App />, '/calendar');

    await screen.findByRole('heading', { name: 'Calendar' });
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Deadlines' }));

    expect(await screen.findByRole('button', { name: /^Filing deadline/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Standup/i })).not.toBeInTheDocument();
  });

  it('overlays several notes at once, which is the point of checkboxes', async () => {
    stubCoreApi({ calendarEntries: ENTRIES });
    renderAt(<App />, '/calendar');

    await screen.findByRole('heading', { name: 'Calendar' });
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Deadlines' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Sessions' }));

    expect(await screen.findByText(/showing 2 of 2 notes/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Filing deadline/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Standup/i })).toBeInTheDocument();
  });

  it('takes its selection from the address, so a filtered calendar is a link', async () => {
    stubCoreApi({ calendarEntries: ENTRIES });
    renderAt(<App />, `/calendar?notes=${CONTAINER_TWO}`);

    await screen.findByRole('heading', { name: 'Calendar' });

    expect(await screen.findByRole('button', { name: /^Standup/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Filing deadline/i })).not.toBeInTheDocument();
  });

  it('goes back to everything', async () => {
    stubCoreApi({ calendarEntries: ENTRIES });
    renderAt(<App />, `/calendar?notes=${CONTAINER_TWO}`);

    await screen.findByRole('heading', { name: 'Calendar' });
    await userEvent.click(await screen.findByRole('button', { name: /show all/i }));

    expect(await screen.findByText(/showing every note/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Filing deadline/i })).toBeInTheDocument();
  });

  /**
   * A stale link, or a note that placed nothing in this window. It matches no entry, which is the
   * honest answer - but it must not be mistaken for "show nothing", and the calendar must still
   * draw the notes that are selected alongside it.
   */
  it('keeps an unknown note in the selection rather than silently rewriting the link', async () => {
    stubCoreApi({ calendarEntries: ENTRIES });
    renderAt(<App />, `/calendar?notes=${CONTAINER_TWO},99999999-9999-4999-8999-999999999999`);

    await screen.findByRole('heading', { name: 'Calendar' });

    expect(await screen.findByRole('button', { name: /^Standup/i })).toBeInTheDocument();
    expect(screen.getByText(/showing 2 of 2 notes/i)).toBeInTheDocument();
  });

  it('offers no filter when nothing placed anything', async () => {
    stubCoreApi({
      calendarEntries: [],
      calendarUnplaceable: [
        { containerId: CONTAINER_ONE, containerTitle: 'Roadmap', reason: 'no_date_property' },
      ],
    });
    renderAt(<App />, '/calendar');

    await screen.findByRole('heading', { name: 'Calendar' });

    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });
});

/**
 * Dragging an entry to another day.
 *
 * The assertions are on what was *written*, not on where the chip landed. A drag that redraws
 * correctly and sends the wrong value is the failure that matters here - the grid would look right
 * until the next reload, and the reader would have lost a time they never agreed to lose.
 */
describe('rescheduling by dragging', () => {
  function chipFor(name: RegExp): HTMLElement {
    return screen.getByRole('button', { name });
  }

  function cellFor(container: HTMLElement, day: string): HTMLElement {
    const cell = [...container.querySelectorAll('td[aria-label]')].find((candidate) =>
      candidate.getAttribute('aria-label')?.includes(day),
    );
    if (cell === undefined) {
      throw new Error(`no cell for ${day}`);
    }
    return cell as HTMLElement;
  }

  it('writes the entry own date property, not some property of the calendar', async () => {
    const writes = stubCoreApi({ calendarEntries: ENTRIES });
    const { container } = renderAt(<App />, '/calendar');

    await screen.findByRole('heading', { name: 'Calendar' });
    await screen.findByRole('button', { name: /^Filing deadline/i });

    const chip = chipFor(/^Filing deadline/i);
    fireEvent.dragStart(chip);
    fireEvent.drop(cellFor(container, '19 March 2026'));

    await waitFor(() => {
      expect(writes.properties).toHaveLength(1);
    });

    // `due` is the key its own container placed it by. A collated calendar that wrote one property
    // for everything would silently move an item onto a field its container does not read.
    expect(writes.properties[0]?.properties).toEqual({ due: '2026-03-19' });
  });

  it('keeps a moment at its time when it moves day', async () => {
    const writes = stubCoreApi({ calendarEntries: ENTRIES });
    const { container } = renderAt(<App />, '/calendar');

    await screen.findByRole('heading', { name: 'Calendar' });
    await screen.findByRole('button', { name: /^Standup/i });

    fireEvent.dragStart(chipFor(/^Standup/i));
    fireEvent.drop(cellFor(container, '19 March 2026'));

    await waitFor(() => {
      expect(writes.properties).toHaveLength(1);
    });

    const starts: unknown = writes.properties[0]?.properties.starts;
    const written = typeof starts === 'string' ? starts : '';
    expect(written).toContain('2026-03-19');

    // The time survived. Writing a bare day here would discard it, which is data the reader never
    // asked to lose.
    expect(written).toMatch(/T\d{2}:\d{2}:\d{2}/);
  });

  it('writes nothing when an entry is dropped back where it already was', async () => {
    const writes = stubCoreApi({ calendarEntries: ENTRIES });
    const { container } = renderAt(<App />, '/calendar');

    await screen.findByRole('heading', { name: 'Calendar' });
    await screen.findByRole('button', { name: /^Filing deadline/i });

    fireEvent.dragStart(chipFor(/^Filing deadline/i));
    fireEvent.drop(cellFor(container, '12 March 2026'));

    // A no-op drag is a no-op write. Sending the same value would bump the item's modified stamp
    // and, in a collaborative document, look like somebody had changed something.
    expect(writes.properties).toHaveLength(0);
  });

  it('writes nothing when a cell is dropped on with nothing in the air', async () => {
    const writes = stubCoreApi({ calendarEntries: ENTRIES });
    const { container } = renderAt(<App />, '/calendar');

    await screen.findByRole('heading', { name: 'Calendar' });
    await screen.findByRole('button', { name: /^Filing deadline/i });

    fireEvent.drop(cellFor(container, '19 March 2026'));

    expect(writes.properties).toHaveLength(0);
  });
});
