import { useRef, useState, type ReactNode } from 'react';
import { within } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { NixApiError } from '@nix/api-client';
import { MemoryRouter } from 'react-router';

import type { Item, View } from '@nix/web-collections/core/container-model';
import { storyContainer, storyItem } from '@nix/web-collections/core/story-container';
import { ItemSelectionContext } from '@nix/web-collections/core/item-selection-context';
import { SelectionBar } from '../core/selection-bar';
import { useItemSelection } from '@nix/web-collections/core/use-item-selection';
import { capabilitiesOf } from '@nix/web-collections/core/view-capabilities';
import type { OutlineSource } from './outline-source';
import { OutlineTree } from './outline-view';

export default { title: 'Nix/Views/Outline', parameters: { layout: 'padded' } };

const ROOT = 'story-container';

const START: readonly Item[] = [
  { ...storyItem('a', 'Trip to Lisbon', 1), hasChildren: true },
  { ...storyItem('a1', 'Book flights', 1), parentId: 'a' },
  { ...storyItem('a2', 'Find somewhere to stay', 2), parentId: 'a' },
  storyItem('b', 'Renew passport', 2),
  { ...storyItem('c', 'Archive', 3), noChildren: true },
];

const VIEW: View = {
  id: 'outline',
  name: 'Plans',
  kind: 'outline',
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
  filters: [],
};

/** One parent's children in sibling order, each saying whether it holds anything itself. */
function childrenIn(items: readonly Item[], parentId: string | null): Item[] {
  return items
    .filter((item) => item.parentId === parentId)
    .sort((left, right) => Number(left.seq) - Number(right.seq))
    .map((item) => ({
      ...item,
      hasChildren: items.some((candidate) => candidate.parentId === item.id),
    }));
}

/** An outline over an in-memory tree: moves and adds land in place, as Core would order them. */
function Example({
  empty = false,
  refuseMoves = false,
  lockedIds = [],
  selecting = false,
}: {
  readonly empty?: boolean;
  readonly refuseMoves?: boolean;
  readonly lockedIds?: readonly string[];
  readonly selecting?: boolean;
}): ReactNode {
  const [items, setItems] = useState<readonly Item[]>(empty ? [] : START);
  const selection = useItemSelection();
  const [shown, setShown] = useState<readonly string[]>([]);
  const latest = useRef(items);
  const commit = (next: readonly Item[]): void => {
    latest.current = next;
    setItems(next);
  };
  const childrenOf = (parentId: string | null): Item[] => childrenIn(latest.current, parentId);

  const source: OutlineSource = {
    list: (parentId) =>
      parentId !== null && lockedIds.includes(parentId)
        ? Promise.reject(
            new NixApiError({ kind: 'http', code: 'items.locked', status: 423, message: 'Locked' }),
          )
        : Promise.resolve(childrenOf(parentId)),
    create: (parentId, title) => {
      const item = {
        ...storyItem(`n-${String(latest.current.length)}`, title, latest.current.length + 1),
        parentId,
      };
      commit([...latest.current, item]);
      return Promise.resolve(item);
    },
    rename: (itemId, _parent, title) => {
      commit(latest.current.map((item) => (item.id === itemId ? { ...item, title } : item)));
      return Promise.resolve();
    },
    move: (itemId, _from, parentId, afterId) => {
      if (refuseMoves) {
        return Promise.reject(
          new NixApiError({
            kind: 'http',
            code: 'items.children_protected',
            status: 409,
            message: 'Refused',
            detail: 'That item does not accept new children.',
          }),
        );
      }
      const siblings = childrenOf(parentId).filter((item) => item.id !== itemId);
      const at = afterId === null ? 0 : siblings.findIndex((item) => item.id === afterId) + 1;
      const order = [...siblings.slice(0, at), { id: itemId }, ...siblings.slice(at)].map(
        (item) => item.id,
      );
      commit(
        latest.current.map((item) =>
          order.includes(item.id) ? { ...item, parentId, seq: order.indexOf(item.id) + 1 } : item,
        ),
      );
      return Promise.resolve();
    },
  };

  const tree = (
    <MemoryRouter>
      <div className="max-w-xl">
        <OutlineTree
          container={storyContainer(childrenIn(items, ROOT), [])}
          view={VIEW}
          onOpen={() => undefined}
          source={source}
        />
      </div>
    </MemoryRouter>
  );
  if (!selecting) return tree;
  return (
    <ItemSelectionContext
      value={{
        selected: selection.selected,
        toggle: selection.toggle,
        capabilities: capabilitiesOf('outline'),
        shown,
        show: setShown,
      }}
    >
      {tree}
      <SelectionBar count={selection.selected.size} onClear={selection.clear} />
    </ItemSelectionContext>
  );
}

export const Plans = { render: (): ReactNode => <Example /> };
/** Exercises the shared selection tray so axe sees outline selection controls. */
export const Selection = {
  render: (): ReactNode => <Example selecting />,
  play: async ({ canvasElement }: { readonly canvasElement: HTMLElement }): Promise<void> => {
    const canvas = within(canvasElement);
    const checkbox = canvas.getByRole('checkbox', { name: 'Select Trip to Lisbon' });
    checkbox.closest<HTMLElement>('[role="treeitem"]')?.focus();
    const wrapper = checkbox.parentElement?.parentElement;
    if (wrapper === null || wrapper === undefined || getComputedStyle(wrapper).opacity !== '1') {
      throw new Error('Selecting controls must reveal on item focus before an item is selected.');
    }
    await userEvent.click(checkbox);
    canvas.getByRole('toolbar', { name: 'Selected items' });
  },
};
export const NarrowPlans = {
  render: (): ReactNode => (
    <div className="max-w-xs">
      <Example />
    </div>
  ),
};
export const RowActions = {
  render: (): ReactNode => <Example />,
  play: async ({ canvasElement }: { readonly canvasElement: HTMLElement }): Promise<void> => {
    const canvas = within(canvasElement);
    canvas.getAllByRole('treeitem')[1]?.focus();
    await userEvent.keyboard('{Shift>}{F10}{/Shift}');
  },
};
export const Empty = { render: (): ReactNode => <Example empty /> };
/** The new-item field open below the first row, as Enter leaves it. */
export const DraftOpen = {
  render: (): ReactNode => <Example />,
  play: async ({ canvasElement }: { readonly canvasElement: HTMLElement }): Promise<void> => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Add item' }));
  },
};
/** A refused indent, said under the row it was about. */
export const RefusalNote = {
  render: (): ReactNode => <Example refuseMoves />,
  play: async ({ canvasElement }: { readonly canvasElement: HTMLElement }): Promise<void> => {
    const canvas = within(canvasElement);
    canvas.getAllByRole('treeitem')[1]?.focus();
    await userEvent.keyboard('{Tab}');
  },
};
/** A locked branch: opening it says so and marks the row locked. */
export const LockedRow = {
  render: (): ReactNode => <Example lockedIds={['a']} />,
  play: async ({ canvasElement }: { readonly canvasElement: HTMLElement }): Promise<void> => {
    const canvas = within(canvasElement);
    canvas.getAllByRole('treeitem')[0]?.focus();
    await userEvent.keyboard('{ArrowRight}');
  },
};
export const DarkPlans = { ...Plans, globals: { ground: 'dark' } };
export const DarkNarrowPlans = { ...NarrowPlans, globals: { ground: 'dark' } };
export const DarkRowActions = { ...RowActions, globals: { ground: 'dark' } };
export const DarkDraftOpen = { ...DraftOpen, globals: { ground: 'dark' } };
export const DarkRefusalNote = { ...RefusalNote, globals: { ground: 'dark' } };
export const DarkLockedRow = { ...LockedRow, globals: { ground: 'dark' } };
export const DarkEmpty = { ...Empty, globals: { ground: 'dark' } };
