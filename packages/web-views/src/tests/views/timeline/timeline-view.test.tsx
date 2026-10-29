import { fireEvent, screen, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { useState, type ReactElement, type ReactNode } from 'react';
import { useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderAt } from '@nix/web-editor/testing/render-with-router';
import { stubViewport } from '@nix/web-foundation/testing/stub-viewport';
import { aView } from '@nix/web-collections/testing/view-fixture';
import { aContainer, views } from '@nix/web-collections/testing/container-fixture';
import type { EffectiveSchema, Item, View } from '@nix/web-collections/core/container-model';
import { TimelineView } from '../../../timeline/timeline-view';
import { ContainerView } from '../../../core/container-view';
import type { ContainerData } from '@nix/web-collections/core/use-container';

/**
 * The timeline, and above all what it says about the items it cannot draw a bar for.
 *
 * Every assertion here is a variation on one rule: **the items are the view, and a bar is one way
 * of drawing one.** Four things can be true of an item that no bar can express - it has no end, its
 * end is before its start, it is off the window, it has no start at all - and none of them is
 * allowed to remove the item from the screen or to be described as one of the other three. Two of
 * them are one silent `Math.min` away from looking correct and being a lie about the data.
 *
 * **The suite runs in `Pacific/Honolulu`, ten hours west of UTC**, for the reason both calendar
 * suites do: a bar placed from a value that was turned into a `Date` lands a day early for every
 * reader west of Greenwich, and looks right on the machine of whoever wrote it.
 */

process.env.TZ = 'Pacific/Honolulu';

const SCHEMA: EffectiveSchema = {
  properties: [
    { key: 'starts', label: 'Starts', type: 'date', options: [], required: false },
    { key: 'ends', label: 'Ends', type: 'date', options: [], required: false },
    { key: 'owner', label: 'Owner', type: 'text', options: [], required: false },
  ],
  declared: [],
  inherit: true,
};

function viewOf(overrides: Partial<View> = {}): View {
  return aView({
    id: 'delivery',
    name: 'Delivery',
    kind: 'timeline',
    dateProperty: 'starts',
    endDateProperty: 'ends',
    ...overrides,
  });
}

function itemOf(id: string, title: string, properties: Record<string, unknown>): Item {
  return {
    id,
    workspaceId: 'a1000000-0000-4000-8000-000000000001',
    parentId: 'c1000000-0000-4000-8000-000000000001',
    type: 'note',
    title,
    hasChildren: false,
    seq: 1000,
    lifecycleState: 'active',
    properties,
    createdAt: '2026-03-01T00:00:00.000Z',
    updatedAt: '2026-03-01T00:00:00.000Z',
  };
}

/** A four-day bar in the middle of the window. */
const ROLLOUT = itemOf('item-rollout', 'Rollout', { starts: '2026-03-03', ends: '2026-03-06' });

/** A start and no end at all: a milestone. */
const LAUNCH = itemOf('item-launch', 'Launch', { starts: '2026-03-10' });

/** Stated backwards. Nobody has decided which of the two dates is the wrong one. */
const MUDDLE = itemOf('item-muddle', 'Muddle', { starts: '2026-03-20', ends: '2026-03-04' });

/** Dated, and nowhere near the window. */
const LEGACY = itemOf('item-legacy', 'Legacy', { starts: '2026-01-05', ends: '2026-01-09' });

/** Runs in from before the window and out past the end of it. */
const LONG_HAUL = itemOf('item-long', 'Long haul', {
  starts: '2026-02-20',
  ends: '2026-04-14',
});

/** Nothing at all. It is still an item here. */
const IDEA = itemOf('item-idea', 'Idea', { owner: 'Ada' });

/**
 * A start property holding something that is not a date.
 *
 * Reachable without the server ever having seen it: retyping a text property to Date does not
 * revalidate what is already stored.
 */
const SKETCH = itemOf('item-sketch', 'Sketch', { starts: 'next Tuesday' });

function render(container: Partial<ContainerData> = {}, view: View = viewOf(), url = '/') {
  const onOpen = vi.fn();

  const data = aContainer({
    schema: SCHEMA,
    views: views([view]),
    // Always at least one item: an empty container draws a panel rather than a grid, which is
    // right, and would make every assertion below one about the empty state instead.
    children: [ROLLOUT],
    setProperties: vi.fn(() => Promise.resolve(null)),
    ...container,
  });

  renderAt(<TimelineView container={data} view={view} onOpen={onOpen} />, url);

  return { onOpen, setProperties: data.setProperties };
}

/**
 * A container that behaves the way `useContainer` really does.
 *
 * The plain `render` above passes a `setProperties` mock that neither mutates the children nor sets
 * `writeError`, which quietly decouples two things the real hook always does together - so a test
 * using it cannot see a duplicate refusal banner, and cannot see an item change band under an edit.
 * Both were real defects that the mock hid. Modelled on the board's harness, which exists for the
 * same reason.
 */
function renderLive(options: {
  readonly items: readonly Item[];
  readonly view?: View;
  readonly refuse?: string;
}): { readonly writes: ReturnType<typeof vi.fn> } {
  const writes = vi.fn();
  const view = options.view ?? viewOf();

  function Harness(): ReactNode {
    const [children, setChildren] = useState<readonly Item[]>(options.items);
    const [writeError, setWriteError] = useState<string | null>(null);

    const container = aContainer({
      schema: SCHEMA,
      views: views([view]),
      children,
      writeError,
      setProperties: (itemId, properties) => {
        writes(itemId, properties);
        setWriteError(null);

        // Optimistic, exactly as the hook is: the item moves first and the request follows.
        setChildren((current) =>
          current.map((item) =>
            item.id === itemId
              ? { ...item, properties: { ...item.properties, ...properties } }
              : item,
          ),
        );

        if (options.refuse !== undefined) {
          setChildren(options.items);
          setWriteError(options.refuse);
        }

        // Both channels on one refusal, which is what the hook does and what makes rendering both
        // of them a duplicate.
        return Promise.resolve(options.refuse ?? null);
      },
    });

    return <TimelineView container={container} view={view} onOpen={vi.fn()} />;
  }

  renderAt((<Harness />) as ReactElement);

  return { writes };
}

/** Reports the address back to the test, so "not in the URL" can be asserted as a fact. */
function CurrentSearch(): ReactNode {
  const location = useLocation();
  return <output aria-label="Address">{location.search}</output>;
}

function person(): UserEvent {
  return userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
}

/**
 * Reaches an element the way somebody with no pointer reaches it.
 *
 * `userEvent.click` dispatches pointer events, so a test that clicks proves nothing about whether
 * the control is reachable without a mouse. Tabbing is the actual claim.
 */
async function tabTo(user: UserEvent, element: HTMLElement): Promise<void> {
  for (let attempt = 0; attempt < 80 && document.activeElement !== element; attempt += 1) {
    await user.tab();
  }

  expect(element).toHaveFocus();
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  // A Tuesday in the middle of March 2026, built from local parts - a parsed string would be a
  // different day here than on a machine sitting in UTC.
  vi.setSystemTime(new Date(2026, 2, 17, 12, 0, 0));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('drawing the axis', () => {
  it('selects a timeline item from its checkbox and shows the shared tray', async () => {
    const user = person();
    const view = viewOf();
    const data = aContainer({ schema: SCHEMA, views: views([view]), children: [ROLLOUT] });
    renderAt(<ContainerView container={data} view={view} onOpen={vi.fn()} />);

    await user.click(screen.getByRole('checkbox', { name: 'Select Rollout' }));
    expect(screen.getByRole('toolbar', { name: 'Selected items' })).toHaveTextContent('1 selected');
  });

  it('keeps a 3,200-row timeline DOM bounded while exposing the complete row count', () => {
    const many = Array.from({ length: 3_200 }, (_unused, index) =>
      itemOf(`item-${String(index)}`, `Item ${String(index + 1)}`, {
        starts: '2026-03-03',
        ends: '2026-03-06',
      }),
    );

    render({ children: many });

    const timeline = screen.getByRole('region', { name: 'Delivery, March 2026' });
    expect(within(timeline).getByRole('table')).toHaveAttribute('aria-rowcount', '3201');
    expect(timeline.querySelectorAll('[data-virtual-index]').length).toBeLessThanOrEqual(100);
  });

  it('opens on the month containing today', () => {
    render();

    expect(screen.getByRole('heading', { name: 'March 2026' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'month' })).toHaveAttribute('aria-current', 'page');
  });

  it('draws a bar named with the days it runs between', () => {
    render();

    expect(
      screen.getByRole('button', { name: 'Rollout, Tuesday 3 March 2026 to Friday 6 March 2026' }),
    ).toBeVisible();
  });

  it('draws an item with a start and no end as a milestone rather than as a bar to today', () => {
    // A bar drawn to today would be an end date this application invented, and it would grow every
    // morning. The name has to say the end is absent, because a shape cannot.
    render({ children: [LAUNCH] });

    expect(
      screen.getByRole('button', { name: 'Launch, starts Tuesday 10 March 2026, no end date' }),
    ).toBeVisible();

    // And emphatically not announced as running to anything.
    expect(screen.queryByRole('button', { name: /Launch,.* to / })).not.toBeInTheDocument();
  });

  it('announces a clipped bar with the dates it really has', () => {
    // The cut is a fact about the window, not about the item. Somebody told the truncated dates
    // would have no way of knowing they had been.
    render({ children: [LONG_HAUL] });

    expect(
      screen.getByRole('button', {
        name: 'Long haul, Friday 20 February 2026 to Tuesday 14 April 2026',
      }),
    ).toBeVisible();

    expect(
      screen.queryByRole('button', { name: /1 March 2026 to .*31 March 2026/ }),
    ).not.toBeInTheDocument();
  });

  it('names every column with its whole date rather than with a bare number', () => {
    render();

    // "3" on its own tells somebody moving through the row with a screen reader nothing about
    // which month, or which year, they are in.
    expect(screen.getByRole('columnheader', { name: 'Tuesday 3 March 2026' })).toBeVisible();
  });
});

describe('the items no bar can express', () => {
  it('lists an item whose end date falls before its start rather than swapping the two', () => {
    render({ children: [ROLLOUT, MUDDLE] });

    const band = screen.getByRole('region', {
      name: '1 item has an end date before its start date',
    });

    // Both dates, as stored. Swapping them would silently correct a data error somebody may need
    // to see, and clamping would draw a bar whose dates are not the item's.
    expect(
      within(band).getByText('Starts Friday 20 March 2026. Ends Wednesday 4 March 2026.'),
    ).toBeVisible();
    expect(
      within(band).getByRole('button', {
        name: 'Muddle, starts Friday 20 March 2026 and ends Wednesday 4 March 2026, which is before it starts',
      }),
    ).toBeVisible();

    // And it is not also drawn as a bar somewhere, which a swap would have produced.
    expect(
      screen.queryByRole('button', {
        name: 'Muddle, Wednesday 4 March 2026 to Friday 20 March 2026',
      }),
    ).not.toBeInTheDocument();
  });

  it('says how many items lie outside the window and keeps them reachable', async () => {
    const user = person();
    const { onOpen } = render({ children: [ROLLOUT, LEGACY] });

    expect(
      screen.getByText(
        '1 item is dated outside March 2026. It is listed under "Outside this window".',
      ),
    ).toBeVisible();

    const band = screen.getByRole('region', { name: 'Outside this window (1)' });
    await user.click(
      within(band).getByRole('button', {
        name: 'Legacy, Monday 5 January 2026 to Friday 9 January 2026',
      }),
    );

    expect(onOpen).toHaveBeenCalledWith('item-legacy');
  });

  it('lists an item with no start date rather than dropping it', () => {
    // A timeline that omitted its undated items would lose half a folder without ever saying so.
    render({ children: [ROLLOUT, IDEA] });

    const band = screen.getByRole('region', { name: 'Unscheduled (1)' });

    expect(within(band).getByRole('button', { name: 'Idea, no start date' })).toBeVisible();
    expect(within(band).getByText('No start date and no end date.')).toBeVisible();
  });

  it('says a start that is not a date is unreadable rather than saying there is none', () => {
    // The distinction sends somebody to two different places: one item is waiting to be scheduled,
    // and the other has a value sitting in the property that nothing can read. Filing the second
    // under "no start date yet" would have them looking for data they think was deleted.
    render({ children: [ROLLOUT, SKETCH] });

    const band = screen.getByRole('region', { name: 'Dates that could not be read (1)' });

    expect(
      within(band).getByRole('button', {
        name: 'Sketch, a start stored as "next Tuesday", which is not a date, no end date',
      }),
    ).toBeVisible();

    // And emphatically not filed with the items that genuinely have nothing.
    expect(screen.getByRole('region', { name: 'Unscheduled (0)' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Sketch, no start date' })).not.toBeInTheDocument();
  });

  it('says out loud that everything is scheduled rather than leaving the heading off', () => {
    render({ children: [ROLLOUT] });

    expect(
      within(screen.getByRole('region', { name: 'Unscheduled (0)' })).getByText(
        'Every item here has a start date.',
      ),
    ).toBeVisible();
  });
});

describe('the scale', () => {
  it("takes its scale from the address in preference to the view's own", () => {
    render({}, viewOf({ mode: 'week' }), '/?mode=quarter');

    expect(screen.getByRole('heading', { name: 'January to March 2026' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'quarter' })).toHaveAttribute('aria-current', 'page');
  });

  it('takes the scale the view was configured with when the address says nothing', () => {
    render({}, viewOf({ mode: 'week' }));

    expect(screen.getByRole('heading', { name: '16 to 22 March 2026' })).toBeVisible();
  });

  it('falls back to a month for a calendar grain a timeline has no meaning for', () => {
    // A view switched from a calendar arrives carrying `day`, which this view deliberately does not
    // offer. Refusing to draw over it would make the switch look broken.
    render({}, viewOf({ mode: 'day' }));

    expect(screen.getByRole('heading', { name: 'March 2026' })).toBeVisible();
  });

  it('moves the window without putting it in the address', async () => {
    // The claim the local-state decision rests on, asserted rather than implied: a link shared in
    // March must not open on March in June, so paging has to leave the address exactly as it was.
    // Without the address assertion this test would still pass if somebody moved the anchor into
    // `useViewState`, which is the one change it exists to catch.
    const user = person();
    const view = viewOf();

    renderAt(
      <>
        <TimelineView
          container={aContainer({ schema: SCHEMA, views: views([view]), children: [ROLLOUT] })}
          view={view}
          onOpen={vi.fn()}
        />
        <CurrentSearch />
      </>,
      '/?mode=month&sort=title',
    );

    const address = (): string | null =>
      screen.getByRole('status', { name: 'Address' }).textContent;
    const before = address();

    expect(before).toBe('?mode=month&sort=title');

    await user.click(screen.getByRole('button', { name: 'Next month' }));
    expect(screen.getByRole('heading', { name: 'April 2026' })).toBeVisible();
    expect(address()).toBe(before);

    await user.click(screen.getByRole('button', { name: 'Today' }));
    expect(screen.getByRole('heading', { name: 'March 2026' })).toBeVisible();
    expect(address()).toBe(before);
  });
});

describe('correcting the dates', () => {
  it('reschedules an item from the keyboard without a pointer', async () => {
    // The only way to change a bar in this build, and it has to be reachable without a mouse: there
    // is no drag here at all, so a control that only a pointer could reach would leave a keyboard
    // user with no way to move anything.
    const user = person();
    const { setProperties } = render({ children: [ROLLOUT] });

    await tabTo(user, screen.getByRole('button', { name: 'Reschedule Rollout' }));
    await user.keyboard('{Enter}');

    const start = screen.getByLabelText('Starts');
    await tabTo(user, start);
    await user.clear(start);
    await user.keyboard('2026-03-20');

    expect(setProperties).toHaveBeenCalledWith('item-rollout', { starts: '2026-03-20' });
  });

  it('keeps the keyboard on the field when an edit moves an item off the axis', async () => {
    // A property write is optimistic, so typing a start that now falls after the end moves the item
    // from the grid to a band below during the same render. With the panel rendered inside the row
    // it belonged to, the row unmounted and the focused field went with it - in a view whose only
    // editing path is the keyboard.
    const user = person();
    renderLive({ items: [ROLLOUT] });

    await user.click(screen.getByRole('button', { name: 'Reschedule Rollout' }));

    const start = screen.getByLabelText('Starts');
    await user.clear(start);
    await user.keyboard('2026-03-20');

    // Rollout now starts after it ends, so it has left the grid.
    expect(
      screen.getByRole('region', { name: '1 item has an end date before its start date' }),
    ).toBeVisible();

    // And the field somebody was typing in is still the field they are typing in.
    expect(screen.getByLabelText('Starts')).toHaveFocus();

    // Said out loud, because the move is otherwise silent to anybody not watching the screen.
    expect(
      screen.getByText('Listed below: its end date falls before its start date.'),
    ).toBeVisible();
  });

  it('writes each end of the span on its own, so a bad end cannot block a good start', async () => {
    // Two independent writes and never one. The server does not refuse an end that falls before its
    // start - it cannot, because two writes are never both valid at every instant - so correcting a
    // reversed pair must not depend on which end somebody happens to fix first.
    const user = person();
    const { setProperties } = render({ children: [ROLLOUT] });

    await user.click(screen.getByRole('button', { name: 'Reschedule Rollout' }));

    await user.clear(screen.getByLabelText('Ends'));
    await user.type(screen.getByLabelText('Ends'), '2026-03-09');

    expect(setProperties).toHaveBeenCalledTimes(1);
    expect(setProperties).toHaveBeenCalledWith('item-rollout', { ends: '2026-03-09' });
  });

  it('offers the same correction to an item whose dates contradict each other', async () => {
    const user = person();
    const { setProperties } = render({ children: [MUDDLE] });

    await user.click(screen.getByRole('button', { name: 'Reschedule Muddle' }));
    await user.clear(screen.getByLabelText('Ends'));
    await user.type(screen.getByLabelText('Ends'), '2026-03-25');

    expect(setProperties).toHaveBeenCalledWith('item-muddle', { ends: '2026-03-25' });
  });

  it('puts a refused write in the field that caused it, and says it exactly once', async () => {
    // `useContainer` answers a refusal on two channels and its contract says a caller reads one.
    // Every write this view makes is awaited, so the field is the right place - and the banner the
    // calendar draws for its drag would be the same sentence a second time.
    const user = person();
    renderLive({ items: [ROLLOUT], refuse: '"Ends" is required on this item.' });

    await user.click(screen.getByRole('button', { name: 'Reschedule Rollout' }));
    await user.clear(screen.getByLabelText('Ends'));
    await user.type(screen.getByLabelText('Ends'), '2026-03-09');

    expect(await screen.findAllByText('"Ends" is required on this item.')).toHaveLength(1);
  });

  it('says why there is no end field when the view names no end property', async () => {
    // Not an empty box and not a disabled control: there is genuinely nothing to edit, and the way
    // to get one is a view setting rather than anything on this row.
    const user = person();
    render({ children: [LAUNCH] }, viewOf({ endDateProperty: null }));

    await user.click(screen.getByRole('button', { name: 'Reschedule Launch' }));

    expect(screen.queryByLabelText('Ends')).not.toBeInTheDocument();
    expect(
      screen.getByText(
        /This timeline names no end date property, so every item on it is a milestone/,
      ),
    ).toBeVisible();
  });
});

describe('when the configuration has drifted', () => {
  it('says a timeline with no start property cannot be drawn, and that nothing was lost', () => {
    render({ children: [ROLLOUT] }, viewOf({ dateProperty: null }));

    const panel = screen.getByRole('alert');

    expect(
      within(panel).getByRole('heading', { name: 'This timeline cannot be drawn' }),
    ).toBeVisible();
    expect(within(panel).getByText(/every item is still here/i)).toBeVisible();
  });

  it('refuses to draw when the start property is no longer a date', () => {
    // Retyping a property is one edit in the schema panel, made by somebody who has never seen this
    // view. The type is named by the word the interface uses, not by the stored token.
    render({ children: [ROLLOUT] }, viewOf({ dateProperty: 'owner' }));

    expect(screen.getByText(/which is a text property rather than a date/)).toBeVisible();
  });

  it('keeps drawing when only the end property has gone, and says the bars became milestones', () => {
    // The end was never a requirement, so losing it must not take every item off the screen. The
    // sentence somebody needs is not "your end dates are missing" but "your items are not".
    render({ children: [ROLLOUT] }, viewOf({ endDateProperty: 'delivered' }));

    expect(
      screen.getByText(
        `Bars ended on "delivered", which is no longer one of this item's properties. Every item is still here, drawn as a milestone on the day it starts.`,
      ),
    ).toBeVisible();

    expect(
      screen.getByRole('button', { name: 'Rollout, starts Tuesday 3 March 2026, no end date' }),
    ).toBeVisible();
  });

  it('reports a view Core says it cannot draw without touching the items', () => {
    const view = viewOf();

    render({ children: [ROLLOUT], views: views([view], { unrenderable: [view.id] }) }, view);

    expect(screen.getByText(/Core reports that "Delivery" can no longer be drawn/)).toBeVisible();
  });
});

describe('the timeline at a phone width', () => {
  it('lists every dated item under its day, whatever window the grid would show, with no grid chrome', () => {
    stubViewport(false);
    render({ children: [ROLLOUT, LEGACY, IDEA] });

    expect(screen.queryByRole('navigation', { name: 'Timeline scale' })).toBeNull();
    expect(screen.queryByRole('button', { name: /timeline grid/i })).toBeNull();
    const schedule = screen.getByRole('region', { name: 'Timeline schedule' });
    expect(within(schedule).getByRole('button', { name: 'Legacy' })).toBeVisible();
    expect(within(schedule).getByRole('heading', { name: 'Unscheduled' })).toBeVisible();
    expect(within(schedule).getByRole('button', { name: /^Edit dates: Idea/ })).toBeVisible();
  });

  it("edits dates in the view's one reschedule panel, which survives the row being re-sorted", async () => {
    stubViewport(false);
    const user = person();
    const { setProperties } = render({ children: [ROLLOUT] });

    await user.click(screen.getByRole('button', { name: /^Edit dates: Rollout/ }));
    const start = screen.getByLabelText('Starts');
    await user.clear(start);
    await user.keyboard('2026-03-20');

    expect(setProperties).toHaveBeenCalledWith('item-rollout', { starts: '2026-03-20' });
    expect(screen.getByRole('region', { name: 'Reschedule Rollout' })).toContainElement(start);
    expect(screen.getByRole('button', { name: /^Edit dates: Rollout/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });
});

describe('the touch targets on the track', () => {
  it('declares the hit-area extension classes on a bar', () => {
    render({ children: [ROLLOUT] });

    // A class contract and nothing more. `h-6` is 20.4px at this density, under WCAG 2.5.8's
    // floor, and the before: pseudo-element extends the hit area one spacing step past each edge
    // without moving a drawn pixel - the pane-divider technique. The extension is the row's own
    // space: each bar sits in a `td p-1`, so successive rows leave 3.4px + a border + 3.4px
    // between them and two extensions meet without overlapping. jsdom performs no layout, so none
    // of that is measured here - the classes are the claim, and the measurement belongs to a
    // real-browser pass.
    const bar = screen.getByRole('button', { name: /^Rollout,/ });
    expect(bar).toHaveClass('h-6', 'relative', 'before:absolute', 'before:-inset-y-1');
  });

  it('declares the same extension on a milestone, which shares the bar height', () => {
    render({ children: [LAUNCH] });

    const milestone = screen.getByRole('button', { name: /^Launch,/ });
    expect(milestone).toHaveClass('h-6', 'relative', 'before:absolute', 'before:-inset-y-1');
  });

  it('declares the extension classes on the scale switcher chips, which draw shorter than the floor', () => {
    render({ children: [ROLLOUT] });

    const nav = screen.getByRole('navigation', { name: 'Timeline scale' });
    for (const grain of ['week', 'month', 'quarter']) {
      expect(within(nav).getByRole('button', { name: grain })).toHaveClass(
        'relative',
        'before:absolute',
        'before:-inset-y-0.5',
      );
    }
  });

  it('declares the horizontal extension on an off-axis title, whose width with px-0 is only its text', () => {
    render({ children: [IDEA] });

    expect(screen.getByRole('button', { name: 'Idea, no start date' })).toHaveClass(
      'relative',
      'before:absolute',
      'before:-inset-x-0.5',
    );
  });
});

describe('timeline item context menus', () => {
  it.each([
    { entry: ROLLOUT, name: /^Rollout,/ },
    { entry: LAUNCH, name: /^Launch,/ },
    { entry: IDEA, name: /^Idea,/ },
  ])('offers rescheduling from the context menu for $entry.title', async ({ entry, name }) => {
    stubViewport(true);
    render({ children: [entry] });
    fireEvent.contextMenu(screen.getByRole('button', { name }), { clientX: 40, clientY: 60 });
    const menu = screen.getByRole('menu', { name: `${entry.title} actions` });
    await person().click(within(menu).getByRole('menuitem', { name: 'Reschedule…' }));
    expect(screen.getByRole('region', { name: `Reschedule ${entry.title}` })).toHaveFocus();
  });

  it.each([280, 320, 768])(
    'keeps item actions reachable in the schedule at width %i',
    async (width) => {
      stubViewport(width);
      render({ children: [ROLLOUT] });
      const target = screen.getByRole('button', { name: width === 768 ? /^Rollout,/ : 'Rollout' });
      fireEvent.contextMenu(target, { clientX: 20, clientY: 50 });
      const menu = screen.getByRole('menu', { name: 'Rollout actions' });
      await person().click(within(menu).getByRole('menuitem', { name: 'Open' }));
      expect(screen.queryByRole('menu', { name: 'Rollout actions' })).not.toBeInTheDocument();
    },
  );
});
