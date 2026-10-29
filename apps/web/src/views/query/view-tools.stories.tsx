import { useState, type ReactElement } from 'react';
import { MemoryRouter } from 'react-router';
import { within } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';

import { ViewSchema } from '../../collections/core/container-model';
import { ViewTools } from '../core/view-tools';
import { useViewState } from '../../collections/core/view-state';

export default { title: 'Nix/Views/Search and filters', parameters: { layout: 'padded' } };

function Harness({
  query = false,
  refused = false,
}: {
  readonly query?: boolean;
  readonly refused?: boolean;
}): ReactElement {
  const state = useViewState();
  const [view, setView] = useState(() =>
    ViewSchema.parse({
      id: 'by-status',
      name: 'By status',
      kind: query ? 'query' : 'list',
      columns: [],
      groupBy: null,
      groupOrder: [],
      dateProperty: null,
      sortBy: null,
      sortDescending: false,
      mode: null,
      coverProperty: null,
      endDateProperty: null,
      cardSize: null,
      layout: null,
      filters: [{ property: 'status', operator: 'equals', value: 'Doing' }],
    }),
  );
  return (
    <ViewTools
      view={view}
      schema={[
        {
          key: 'status',
          label: 'Status',
          type: 'select',
          options: ['Todo', 'Doing', 'Done'],
          required: false,
        },
      ]}
      viewState={state}
      onSave={(filters) => {
        if (refused) return Promise.resolve('You cannot edit this view.');
        setView({ ...view, filters: [...filters] });
        return Promise.resolve(null);
      }}
    />
  );
}

export function Container(): ReactElement {
  return (
    <MemoryRouter>
      <Harness />
    </MemoryRouter>
  );
}

export const SavedFilters = {
  render: Container,
  play: async ({ canvasElement }: { readonly canvasElement: HTMLElement }): Promise<void> => {
    await userEvent.click(
      within(canvasElement).getByRole('button', { name: 'View options, 1 saved filters' }),
    );
  },
};

export function Query(): ReactElement {
  return (
    <MemoryRouter initialEntries={['/?search=Water']}>
      <Harness query />
    </MemoryRouter>
  );
}

export const Refused = {
  render: (): ReactElement => (
    <MemoryRouter>
      <Harness refused />
    </MemoryRouter>
  ),
  play: async ({ canvasElement }: { readonly canvasElement: HTMLElement }): Promise<void> => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'View options, 1 saved filters' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Save view filters' }));
  },
};

export const NarrowPane = {
  render: (): ReactElement => (
    <section aria-label="View tools pane" className="w-64 max-w-full">
      <MemoryRouter initialEntries={['/?search=Water&f.status=Doing']}>
        <Harness />
      </MemoryRouter>
    </section>
  ),
  play: async ({ canvasElement }: { readonly canvasElement: HTMLElement }): Promise<void> => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'View options, 1 saved filters' }));
    const region = canvas.getByRole('region', { name: 'View tools pane' });
    if (region.scrollWidth > region.clientWidth)
      throw new Error('Search and filter controls must fit within a narrow pane.');
  },
};
export const DarkNarrowPane = { ...NarrowPane, globals: { ground: 'dark' } };
export const MediumPane = {
  ...NarrowPane,
  render: (): ReactElement => (
    <section aria-label="View tools pane" className="w-128 max-w-full">
      <MemoryRouter initialEntries={['/?search=Water&f.status=Doing']}>
        <Harness />
      </MemoryRouter>
    </section>
  ),
};
export const DarkMediumPane = { ...MediumPane, globals: { ground: 'dark' } };
