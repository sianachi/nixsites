import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { Item } from '../../views/core/container-model';
import { PropertyInput } from '../../properties/property-input';
import { propertyOf } from '../property-fixture';

process.env.TZ = 'Pacific/Honolulu';

function itemWith(properties: Record<string, unknown>): Item {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    workspaceId: '22222222-2222-4222-8222-222222222222',
    parentId: '33333333-3333-4333-8333-333333333333',
    type: 'note',
    title: 'Kickoff',
    hasChildren: false,
    seq: 1,
    lifecycleState: 'active',
    properties,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

const MOMENT = '2026-03-17T09:00:00-10:00[Pacific/Honolulu]';

describe('multi-control property inputs', () => {
  it.each([
    ['timestamp', 'Date and time'],
    ['reminder', 'Date and time'],
    ['datetime', 'Date'],
  ] as const)('names a %s as one group and ties a refusal to its control', (type, part) => {
    render(
      <PropertyInput
        item={itemWith({ when: MOMENT })}
        property={propertyOf({ key: 'when', label: 'Meeting', type })}
        error="Core said no."
        onCommit={vi.fn()}
      />,
    );

    expect(screen.getByRole('group', { name: 'Meeting' })).toBeVisible();
    const control = screen.getByLabelText(part);
    expect(control).toHaveAccessibleDescription('Core said no.');
    expect(control).toBeInvalid();
  });

  it.each([
    ['timestamp', 'Date and time'],
    ['reminder', 'Date and time'],
    ['datetime', 'Date'],
    ['date', 'When'],
  ] as const)(
    'clears a %s with its own button and puts focus back in the field',
    async (type, part) => {
      const person = userEvent.setup();
      const onCommit = vi.fn();

      render(
        <PropertyInput
          item={itemWith({ when: type === 'date' ? '2026-03-17' : MOMENT })}
          property={propertyOf({ key: 'when', label: 'When', type })}
          onCommit={onCommit}
        />,
      );

      await person.click(screen.getByRole('button', { name: 'Clear When' }));

      expect(onCommit).toHaveBeenLastCalledWith(null);
      expect(screen.getByLabelText(part)).toHaveFocus();
    },
  );

  it('shows no clear button while nothing is stored', () => {
    render(
      <PropertyInput
        item={itemWith({})}
        property={propertyOf({ key: 'when', label: 'When', type: 'date' })}
        onCommit={vi.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: /Clear/ })).toBeNull();
  });

  it('puts a typed field back on Escape without writing it', async () => {
    const person = userEvent.setup();
    const onCommit = vi.fn();

    render(
      <PropertyInput
        item={itemWith({ owner: 'Ada' })}
        property={propertyOf({ key: 'owner', label: 'Owner' })}
        onCommit={onCommit}
      />,
    );

    const box = screen.getByRole('textbox', { name: 'Owner' });
    await person.type(box, 'zzz');
    await person.keyboard('{Escape}');
    await person.tab();

    expect(box).toHaveValue('Ada');
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('puts a date back on Escape', async () => {
    const person = userEvent.setup();

    render(
      <PropertyInput
        item={itemWith({ when: '2026-03-17' })}
        property={propertyOf({ key: 'when', label: 'When', type: 'date' })}
        onCommit={vi.fn()}
      />,
    );

    const box = screen.getByLabelText('When');
    await person.clear(box);
    await person.keyboard('{Escape}');

    expect(box).toHaveValue('2026-03-17');
  });

  it('shows the time zone select in the panel and on a card but not in a table cell', () => {
    const property = propertyOf({ key: 'when', label: 'When', type: 'timestamp' });
    const counts = (['panel', 'card', 'cell'] as const).map((density) => {
      const { container, unmount } = render(
        <PropertyInput
          item={itemWith({ when: MOMENT })}
          property={property}
          density={density}
          onCommit={vi.fn()}
        />,
      );
      const result = {
        density,
        zoneSelects: screen.queryAllByRole('combobox').length,
        options: container.querySelectorAll('option').length,
        nodes: container.querySelectorAll('*').length,
      };
      unmount();
      return result;
    });

    expect(counts.map((entry) => entry.zoneSelects)).toEqual([1, 1, 0]);

    // Measured, not asserted as a ratio: a cell used to carry the whole zone list like the panel.
    const [panel, , cell] = counts;
    expect(cell?.options).toBe(0);
    expect(panel?.options).toBeGreaterThan(100);
  });

  it('opens a multi-select cell as one line and toggles from a popover', async () => {
    const person = userEvent.setup();
    const onCommit = vi.fn();

    render(
      <PropertyInput
        item={itemWith({ tags: ['a'] })}
        property={propertyOf({
          key: 'tags',
          label: 'Tags',
          type: 'multi_select',
          options: ['a', 'b', 'c'],
        })}
        density="cell"
        onCommit={onCommit}
      />,
    );

    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);

    await person.click(screen.getByRole('button', { name: /Tags for Kickoff/ }));
    await person.click(screen.getByRole('checkbox', { name: 'b' }));

    expect(onCommit).toHaveBeenCalledWith(['a', 'b']);
  });

  it('draws the checkbox property with the house checkbox', async () => {
    const person = userEvent.setup();
    const onCommit = vi.fn();

    render(
      <PropertyInput
        item={itemWith({ done: false })}
        property={propertyOf({ key: 'done', label: 'Done', type: 'checkbox' })}
        onCommit={onCommit}
      />,
    );

    await person.click(screen.getByRole('checkbox', { name: 'Done' }));

    expect(onCommit).toHaveBeenCalledWith(true);
  });

  it('words a priority the same in the editor as on the display', () => {
    render(
      <PropertyInput
        item={itemWith({ p: 2 })}
        property={propertyOf({ key: 'p', label: 'Priority', type: 'priority' })}
        onCommit={vi.fn()}
      />,
    );

    expect(screen.getByRole('option', { name: 'P2 High' })).toBeInTheDocument();
  });
});
