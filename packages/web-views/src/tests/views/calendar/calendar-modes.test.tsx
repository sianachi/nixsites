import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CalendarView } from '../../../calendar/calendar-view';
import { aContainer, views } from '@nix/web-collections/testing/container-fixture';
import type { EffectiveSchema, View } from '@nix/web-collections/core/container-model';
import { renderAt } from '@nix/web-editor/testing/render-with-router';
import { aView, datedItem } from '@nix/web-collections/testing/view-fixture';
import type { ContainerData } from '@nix/web-collections/core/use-container';

/**
 * The calendar at a day and a week, and the reason those modes needed a timestamp type.
 *
 * **The suite runs in `Pacific/Honolulu`, ten hours west of UTC, deliberately** - the same reason
 * the month suite does. A grid that placed a moment without converting it would put an item in the
 * slot that looks right from wherever it was written and the wrong one everywhere else, and it
 * would look correct on the machine of whoever built it.
 */

process.env.TZ = 'Pacific/Honolulu';

const SCHEMA: EffectiveSchema = {
  properties: [
    { key: 'starts', label: 'Starts', type: 'timestamp', options: [], required: false },
    { key: 'due', label: 'Due', type: 'date', options: [], required: false },
  ],
  declared: [],
  inherit: true,
};

function viewOf(overrides: Partial<View> = {}): View {
  return aView({
    id: 'schedule',
    name: 'Schedule',
    kind: 'calendar',
    dateProperty: 'starts',
    ...overrides,
  });
}

/** 09:00 in London on Tuesday the 17th. For a reader in Honolulu that is 23:00 on Monday the 16th. */
const LONDON_STANDUP = datedItem('item-standup', 'Standup', {
  starts: '2026-03-17T09:00:00+00:00[Europe/London]',
});

const ALL_DAY = datedItem('item-review', 'Review', { starts: '2026-03-17', due: '2026-03-17' });

function render(container: Partial<ContainerData> = {}, view: View = viewOf(), url = '/'): void {
  renderAt(
    <CalendarView
      // Always at least one item: an empty calendar draws a panel rather than a grid, which is
      // right, and would make every assertion below one about the empty state instead.
      container={aContainer({
        schema: SCHEMA,
        views: views([view]),
        children: [LONDON_STANDUP],
        ...container,
      })}
      view={view}
      onOpen={vi.fn()}
    />,
    url,
  );
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  // A Tuesday in the middle of March 2026, from local parts - a parsed string would be a different
  // day here than on a machine in UTC.
  vi.setSystemTime(new Date(2026, 2, 17, 12, 0, 0));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('choosing a grain', () => {
  it('draws a month unless something says otherwise', () => {
    render();

    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'month' })).toHaveAttribute('aria-current', 'page');
  });

  it('takes the grain the view was configured with', () => {
    render({}, viewOf({ mode: 'week' }));

    // A template that ships "Calendar (week)" is impossible unless the view can carry this.
    expect(screen.getByRole('button', { name: 'week' })).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('lets the address override the view, the way it overrides which view opens', () => {
    render({}, viewOf({ mode: 'month' }), '/?mode=day');

    expect(screen.getByRole('button', { name: 'day' })).toHaveAttribute('aria-current', 'page');
  });

  it('falls back to a month for a grain it does not know', () => {
    // A view written by a newer build must leave an older one with something to draw rather than
    // nothing.
    render({}, viewOf({ mode: 'fortnight' }));

    expect(screen.getByRole('table')).toBeInTheDocument();
  });
});

describe('a week', () => {
  it('runs Monday to Sunday around the day it is anchored on', () => {
    render({}, viewOf({ mode: 'week' }));

    // The 17th is a Tuesday, so the week starts on the 16th.
    expect(screen.getByText('Monday 16 March 2026')).toBeInTheDocument();
    expect(screen.getByText('Sunday 22 March 2026')).toBeInTheDocument();
  });

  it('says which week it is showing, naming both months when it straddles them', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render({}, viewOf({ mode: 'week' }));

    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('16 to 22 March 2026');

    // Two weeks on is 30 March to 5 April.
    await user.click(screen.getByRole('button', { name: 'Next week' }));
    await user.click(screen.getByRole('button', { name: 'Next week' }));

    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('30 March to 5 April 2026');
  });
});

describe('a day', () => {
  it('shows one column, named', () => {
    render({}, viewOf({ mode: 'day' }));

    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Tuesday 17 March 2026');
  });

  it('steps by a day rather than a month', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render({}, viewOf({ mode: 'day' }));

    await user.click(screen.getByRole('button', { name: 'Next day' }));

    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Wednesday 18 March 2026');
  });
});

describe('placing a moment', () => {
  it('puts it on the reader s day, not the day it was written on', () => {
    render({ children: [LONDON_STANDUP] }, viewOf({ mode: 'week' }));

    // 09:00 Europe/London on Tuesday the 17th is 23:00 in Honolulu on Monday the 16th. Placing it
    // without converting would put it in Tuesday's column, which is right in London and wrong here.
    const monday = screen.getByLabelText('Monday 16 March 2026');

    // Anchored at the start: the column now also carries a "Reschedule Standup" control beside
    // the card (goal 3.11), which would match a bare /standup/i just as well.
    expect(within(monday).getByRole('button', { name: /^standup/i })).toBeInTheDocument();
  });

  it('says the item s own zone when it is not the reader s', () => {
    // A week rather than a day, because the item is on Monday here and the anchor is Tuesday - the
    // very displacement the test above is about.
    render({ children: [LONDON_STANDUP] }, viewOf({ mode: 'week' }));

    // Named, because 23:00 on a Honolulu screen for a 09:00 London meeting is confusing enough
    // without leaving somebody to work out why.
    expect(screen.getByText(/Europe\/London/)).toBeInTheDocument();
  });

  it('keeps an all-day item off the hour grid', () => {
    render({ children: [ALL_DAY] }, viewOf({ mode: 'day', dateProperty: 'due' }));

    // A date means "the 3rd" and has no hour. Putting it at midnight would be an invented answer
    // that reads as a real one - and converting it to find a row is the bug the date type exists to
    // avoid.
    const band = screen.getByLabelText('All day on Tuesday 17 March 2026');

    expect(within(band).getByRole('button', { name: /review/i })).toBeInTheDocument();
  });
});

describe('the free slot offered when rescheduling on the hour grid', () => {
  it('is offered when every child is loaded', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render({ children: [LONDON_STANDUP], truncated: false }, viewOf({ mode: 'week' }));

    await user.click(screen.getByRole('button', { name: 'Reschedule Standup' }));

    expect(screen.getByText(/Next free slot here/)).toBeInTheDocument();
  });

  it('is not offered when the container is truncated, since a slot may only look free', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render({ children: [LONDON_STANDUP], truncated: true }, viewOf({ mode: 'week' }));

    await user.click(screen.getByRole('button', { name: 'Reschedule Standup' }));

    expect(screen.getByRole('dialog', { name: 'Reschedule Standup' })).toBeInTheDocument();
    expect(screen.queryByText(/Next free slot here/)).not.toBeInTheDocument();
  });
});
