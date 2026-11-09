import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { UndoBar, UndoProvider } from '@nix/ui';
import { renderAt } from '@nix/web-editor/testing/render-with-router';
import { stubViewport } from '@nix/web-foundation/testing/stub-viewport';
import { item, property, schemaOf } from '@nix/web-collections/testing/view-fixture';
import { aContainer } from '@nix/web-collections/testing/container-fixture';
import { ItemSelectionContext } from '@nix/web-collections/core/item-selection-context';
import { ListView } from '../../../list/list-view';

const STATUS = { ...property('status', 'Status', 'select'), options: ['open', 'done'] };
const schema = schemaOf(STATUS, property('owner', 'Owner', 'text'));
const A = item('a', 'Alpha', 1, { status: 'open' });
const B = item('b', 'Beta', 2, { status: 'open' });
const C = item('c', 'Gamma', 3, { status: 'done' });

function listFor(
  setProperties = vi.fn(() => Promise.resolve(null)),
  setPropertiesMany = vi.fn(() => Promise.resolve({ saved: 2, refused: [] })),
): ReactNode {
  return (
    <ListView
      container={aContainer({
        schema,
        children: [A, B, C],
        setProperties,
        setPropertiesMany,
      })}
      view={null}
      onOpen={vi.fn()}
    />
  );
}

describe('the list view undo and progress', () => {
  it('says how many are done', () => {
    stubViewport(false);
    renderAt(<UndoProvider>{listFor()}</UndoProvider>);
    expect(screen.getByText('1 of 3 done')).toBeInTheDocument();
  });

  it('undoes a cell edit from the shared history', async () => {
    stubViewport(false);
    const user = userEvent.setup();
    const setProperties = vi.fn(() => Promise.resolve(null));
    renderAt(
      <UndoProvider>
        {listFor(setProperties)}
        <UndoBar />
      </UndoProvider>,
    );

    await user.click(screen.getByRole('button', { name: /Status for Alpha/ }));
    await user.selectOptions(screen.getByRole('combobox'), 'done');
    await user.click(await screen.findByRole('button', { name: 'Undo' }));

    await waitFor(() => {
      expect(setProperties).toHaveBeenLastCalledWith('a', { status: 'open' });
    });
  });

  it('sets status on every selected row at once and undoes it as one entry', async () => {
    stubViewport(false);
    const user = userEvent.setup();
    const many = vi.fn(() => Promise.resolve({ saved: 2, refused: [] }));
    const list = listFor(undefined, many);

    function Tray(): ReactNode {
      const [node, setNode] = useState<ReactNode>(null);
      return (
        <ItemSelectionContext.Provider
          value={{
            selected: new Set(['a', 'b']),
            toggle: vi.fn(),
            capabilities: { select: true, move: true, rename: true, delete: true, drag: 'parent' },
            shown: ['a', 'b', 'c'],
            show: vi.fn(),
            setTrayActions: setNode,
          }}
        >
          {list}
          {node}
        </ItemSelectionContext.Provider>
      );
    }
    renderAt(
      <UndoProvider>
        <Tray />
        <UndoBar />
      </UndoProvider>,
    );

    await user.selectOptions(
      await screen.findByRole('combobox', { name: 'Set status of the selected items' }),
      'done',
    );
    expect(many).toHaveBeenCalledTimes(1);
    expect(many).toHaveBeenLastCalledWith([
      expect.objectContaining({ itemId: 'a', properties: { status: 'done' } }),
      expect.objectContaining({ itemId: 'b', properties: { status: 'done' } }),
    ]);

    await user.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(() => {
      expect(many).toHaveBeenCalledTimes(2);
    });
    expect(many).toHaveBeenLastCalledWith([
      expect.objectContaining({ itemId: 'a', properties: { status: 'open' } }),
      expect.objectContaining({ itemId: 'b', properties: { status: 'open' } }),
    ]);
  });
});
