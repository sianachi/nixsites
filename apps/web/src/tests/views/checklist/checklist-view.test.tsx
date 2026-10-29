import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderAt } from '@nix/web-editor/testing/render-with-router';
import { aView, item, property, schemaOf } from '../../view-fixture';
import { aContainer } from '../../container-fixture';
import type { EffectiveSchema, Item, View } from '../../../views/core/container-model';
import { ChecklistView, resolveDoneProperty } from '../../../views/checklist/checklist-view';
import { ItemSelectionContext } from '../../../views/core/item-selection-context';
import { useItemSelection } from '../../../views/core/use-item-selection';
import { capabilitiesOf } from '../../../views/core/view-capabilities';

const DONE = property('done', 'Done', 'checkbox');
const WHERE = property('aisle', 'Aisle', 'text');
const COMPLETE = property('completion', 'Complete', 'completion');

const LINES = [
  item('milk', 'Milk', 1, { done: true, aisle: 'Dairy' }),
  item('bread', 'Bread', 2, { aisle: 'Bakery' }),
  item('eggs', 'Eggs', 3, { done: false }),
];

interface HarnessOptions {
  readonly view?: Partial<View>;
  readonly schema?: EffectiveSchema;
  readonly refuseWrite?: string;
  readonly refuseCreate?: string;
  readonly onCreate?: (title: string) => void;
  readonly lines?: readonly Item[];
  readonly onOpen?: (itemId: string) => void;
  readonly selecting?: boolean;
}

/** A checklist over an in-memory container whose writes land optimistically, like `useContainer`. */
function Harness(options: HarnessOptions): ReactNode {
  const [children, setChildren] = useState<readonly Item[]>(options.lines ?? LINES);
  const selection = useItemSelection();
  const [shown, setShown] = useState<readonly string[]>([]);
  const container = aContainer({
    schema: options.schema ?? schemaOf(DONE, WHERE),
    children,
    setProperties: async (itemId, properties) => {
      await Promise.resolve();
      if (options.refuseWrite !== undefined) return options.refuseWrite;
      setChildren((current) =>
        current.map((entry) =>
          entry.id === itemId
            ? { ...entry, properties: { ...entry.properties, ...properties } }
            : entry,
        ),
      );
      return null;
    },
    create: async (title) => {
      await Promise.resolve();
      options.onCreate?.(title);
      if (options.refuseCreate !== undefined) return options.refuseCreate;
      setChildren((current) => [...current, item(`new-${title}`, title, current.length + 1)]);
      return null;
    },
  });
  const checklist = (
    <ChecklistView
      container={container}
      view={aView({ kind: 'checklist', columns: ['aisle'], ...options.view })}
      onOpen={options.onOpen ?? vi.fn()}
    />
  );
  if (!options.selecting) return checklist;
  return (
    <ItemSelectionContext
      value={{
        selected: selection.selected,
        toggle: selection.toggle,
        capabilities: capabilitiesOf('checklist'),
        shown,
        show: setShown,
      }}
    >
      {checklist}
    </ItemSelectionContext>
  );
}

describe('ChecklistView', () => {
  it('ticks a line from its context menu through the same property write', async () => {
    const user = userEvent.setup();
    renderAt(<Harness />);
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Open Bread' }), {
      clientX: 10,
      clientY: 10,
    });
    await user.click(screen.getByRole('menuitem', { name: 'Mark as done' }));
    await waitFor(() => {
      expect(screen.getByRole('checkbox', { name: 'Bread' })).toBeChecked();
    });
    expect(screen.getByRole('status')).toHaveTextContent('2 of 3 done');
  });

  it('draws one line per item with a box, the title and its one secondary property', () => {
    renderAt(<Harness />);

    expect(screen.getByRole('checkbox', { name: 'Milk' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Bread' })).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Open Milk' })).toBeInTheDocument();
    expect(screen.getByText('Dairy')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('1 of 3 done');
  });

  it('ticks a line by writing the done property, and counts it', async () => {
    const user = userEvent.setup();
    renderAt(<Harness />);

    await user.click(screen.getByRole('checkbox', { name: 'Bread' }));

    await waitFor(() => {
      expect(screen.getByRole('checkbox', { name: 'Bread' })).toBeChecked();
    });
    expect(screen.getByRole('status')).toHaveTextContent('2 of 3 done');
  });

  it('says so beside the line when a tick is refused', async () => {
    const user = userEvent.setup();
    renderAt(<Harness refuseWrite="This item is read-only." />);

    await user.click(screen.getByRole('checkbox', { name: 'Bread' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('This item is read-only.');
    expect(screen.getByRole('checkbox', { name: 'Bread' })).not.toBeChecked();
  });

  it('hides done lines on request and says the toggle is pressed', async () => {
    const user = userEvent.setup();
    renderAt(<Harness />);

    const toggle = screen.getByRole('button', { name: 'Hide done' });
    await user.click(toggle);

    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('checkbox', { name: 'Milk' })).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Bread' })).toBeInTheDocument();
  });

  it('adds lines from the field at the bottom and keeps focus there for the next one', async () => {
    const user = userEvent.setup();
    const created: string[] = [];
    renderAt(<Harness onCreate={(title) => created.push(title)} />);

    const field = screen.getByRole('textbox', { name: 'Add a line' });
    await user.click(field);
    await user.type(field, 'Butter{Enter}');
    await user.type(field, 'Jam{Enter}');

    expect(created).toEqual(['Butter', 'Jam']);
    expect(field).toHaveFocus();
    expect(field).toHaveValue('');
    expect(await screen.findByRole('checkbox', { name: 'Jam' })).toBeInTheDocument();
  });

  it('puts the name back and says why when a line cannot be added', async () => {
    const user = userEvent.setup();
    renderAt(<Harness refuseCreate="This item does not accept new children." />);

    const field = screen.getByRole('textbox', { name: 'Add a line' });
    await user.type(field, 'Butter{Enter}');

    expect(await screen.findByRole('alert')).toHaveTextContent('does not accept new children');
    expect(field).toHaveValue('Butter');
  });

  it('ticks a task completion when there is no done checkbox', () => {
    expect(resolveDoneProperty([WHERE, COMPLETE], null)).toEqual({
      kind: 'ready',
      property: COMPLETE,
    });
    expect(resolveDoneProperty([DONE, COMPLETE], null)).toEqual({ kind: 'ready', property: DONE });
    expect(resolveDoneProperty([DONE, COMPLETE], 'completion')).toEqual({
      kind: 'ready',
      property: COMPLETE,
    });
    expect(resolveDoneProperty([WHERE], 'aisle').kind).toBe('wrongType');
  });

  it('explains itself instead of drawing boxes when there is nothing to tick', () => {
    renderAt(<Harness schema={schemaOf(WHERE)} />);

    expect(screen.getByText('This checklist has nothing to tick')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('keeps focus in the add field across the first line of an empty checklist', async () => {
    const user = userEvent.setup();
    renderAt(<Harness lines={[]} />);

    expect(screen.getByText(/Nothing on this checklist yet/)).toBeInTheDocument();
    const field = screen.getByRole('textbox', { name: 'Add a line' });
    await user.click(field);
    await user.type(field, 'Butter{Enter}');

    expect(await screen.findByRole('checkbox', { name: 'Butter' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Add a line' })).toHaveFocus();
  });

  it('moves focus to the next visible line when a ticked line is hidden', async () => {
    const user = userEvent.setup();
    renderAt(<Harness />);

    await user.click(screen.getByRole('button', { name: 'Hide done' }));
    await user.click(screen.getByRole('checkbox', { name: 'Bread' }));

    await waitFor(() => {
      expect(screen.queryByRole('checkbox', { name: 'Bread' })).not.toBeInTheDocument();
    });
    expect(screen.getByRole('checkbox', { name: 'Eggs' })).toHaveFocus();
  });

  it('ticks a line when its title text is clicked', async () => {
    const user = userEvent.setup();
    renderAt(<Harness />);

    await user.click(screen.getByText('Bread'));

    await waitFor(() => {
      expect(screen.getByRole('checkbox', { name: 'Bread' })).toBeChecked();
    });
    expect(screen.getByRole('status')).toHaveTextContent('2 of 3 done');
  });

  it('opens a line from its open button without ticking it', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    renderAt(<Harness onOpen={onOpen} />);

    await user.click(screen.getByRole('button', { name: 'Open Bread' }));

    expect(onOpen).toHaveBeenCalledWith('bread');
    expect(screen.getByRole('checkbox', { name: 'Bread' })).not.toBeChecked();
  });

  it('shows no selection boxes until something is selected', async () => {
    const user = userEvent.setup();
    renderAt(<Harness selecting />);

    expect(screen.queryByRole('checkbox', { name: 'Select Milk' })).not.toBeInTheDocument();
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Open Milk' }), {
      clientX: 10,
      clientY: 10,
    });
    await user.click(screen.getByRole('menuitem', { name: 'Select' }));

    expect(await screen.findByRole('checkbox', { name: 'Select Milk' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Select Bread' })).toBeInTheDocument();
  });

  it('shows the Add button only while the field has text', async () => {
    const user = userEvent.setup();
    renderAt(<Harness />);

    expect(screen.queryByRole('button', { name: 'Add' })).not.toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: 'Add a line' }), 'Jam');
    expect(screen.getByRole('button', { name: 'Add' })).toBeInTheDocument();
  });

  it('opens the menu on a long press without also ticking the line', () => {
    vi.useFakeTimers();
    try {
      renderAt(<Harness />);
      const title = screen.getByText('Bread');

      fireEvent.pointerDown(title, {
        pointerType: 'touch',
        isPrimary: true,
        button: 0,
        clientX: 10,
        clientY: 10,
      });
      act(() => {
        vi.advanceTimersByTime(600);
      });
      expect(screen.getByRole('menuitem', { name: 'Mark as done' })).toBeInTheDocument();

      fireEvent.click(title);
      expect(screen.getByRole('checkbox', { name: 'Bread' })).not.toBeChecked();
    } finally {
      vi.useRealTimers();
    }
  });
});
