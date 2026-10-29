import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderAt } from '@nix/web-editor/testing/render-with-router';
import { aView, item } from '../../view-fixture';
import { aContainer } from '../../container-fixture';
import type {
  EffectiveSchema,
  Item,
  PropertyDefinition,
  View,
} from '../../../views/core/container-model';
import type { ContainerData } from '../../../views/core/use-container';
import { MatrixView } from '../../../views/matrix/matrix-view';

const URGENCY: PropertyDefinition = {
  key: 'urgency',
  label: 'Urgency',
  type: 'select',
  options: ['Urgent', 'Later'],
  required: false,
};
const IMPORTANT: PropertyDefinition = {
  key: 'important',
  label: 'Important',
  type: 'checkbox',
  options: [],
  required: false,
};
const NOTES: PropertyDefinition = {
  key: 'notes',
  label: 'Notes',
  type: 'text',
  options: [],
  required: false,
};

const SCHEMA: EffectiveSchema = {
  properties: [URGENCY, IMPORTANT, NOTES],
  declared: [URGENCY, IMPORTANT, NOTES],
  inherit: true,
};

const CARDS = [
  item('fire', 'Put out the fire', 1, { urgency: 'Urgent', important: true }),
  item('plan', 'Plan the quarter', 2, { urgency: 'Later', important: true }),
  item('mail', 'Answer mail', 3, { urgency: 'Urgent' }),
];

function renderMatrix(
  view: Partial<View> = {},
  container: Partial<ContainerData> = {},
): ReturnType<typeof renderAt> {
  return renderAt(
    <MatrixView
      container={aContainer({ schema: SCHEMA, children: CARDS, ...container })}
      view={aView({ kind: 'matrix', groupBy: 'urgency', rowBy: 'important', columns: [], ...view })}
      onOpen={vi.fn()}
    />,
  );
}

describe('MatrixView', () => {
  it('lays cards out in cells named by their row and column headers', () => {
    renderMatrix();

    expect(screen.getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual([
      'Urgent',
      'Later',
    ]);
    expect(screen.getAllByRole('rowheader').map((cell) => cell.textContent)).toEqual([
      'Not important',
      'Important',
    ]);
    const urgentImportant = screen.getByRole('list', { name: 'Important, Urgent cards' });
    expect(within(urgentImportant).getByText('Put out the fire')).toBeInTheDocument();
    expect(
      within(screen.getByRole('list', { name: 'Not important, Urgent cards' })).getByText(
        'Answer mail',
      ),
    ).toBeInTheDocument();
  });

  it('moves a card from the keyboard by writing both properties in one update', async () => {
    const user = userEvent.setup();
    const setProperties = vi.fn(() => Promise.resolve(null));
    renderMatrix({}, { setProperties });

    await user.click(screen.getByRole('button', { name: 'Move Answer mail to' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Important, Later' }));

    expect(setProperties).toHaveBeenCalledTimes(1);
    expect(setProperties).toHaveBeenCalledWith('mail', { important: true, urgency: 'Later' });
  });

  it('moves a dropped card into the cell it lands on', () => {
    const setProperties = vi.fn(() => Promise.resolve(null));
    renderMatrix({}, { setProperties });

    const card = screen.getByText('Plan the quarter').closest('[draggable="true"]');
    if (card === null) throw new Error('the card is not draggable');
    fireEvent.dragStart(card, { dataTransfer: { setData: vi.fn(), effectAllowed: '' } });
    const target = screen.getByRole('list', { name: 'Not important, Urgent cards' }).closest('td');
    if (target === null) throw new Error('no cell');
    fireEvent.dragOver(target);
    fireEvent.drop(target);

    expect(setProperties).toHaveBeenCalledWith('plan', { important: false, urgency: 'Urgent' });
  });

  it('says so and keeps the card where it was when a move is refused', async () => {
    const user = userEvent.setup();
    renderMatrix({}, { setProperties: () => Promise.resolve('This item is read-only.') });

    await user.click(screen.getByRole('button', { name: 'Move Answer mail to' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Important, Later' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('This item is read-only.');
  });

  it('hides empty rows and columns until asked to show them', async () => {
    const user = userEvent.setup();
    renderMatrix({ groupBy: 'urgency', rowBy: 'important' }, { children: CARDS.slice(0, 1) });

    expect(screen.getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual(['Urgent']);
    await user.click(screen.getByRole('button', { name: 'Show empty rows and columns' }));

    expect(screen.getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual([
      'Urgent',
      'Later',
      'No urgency',
    ]);
  });

  it('explains itself when an axis cannot be drawn', () => {
    renderMatrix({ rowBy: 'notes' });

    expect(screen.getByText('This matrix has no rows to draw')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('refuses to draw one property on both axes', () => {
    renderMatrix({ rowBy: 'urgency' });

    expect(screen.getByText('This matrix uses one property for both axes')).toBeInTheDocument();
  });

  it('puts focus back on the moved card once it lands in its new cell', async () => {
    const user = userEvent.setup();
    function Moving(): ReactNode {
      const [children, setChildren] = useState<readonly Item[]>(CARDS);
      return (
        <MatrixView
          container={aContainer({
            schema: SCHEMA,
            children,
            setProperties: (itemId, values) => {
              setChildren((current) =>
                current.map((entry) =>
                  entry.id === itemId
                    ? { ...entry, properties: { ...entry.properties, ...values } }
                    : entry,
                ),
              );
              return Promise.resolve(null);
            },
          })}
          view={aView({ kind: 'matrix', groupBy: 'urgency', rowBy: 'important', columns: [] })}
          onOpen={vi.fn()}
        />
      );
    }
    renderAt(<Moving />);

    await user.click(screen.getByRole('button', { name: 'Move Answer mail to' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Important, Later' }));

    const cell = screen.getByRole('list', { name: 'Important, Later cards' });
    await waitFor(() => {
      expect(within(cell).getByRole('button', { name: 'Answer mail' })).toHaveFocus();
    });
  });

  it('offers a create control in each cell that fills in both of its values', () => {
    renderMatrix();

    expect(
      screen.getByRole('button', { name: 'Add an item to Important, Urgent' }),
    ).toBeInTheDocument();
  });

  it('shows a card field as a button named for the field and the card, empty ones included', () => {
    renderMatrix({ columns: ['notes'] });

    expect(screen.getByRole('button', { name: 'Notes for Answer mail' })).toBeInTheDocument();
  });
});
