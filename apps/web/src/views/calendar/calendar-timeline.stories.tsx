import { within } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';

import type { View } from '../../collections/core/container-model';
import { storyContainer, storyItem } from '../../collections/core/story-container';
import { ContainerView } from '../core/container-view';
import { VIEW_GUTTER } from '../../collections/core/view-gutter';
import { TimelineView } from '../timeline/timeline-view';
import { CalendarView } from './calendar-view';

export default { title: 'Nix/Views/Calendar and timeline', parameters: { layout: 'padded' } };

function assertCheckboxReveals(checkbox: HTMLElement): void {
  const control = checkbox.closest('.group')?.querySelector<HTMLElement>('button');
  if (control === null || control === undefined) throw new Error('Missing item focus target.');
  control.focus();
  const wrapper = checkbox.parentElement?.parentElement;
  if (wrapper === null || wrapper === undefined || getComputedStyle(wrapper).opacity !== '1') {
    throw new Error('Selecting controls must reveal on item focus before an item is selected.');
  }
}

function Example({ kind }: { readonly kind: 'calendar' | 'timeline' }): ReactNode {
  const now = new Date();
  const date = `${String(now.getFullYear()).padStart(4, '0')}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const view: View = {
    id: kind,
    name: 'Plans',
    kind,
    columns: [],
    groupBy: null,
    groupOrder: [],
    dateProperty: 'starts',
    endDateProperty: 'ends',
    sortBy: null,
    sortDescending: false,
    mode: null,
    coverProperty: null,
    cardSize: null,
    layout: null,
    filters: [],
  };
  const container = storyContainer(
    [
      storyItem('today', 'A long plan title that remains reachable on a small phone', 1, {
        starts: date,
        ends: date,
      }),
      storyItem('later', 'An idea to schedule', 2),
    ],
    [
      { key: 'starts', label: 'Starts', type: 'date', options: [], required: false },
      { key: 'ends', label: 'Ends', type: 'date', options: [], required: false },
    ],
  );
  const props = { container, view, onOpen: () => undefined };
  return (
    <MemoryRouter>
      <div className={VIEW_GUTTER}>
        {kind === 'calendar' ? <CalendarView {...props} /> : <TimelineView {...props} />}
      </div>
    </MemoryRouter>
  );
}

export const Calendar = { render: (): ReactNode => <Example kind="calendar" /> };
export const Timeline = { render: (): ReactNode => <Example kind="timeline" /> };
/** Exercises the shared selection tray so axe sees calendar selection controls. */
export const CalendarSelection = {
  render: (): ReactNode => {
    const now = new Date();
    const date = `${String(now.getFullYear()).padStart(4, '0')}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const view: View = {
      id: 'calendar-selection',
      name: 'Plans',
      kind: 'calendar',
      columns: [],
      groupBy: null,
      groupOrder: [],
      dateProperty: 'starts',
      endDateProperty: 'ends',
      sortBy: null,
      sortDescending: false,
      mode: null,
      coverProperty: null,
      cardSize: null,
      layout: null,
      filters: [],
    };
    return (
      <MemoryRouter>
        <div className={VIEW_GUTTER}>
          <ContainerView
            container={storyContainer(
              [storyItem('today', 'Today', 1, { starts: date, ends: date })],
              [
                { key: 'starts', label: 'Starts', type: 'date', options: [], required: false },
                { key: 'ends', label: 'Ends', type: 'date', options: [], required: false },
              ],
            )}
            view={view}
            onOpen={() => undefined}
          />
        </div>
      </MemoryRouter>
    );
  },
  play: async ({ canvasElement }: { readonly canvasElement: HTMLElement }): Promise<void> => {
    const canvas = within(canvasElement);
    const checkbox = canvas.getByRole('checkbox', { name: 'Select Today' });
    await userEvent.hover(checkbox);
    assertCheckboxReveals(checkbox);
    await userEvent.click(checkbox);
    canvas.getByRole('toolbar', { name: 'Selected items' });
  },
};
/** Exercises the shared selection tray so axe sees timeline selection controls. */
export const TimelineSelection = {
  render: (): ReactNode => {
    const now = new Date();
    const date = `${String(now.getFullYear()).padStart(4, '0')}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const view: View = {
      id: 'timeline-selection',
      name: 'Plans',
      kind: 'timeline',
      columns: [],
      groupBy: null,
      groupOrder: [],
      dateProperty: 'starts',
      endDateProperty: 'ends',
      sortBy: null,
      sortDescending: false,
      mode: null,
      coverProperty: null,
      cardSize: null,
      layout: null,
      filters: [],
    };
    return (
      <MemoryRouter>
        <div className={VIEW_GUTTER}>
          <ContainerView
            container={storyContainer(
              [storyItem('today', 'Today', 1, { starts: date, ends: date })],
              [
                { key: 'starts', label: 'Starts', type: 'date', options: [], required: false },
                { key: 'ends', label: 'Ends', type: 'date', options: [], required: false },
              ],
            )}
            view={view}
            onOpen={() => undefined}
          />
        </div>
      </MemoryRouter>
    );
  },
  play: async ({ canvasElement }: { readonly canvasElement: HTMLElement }): Promise<void> => {
    const canvas = within(canvasElement);
    const checkbox = canvas.getByRole('checkbox', { name: 'Select Today' });
    await userEvent.hover(checkbox);
    assertCheckboxReveals(checkbox);
    await userEvent.click(checkbox);
    canvas.getByRole('toolbar', { name: 'Selected items' });
  },
};
export const CalendarPhone = {
  ...Calendar,
  parameters: { viewport: { defaultViewport: 'mobile1' } },
};
export const TimelinePhone = {
  ...Timeline,
  parameters: { viewport: { defaultViewport: 'mobile1' } },
};
export const DarkCalendarPhone = { ...CalendarPhone, globals: { ground: 'dark' } };
export const DarkTimelinePhone = { ...TimelinePhone, globals: { ground: 'dark' } };

function checkNarrowView({ canvasElement }: { readonly canvasElement: HTMLElement }): void {
  const region = within(canvasElement).getByRole('region', { name: 'Narrow calendar view' });
  if (region.scrollWidth > region.clientWidth) {
    throw new Error('Calendar and timeline controls must fit within a narrow pane.');
  }
}

export const TinyCalendar = {
  render: (): ReactNode => (
    <section aria-label="Narrow calendar view" className="w-64 max-w-full">
      <Example kind="calendar" />
    </section>
  ),
  play: checkNarrowView,
};
export const TinyTimeline = {
  render: (): ReactNode => (
    <section aria-label="Narrow calendar view" className="w-64 max-w-full">
      <Example kind="timeline" />
    </section>
  ),
  play: checkNarrowView,
};
export const DarkTinyCalendar = { ...TinyCalendar, globals: { ground: 'dark' } };
export const DarkTinyTimeline = { ...TinyTimeline, globals: { ground: 'dark' } };
export const TinyTimelineRescheduling = {
  ...TinyTimeline,
  play: async ({ canvasElement }: { readonly canvasElement: HTMLElement }): Promise<void> => {
    await userEvent.click(
      within(canvasElement).getByRole('button', {
        name: 'Reschedule An idea to schedule',
      }),
    );
    checkNarrowView({ canvasElement });
  },
};
export const DarkTinyTimelineRescheduling = {
  ...TinyTimelineRescheduling,
  globals: { ground: 'dark' },
};
