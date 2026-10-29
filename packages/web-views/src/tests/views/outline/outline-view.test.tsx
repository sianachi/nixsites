import { NixApiError } from '@nix/api-client';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderAt } from '@nix/web-editor/testing/render-with-router';
import { aView } from '@nix/web-collections/testing/view-fixture';
import { aContainer } from '@nix/web-collections/testing/container-fixture';
import type { Item } from '@nix/web-collections/core/container-model';
import { OutlineTree } from '../../../outline/outline-view';
import type { OutlineSource } from '../../../outline/outline-source';
import { ItemSelectionContext } from '@nix/web-collections/core/item-selection-context';
import { SelectionBar } from '../../../core/selection-bar';
import { useItemSelection } from '@nix/web-collections/core/use-item-selection';
import { capabilitiesOf } from '@nix/web-collections/core/view-capabilities';

/**
 * The outline, driven from the keyboard over an in-memory tree. The fake source keeps every item's
 * parent and sibling order the way Core does, so a move the outline asks for is visible in the
 * next read exactly as it would be against the server.
 */

const ROOT = 'root';

interface Node {
  id: string;
  title: string;
  parentId: string;
  seq: number;
  noChildren?: boolean;
}

function toItem(node: Node, all: readonly Node[]): Item {
  return {
    id: node.id,
    workspaceId: 'workspace-1',
    parentId: node.parentId,
    type: 'note',
    title: node.title,
    hasChildren: all.some((candidate) => candidate.parentId === node.id),
    seq: node.seq,
    lifecycleState: 'active',
    properties: {},
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    noChildren: node.noChildren ?? false,
  };
}

function initialTree(): Node[] {
  return [
    { id: 'a', title: 'Alpha', parentId: ROOT, seq: 1 },
    { id: 'b', title: 'Bravo', parentId: ROOT, seq: 2 },
    { id: 'b1', title: 'Bravo one', parentId: 'b', seq: 1 },
    { id: 'c', title: 'Charlie', parentId: ROOT, seq: 3, noChildren: true },
    { id: 'd', title: 'Delta', parentId: ROOT, seq: 4 },
  ];
}

interface HarnessOptions {
  readonly refuseMove?: Error;
  readonly lockedIds?: readonly string[];
  readonly onOpen?: (itemId: string) => void;
  readonly truncated?: boolean;
  readonly selecting?: boolean;
  readonly onMove?: (itemId: string, parentId: string | null, afterId: string | null) => void;
}

function Harness(options: HarnessOptions): ReactNode {
  const [nodes, setNodes] = useState<Node[]>(initialTree);
  const selection = useItemSelection();
  const [shown, setShown] = useState<readonly string[]>([]);
  // The source reads the latest tree between renders, as Core would, so it is held in a ref.
  const latest = useRef(nodes);

  const childrenOf = (parentId: string | null, all: readonly Node[]): Item[] =>
    all
      .filter((node) => node.parentId === parentId)
      .sort((left, right) => left.seq - right.seq)
      .map((node) => toItem(node, all));

  const commit = (next: Node[]): void => {
    latest.current = next;
    setNodes(next);
  };

  const source: OutlineSource = {
    list: (parentId) => {
      if (parentId !== null && (options.lockedIds ?? []).includes(parentId)) {
        return Promise.reject(
          new NixApiError({ kind: 'http', code: 'items.locked', status: 423, message: 'Locked' }),
        );
      }
      return Promise.resolve(childrenOf(parentId, latest.current));
    },
    create: (parentId, title) => {
      const siblings = latest.current.filter((node) => node.parentId === parentId);
      const node: Node = {
        id: `new-${title}`,
        title,
        parentId: parentId ?? ROOT,
        seq: Math.max(0, ...siblings.map((entry) => entry.seq)) + 1,
      };
      commit([...latest.current, node]);
      return Promise.resolve(toItem(node, latest.current));
    },
    rename: (itemId, _parent, title) => {
      commit(latest.current.map((node) => (node.id === itemId ? { ...node, title } : node)));
      return Promise.resolve();
    },
    move: (itemId, _from, parentId, afterId) => {
      options.onMove?.(itemId, parentId, afterId);
      if (options.refuseMove !== undefined) return Promise.reject(options.refuseMove);
      const siblings = latest.current
        .filter((node) => node.parentId === parentId && node.id !== itemId)
        .sort((left, right) => left.seq - right.seq);
      const at = afterId === null ? 0 : siblings.findIndex((node) => node.id === afterId) + 1;
      const order = [
        ...siblings.slice(0, at).map((node) => node.id),
        itemId,
        ...siblings.slice(at).map((node) => node.id),
      ];
      commit(
        latest.current.map((node) => {
          const index = order.indexOf(node.id);
          return index === -1 ? node : { ...node, parentId: parentId ?? ROOT, seq: index + 1 };
        }),
      );
      return Promise.resolve();
    },
  };

  const container = aContainer({
    itemId: ROOT,
    children: childrenOf(ROOT, nodes),
    truncated: options.truncated ?? false,
    reload: () => Promise.resolve(),
  });

  const tree = (
    <OutlineTree
      container={container}
      view={aView({ kind: 'outline', name: 'Plan' })}
      onOpen={options.onOpen ?? vi.fn()}
      source={source}
    />
  );
  if (!options.selecting) return tree;
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

/** Each row's title: its first text, before any note or lock the row also carries. */
function treeTitles(): string[] {
  return (
    screen
      .getAllByRole('treeitem')
      .map((row) => row.querySelector('span.flex-1')?.textContent ?? '')
      // The new-item row is a tree item too, and has no title yet.
      .filter((title) => title.length > 0)
  );
}

/**
 * A row by its title. A row's name also carries a note or ", locked" after the title, so the name
 * is matched from the start up to whatever follows a title rather than as the whole.
 */
function row(title: string): HTMLElement {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return screen.getByRole('treeitem', { name: new RegExp(`^${escaped}(?:$|,| [A-Z"])`, 'u') });
}

describe('OutlineTree', () => {
  it('selects a tree row from its checkbox and shows the shared tray', async () => {
    const user = userEvent.setup();
    renderAt(<Harness selecting />);

    await user.click(screen.getByRole('checkbox', { name: 'Select Alpha' }));
    expect(screen.getByRole('toolbar', { name: 'Selected items' })).toHaveTextContent('1 selected');
    await user.keyboard(' ');
    expect(screen.getByRole('checkbox', { name: 'Select Alpha' })).not.toBeChecked();
  });

  it('opens and moves the row whose context menu was requested', async () => {
    const onOpen = vi.fn();
    const onMove = vi.fn();
    const user = userEvent.setup();
    renderAt(<Harness onOpen={onOpen} onMove={onMove} />);

    row('Alpha').focus();
    fireEvent.contextMenu(row('Bravo'), { clientX: 10, clientY: 10 });
    await user.click(screen.getByRole('menuitem', { name: 'Open' }));
    expect(onOpen).toHaveBeenCalledWith('b');

    fireEvent.contextMenu(row('Bravo'), { clientX: 10, clientY: 10 });
    await user.click(screen.getByRole('menuitem', { name: 'Move up' }));
    await waitFor(() => {
      expect(onMove).toHaveBeenCalledWith('b', ROOT, null);
    });
    expect(treeTitles()).toEqual(['Bravo', 'Alpha', 'Charlie', 'Delta']);
  });

  it('adds a sibling from the keyboard context menu', async () => {
    const user = userEvent.setup();
    renderAt(<Harness />);
    row('Bravo').focus();
    fireEvent.keyDown(row('Bravo'), { key: 'F10', shiftKey: true });

    await user.click(screen.getByRole('menuitem', { name: 'Add item below' }));
    await user.type(screen.getByRole('textbox', { name: 'New item' }), 'New sibling{Enter}');
    await waitFor(() => {
      expect(treeTitles()).toEqual(['Alpha', 'Bravo', 'New sibling', 'Charlie', 'Delta']);
    });
  });

  it('renames a row in place with F2 and from the toolbar, and Escape drops the edit', async () => {
    const user = userEvent.setup();
    renderAt(<Harness />);

    row('Alpha').focus();
    await user.keyboard('{F2}');
    await user.keyboard('{Control>}a{/Control}Apex{Enter}');
    await waitFor(() => {
      expect(treeTitles()).toEqual(['Apex', 'Bravo', 'Charlie', 'Delta']);
    });

    await user.click(row('Charlie'));
    await user.click(screen.getByRole('button', { name: 'Rename "Charlie"' }));
    await user.keyboard('Nope{Escape}');
    expect(treeTitles()).toEqual(['Apex', 'Bravo', 'Charlie', 'Delta']);
    expect(row('Charlie')).toHaveFocus();
  });

  it('draws the top level as a tree with one tab stop', () => {
    renderAt(<Harness />);

    const tree = screen.getByRole('tree', { name: 'Plan' });
    expect(within(tree).getAllByRole('treeitem')).toHaveLength(4);
    expect(row('Alpha')).toHaveAttribute('tabindex', '0');
    expect(row('Bravo')).toHaveAttribute('tabindex', '-1');
    expect(row('Bravo')).toHaveAttribute('aria-expanded', 'false');
    expect(row('Bravo')).toHaveAttribute('aria-level', '1');
  });

  it('moves focus with Up and Down and opens a row lazily with Right', async () => {
    const user = userEvent.setup();
    renderAt(<Harness />);

    row('Alpha').focus();
    await user.keyboard('{ArrowDown}');
    expect(row('Bravo')).toHaveFocus();

    await user.keyboard('{ArrowRight}');
    expect(await screen.findByRole('treeitem', { name: /^Bravo one/u })).toHaveAttribute(
      'aria-level',
      '2',
    );
    expect(row('Bravo')).toHaveAttribute('aria-expanded', 'true');

    await user.keyboard('{ArrowLeft}');
    expect(screen.queryByRole('treeitem', { name: /^Bravo one/u })).not.toBeInTheDocument();
  });

  it('indents with Tab under the row above, after its last child', async () => {
    const user = userEvent.setup();
    const onMove = vi.fn();
    renderAt(<Harness onMove={onMove} />);

    row('Charlie').focus();
    await user.keyboard('{ArrowDown}');
    // Delta is below Charlie, which accepts no children: refused before any request.
    await user.keyboard('{Tab}');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      '"Charlie" does not accept new children.',
    );
    expect(onMove).not.toHaveBeenCalled();

    row('Charlie').focus();
    await user.keyboard('{Tab}');
    await waitFor(() => {
      expect(onMove).toHaveBeenCalledWith('c', 'b', 'b1');
    });
    expect(await screen.findByRole('treeitem', { name: /^Charlie/u })).toHaveAttribute(
      'aria-level',
      '2',
    );
  });

  it('outdents with Shift+Tab to after its parent', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const user = userEvent.setup();
    const onMove = vi.fn();
    renderAt(<Harness onMove={onMove} />);

    row('Bravo').focus();
    await user.keyboard('{ArrowRight}');
    const child = await screen.findByRole('treeitem', { name: /^Bravo one/u });
    child.focus();
    await user.keyboard('{Shift>}{Tab}{/Shift}');

    await waitFor(() => {
      expect(onMove).toHaveBeenCalledWith('b1', ROOT, 'b');
    });
    await waitFor(() => {
      expect(treeTitles()).toEqual(['Alpha', 'Bravo', 'Bravo one', 'Charlie', 'Delta']);
    });
    expect(row('Bravo one')).toHaveAttribute('aria-level', '1');
    expect(
      errors.mock.calls.map(([message]: readonly unknown[]) =>
        typeof message === 'string' ? message : '',
      ),
    ).not.toContain(expect.stringContaining('same key'));
  });

  it('reorders with Ctrl+Up and Ctrl+Down', async () => {
    const user = userEvent.setup();
    const onMove = vi.fn();
    renderAt(<Harness onMove={onMove} />);

    row('Delta').focus();
    await user.keyboard('{Control>}{ArrowUp}{/Control}');
    await waitFor(() => {
      expect(treeTitles()).toEqual(['Alpha', 'Bravo', 'Delta', 'Charlie']);
    });
    expect(onMove).toHaveBeenLastCalledWith('d', ROOT, 'b');

    row('Alpha').focus();
    await user.keyboard('{Control>}{ArrowDown}{/Control}');
    await waitFor(() => {
      expect(treeTitles()).toEqual(['Bravo', 'Alpha', 'Delta', 'Charlie']);
    });
  });

  it('adds a sibling with Enter and keeps the field open for the next one', async () => {
    const user = userEvent.setup();
    renderAt(<Harness />);

    row('Alpha').focus();
    await user.keyboard('{Enter}');
    const field = screen.getByRole('textbox', { name: 'New item' });
    expect(field).toHaveFocus();
    await user.type(field, 'Alpha two{Enter}');

    await waitFor(() => {
      expect(treeTitles()).toEqual(['Alpha', 'Alpha two', 'Bravo', 'Charlie', 'Delta']);
    });
    expect(screen.getByRole('textbox', { name: 'New item' })).toHaveFocus();
  });

  it('says why under the row when a move is refused, and moves nothing', async () => {
    const user = userEvent.setup();
    renderAt(
      <Harness
        refuseMove={
          new NixApiError({ kind: 'http', code: 'items.locked', status: 423, message: 'Locked' })
        }
      />,
    );

    row('Bravo').focus();
    await user.keyboard('{Tab}');

    expect(await screen.findByRole('alert')).toHaveTextContent('Unlock the locked item first.');
    expect(treeTitles()).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta']);
  });

  it('says a locked branch is locked instead of opening it empty', async () => {
    const user = userEvent.setup();
    renderAt(<Harness lockedIds={['b']} />);

    row('Bravo').focus();
    await act(async () => {
      await user.keyboard('{ArrowRight}');
    });

    expect(await screen.findByRole('alert')).toHaveTextContent('This is locked.');
    expect(row('Bravo')).toHaveAttribute('aria-expanded', 'false');
  });

  it('lets Tab leave the tree after Escape', async () => {
    const user = userEvent.setup();
    const onMove = vi.fn();
    renderAt(<Harness onMove={onMove} />);

    row('Bravo').focus();
    await user.keyboard('{Escape}{Tab}');

    expect(onMove).not.toHaveBeenCalled();
    expect(row('Bravo')).not.toHaveFocus();
  });

  it('opens the chosen row from the toolbar, for a pointer or a phone', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    renderAt(<Harness onOpen={onOpen} />);

    await user.click(row('Charlie'));
    expect(onOpen).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Open' }));

    expect(onOpen).toHaveBeenCalledWith('c');
  });

  it('accepts the sidebar tree bindings: Alt+Right indents and Alt+Enter opens', async () => {
    const user = userEvent.setup();
    const onMove = vi.fn();
    const onOpen = vi.fn();
    renderAt(<Harness onMove={onMove} onOpen={onOpen} />);

    row('Bravo').focus();
    await user.keyboard('{Alt>}{ArrowRight}{/Alt}');
    await waitFor(() => {
      expect(onMove).toHaveBeenCalledWith('b', 'a', null);
    });

    row('Alpha').focus();
    await user.keyboard('{Alt>}{Enter}{/Alt}');
    expect(onOpen).toHaveBeenCalledWith('a');
  });

  it('keeps a made item made when placing it is refused, without offering its name again', async () => {
    const user = userEvent.setup();
    renderAt(
      <Harness
        refuseMove={
          new NixApiError({ kind: 'http', code: 'items.locked', status: 423, message: 'Locked' })
        }
      />,
    );

    row('Alpha').focus();
    await user.keyboard('{Enter}');
    const field = screen.getByRole('textbox', { name: 'New item' });
    await user.type(field, 'Alpha two{Enter}');

    expect(await screen.findByRole('alert')).toHaveTextContent('Added at the end instead');
    expect(screen.getByRole('textbox', { name: 'New item' })).toHaveValue('');
    expect(treeTitles()).toContain('Alpha two');
  });

  it('does not open the row above when an indent is refused', async () => {
    const user = userEvent.setup();
    renderAt(
      <Harness
        refuseMove={
          new NixApiError({ kind: 'http', code: 'items.locked', status: 423, message: 'Locked' })
        }
      />,
    );

    row('Charlie').focus();
    await user.keyboard('{Tab}');

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(row('Bravo')).toHaveAttribute('aria-expanded', 'false');
  });

  it('says when only the first items are loaded and does not claim the top-level size', () => {
    renderAt(<Harness truncated />);

    expect(screen.getByText(/Only the first 4 items/u)).toBeInTheDocument();
    expect(row('Alpha')).toHaveAttribute('aria-setsize', '-1');
  });
});
