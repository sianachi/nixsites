import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';

import type { PropertyDefinition, View } from '@nix/web-collections/core/container-model';
import { StructuredViewConfiguration } from '../../../core/structured-view-configuration';
import { aView } from '@nix/web-collections/testing/view-fixture';

const FIELDS: readonly PropertyDefinition[] = [
  {
    key: 'status',
    label: 'Status',
    type: 'select',
    options: ['Planned', 'Done'],
    required: false,
  },
  {
    key: 'priority',
    label: 'Priority',
    type: 'select',
    options: ['High', 'Low'],
    required: false,
  },
];

function BoardConfiguration(): ReactNode {
  const [view, setView] = useState<View>(
    aView({
      kind: 'board',
      groupBy: 'status',
      groupOrder: ['Planned', 'Done'],
      columns: ['title', 'status'],
    }),
  );
  return <StructuredViewConfiguration view={view} fields={FIELDS} onChange={setView} />;
}

const DATE_FIELDS: readonly PropertyDefinition[] = [
  { key: 'starts', label: 'Starts', type: 'date', options: [], required: false },
  { key: 'ends', label: 'Ends', type: 'date', options: [], required: false },
];

function CalendarConfiguration(): ReactNode {
  const [view, setView] = useState<View>(aView({ kind: 'calendar', dateProperty: 'starts' }));
  return <StructuredViewConfiguration view={view} fields={DATE_FIELDS} onChange={setView} />;
}

describe('shared structured-view configuration', () => {
  it('allows new lines and multiword board columns to be typed', async () => {
    const user = userEvent.setup();
    render(<BoardConfiguration />);
    const order = screen.getByRole('textbox', { name: 'Column order' });
    await user.clear(order);
    await user.type(order, 'To do{Enter}In progress{Enter}Done{Enter}');
    expect(order).toHaveValue('To do\nIn progress\nDone\n');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Group by' }), 'priority');
    expect(order).toHaveValue('');
  });

  it('edits configured properties and ordered visible fields through one control surface', async () => {
    const user = userEvent.setup();
    render(<BoardConfiguration />);

    await user.selectOptions(screen.getByRole('combobox', { name: 'Group by' }), 'priority');
    expect(screen.getByRole('combobox', { name: 'Group by' })).toHaveValue('priority');
    expect(screen.getByRole('textbox', { name: 'Column order' })).toHaveValue('');

    await user.click(screen.getByRole('button', { name: 'Hide Status' }));
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Add visible field' }),
      'priority',
    );

    expect(screen.getByRole('button', { name: 'Hide Priority' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Hide Status' })).not.toBeInTheDocument();
  });

  it('offers a calendar view an optional End field beside Place by', async () => {
    // The setting a calendar view's endDateProperty needs was reachable nowhere - view-kinds.tsx
    // offered it only to a timeline. This is the regression test for the fix: the shared editor
    // draws it the moment the registry says the kind configures it.
    const user = userEvent.setup();
    render(<CalendarConfiguration />);

    expect(screen.getByRole('combobox', { name: 'Place by' })).toHaveValue('starts');

    const end = screen.getByRole('combobox', { name: 'End' });
    expect(end).toHaveValue('');

    await user.selectOptions(end, 'ends');
    expect(end).toHaveValue('ends');
  });

  it('writes the sort list with the single key, keeping later keys that do not repeat it', async () => {
    const user = userEvent.setup();
    let latest: View | null = null;

    function Harness(): ReactNode {
      const [view, setView] = useState<View>(
        aView({
          kind: 'list',
          sortBy: 'status',
          sortDescending: true,
          sorts: [
            { property: 'status', descending: true },
            { property: 'priority', descending: false },
            { property: 'title', descending: true },
          ],
        }),
      );
      return (
        <StructuredViewConfiguration
          view={view}
          fields={FIELDS}
          onChange={(next) => {
            latest = next;
            setView(next);
          }}
        />
      );
    }

    render(<Harness />);

    await user.selectOptions(screen.getByRole('combobox', { name: 'Sort by' }), 'priority');
    expect(latest).toMatchObject({
      sortBy: 'priority',
      sortDescending: true,
      sorts: [
        { property: 'priority', descending: true },
        { property: 'title', descending: true },
      ],
    });

    await user.click(screen.getByRole('checkbox', { name: 'Descending order' }));
    expect(latest).toMatchObject({
      sortDescending: false,
      sorts: [
        { property: 'priority', descending: false },
        { property: 'title', descending: true },
      ],
    });

    await user.selectOptions(screen.getByRole('combobox', { name: 'Sort by' }), '');
    expect(latest).toMatchObject({ sortBy: null, sorts: [] });
  });

  it('offers saved filters on every container kind that applies them', () => {
    for (const kind of ['list', 'sheet', 'board', 'gallery', 'calendar', 'timeline']) {
      const { unmount } = render(
        <StructuredViewConfiguration
          view={aView({ kind })}
          fields={FIELDS}
          onChange={() => undefined}
        />,
      );
      expect(screen.getByRole('button', { name: 'Add a filter' })).toBeInTheDocument();
      unmount();
    }
  });

  it('offers a chart no filters, because its bars are counted without them', () => {
    render(
      <StructuredViewConfiguration
        view={aView({ kind: 'chart', groupBy: 'status' })}
        fields={FIELDS}
        onChange={() => undefined}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Add a filter' })).not.toBeInTheDocument();
  });
});
