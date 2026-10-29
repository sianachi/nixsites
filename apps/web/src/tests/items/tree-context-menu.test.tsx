import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import { ApiClientProvider } from '@nix/web-platform/api/api-client-provider';
import { AuthProvider } from '@nix/web-platform/auth/auth-provider';
import { useSessionStore } from '@nix/web-foundation/lib/session-store';
import { browserStorage } from '@nix/web-foundation/lib/browser-storage';
import { hiddenItemsKey, writeHiddenItems } from '@nix/web-foundation/lib/view-hidden-items';
import { itemLandmarksKey } from '@nix/web-foundation/lib/item-landmarks';
import { WorkspaceSidebar } from '../../items/workspace-sidebar';
import { MobileWorkspaceBrowser } from '../../items/mobile-workspace-browser';
import type { TreeItem, WorkspaceTree } from '../../items/use-workspace-tree';
import { WorkspaceProvider } from '@nix/web-workspaces/workspaces/workspace-context';
import { STUB_WORKSPACE } from '@nix/web-foundation/testing/api-stub';
import { memoryStorage } from '@nix/web-foundation/testing/memory-storage';
import { signedIn } from '@nix/web-foundation/testing/render-with-router';

/**
 * The sidebar row's secondary-click menu: the row's existing actions, where a desktop user looks
 * for them first, instead of the browser's Back / Reload / Inspect menu.
 */

const ROOT_A: TreeItem = {
  id: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
  title: 'First',
  type: 'note',
  parentId: null,
  hasChildren: false,
  seq: 1000,
  lifecycleState: 'active',
};

const ROOT_B: TreeItem = {
  ...ROOT_A,
  id: 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb',
  title: 'Second',
  seq: 2000,
};
const ROOT_C: TreeItem = {
  ...ROOT_A,
  id: 'cccccccc-1111-4111-8111-cccccccccccc',
  title: 'Third',
  seq: 3000,
};

function treeOf(
  move: WorkspaceTree['move'],
  items: readonly TreeItem[] = [ROOT_A, ROOT_B, ROOT_C],
  expanded: ReadonlySet<string> = new Set(),
): WorkspaceTree {
  return {
    status: 'ready',
    error: null,
    items,
    isCreating: false,
    find: (id: string) => items.find((item) => item.id === id) ?? null,
    childrenOf: (parentId: string | null) => items.filter((item) => item.parentId === parentId),
    breadcrumbs: () => [],
    isExpanded: (itemId: string) => expanded.has(itemId),
    isLoadingChildren: () => false,
    isLocked: () => false,
    toggle: () => Promise.resolve(),
    reveal: () => Promise.resolve(),
    create: () => Promise.resolve(null),
    rename: () => Promise.resolve(),
    move,
    remove: () => Promise.resolve(),
    restore: () => Promise.resolve(),
    reload: () => Promise.resolve(),
  } as unknown as WorkspaceTree;
}

interface Callbacks {
  readonly onSelect?: (id: string) => void;
  readonly onOpenPinned?: (id: string) => void;
  readonly onOpenBeside?: (id: string) => void;
  readonly onDeleteItem?: (item: TreeItem) => void;
}

function renderSidebar(
  tree: WorkspaceTree,
  selectedId: string | null = null,
  callbacks: Callbacks = {},
  view: 'desktop' | 'mobile' = 'desktop',
): void {
  render(
    <MemoryRouter initialEntries={[`/w/${STUB_WORKSPACE.id}`]}>
      <AuthProvider>
        <ApiClientProvider>
          <Routes>
            <Route
              path="/w/:workspaceId"
              element={
                <WorkspaceProvider
                  state={{
                    status: 'ready',
                    workspaces: [STUB_WORKSPACE],
                    error: null,
                    reload: () => undefined,
                    workspaceCreated: () => undefined,
                    workspaceUpdated: () => undefined,
                    workspaceRemoved: () => undefined,
                  }}
                >
                  {view === 'mobile' ? (
                    <MobileWorkspaceBrowser
                      tree={tree}
                      parentId={null}
                      onParent={vi.fn()}
                      onOpen={callbacks.onSelect ?? vi.fn()}
                      onClose={vi.fn()}
                      destinations={null}
                    />
                  ) : (
                    <WorkspaceSidebar
                      tree={tree}
                      selectedId={selectedId}
                      onSelect={callbacks.onSelect ?? vi.fn()}
                      onOpenBeside={callbacks.onOpenBeside ?? (() => undefined)}
                      onOpenPinned={callbacks.onOpenPinned ?? (() => undefined)}
                      besideRefusal={null}
                      canOpenBeside
                      onDeleteItem={callbacks.onDeleteItem ?? vi.fn()}
                      treeRegionRef={{ current: null }}
                    />
                  )}
                </WorkspaceProvider>
              }
            />
          </Routes>
        </ApiClientProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
}

const CHILD: TreeItem = {
  ...ROOT_A,
  id: 'dddddddd-1111-4111-8111-dddddddddddd',
  title: 'Nested',
  parentId: ROOT_A.id,
};

function rightClick(title: string): boolean {
  return fireEvent.contextMenu(screen.getByRole('button', { name: title }), {
    clientX: 30,
    clientY: 30,
  });
}

describe('the sidebar row context menu', () => {
  it('chooses, retains, and resets a personal icon without changing the item', async () => {
    const user = userEvent.setup();
    const move = vi.fn();
    vi.stubGlobal('localStorage', memoryStorage());
    signedIn();
    renderSidebar(treeOf(move));
    rightClick('First');
    await user.click(screen.getByRole('menuitem', { name: 'Choose icon…' }));
    await user.click(screen.getByRole('button', { name: 'Notebook' }));
    await user.click(screen.getByRole('button', { name: 'Blue' }));
    await user.click(screen.getByRole('button', { name: 'Save icon' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'First' })).toHaveFocus();
    });
    const key = itemLandmarksKey(
      useSessionStore.getState().profile?.subject ?? '',
      STUB_WORKSPACE.id,
    );
    expect(JSON.parse(browserStorage()?.getItem(key) ?? '{}')).toEqual({
      [ROOT_A.id]: { icon: 'notebook', tone: 'accent' },
    });
    rightClick('First');
    await user.click(screen.getByRole('menuitem', { name: 'Choose icon…' }));
    expect(screen.getByRole('button', { name: 'Notebook' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Blue' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByRole('button', { name: 'Reset icon' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'First' })).toHaveFocus();
    });
    expect(browserStorage()?.getItem(key)).toBeNull();
    expect(move).not.toHaveBeenCalled();
  });

  it('replaces the browser menu with the row actions', () => {
    renderSidebar(treeOf(vi.fn()));

    expect(rightClick('Second')).toBe(false);

    const menu = screen.getByRole('menu', { name: 'Second actions' });
    expect(menu).toBeInTheDocument();
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Open',
      expect.stringContaining('Select'),
      'Open in a new tab',
      expect.stringContaining('Open beside'),
      'Hide children from tree',
      'Bookmark',
      'Copy link',
      'Automate…',
      'Mute reminders',
      'Protect from deletion',
      'Stop new children',
      'Edit one at a time',
      'Delete',
    ]);
  });

  it('leaves secondary row controls out of the item context menu', () => {
    renderSidebar(treeOf(vi.fn()));
    expect(fireEvent.contextMenu(screen.getByRole('button', { name: 'Delete First' }))).toBe(true);
    expect(fireEvent.contextMenu(screen.getByRole('button', { name: 'Open First beside' }))).toBe(
      true,
    );
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('offers open and personal hide actions on the mobile browser row', async () => {
    vi.stubGlobal('localStorage', memoryStorage());
    signedIn();
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderSidebar(treeOf(vi.fn()), null, { onSelect }, 'mobile');
    rightClick('Second');
    await user.click(screen.getByRole('menuitem', { name: 'Open' }));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(ROOT_B.id);
    rightClick('Second');
    await user.click(screen.getByRole('menuitem', { name: 'Hide for me' }));
    expect(screen.queryByRole('button', { name: 'Second' })).not.toBeInTheDocument();
  });

  it('opens, opens in a tab, and deletes the row it was opened on', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onOpenPinned = vi.fn();
    const onDeleteItem = vi.fn();
    renderSidebar(treeOf(vi.fn()), null, { onSelect, onOpenPinned, onDeleteItem });

    rightClick('Second');
    await user.click(screen.getByRole('menuitem', { name: 'Open' }));
    rightClick('Second');
    await user.click(screen.getByRole('menuitem', { name: 'Open in a new tab' }));
    rightClick('Second');
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }));

    expect(onSelect).toHaveBeenCalledWith(ROOT_B.id);
    expect(onOpenPinned).toHaveBeenCalledWith(ROOT_B.id);
    expect(onDeleteItem).toHaveBeenCalledWith(ROOT_B);
  });

  it('copies a link that opens the item in its workspace', async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    renderSidebar(treeOf(vi.fn()));

    rightClick('Third');
    await user.click(screen.getByRole('menuitem', { name: 'Copy link' }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(
        `${window.location.origin}/w/${STUB_WORKSPACE.id}?item=${ROOT_C.id}`,
      );
    });
    writeText.mockRestore();
  });

  it('offers a nested row the move to the workspace root', async () => {
    const user = userEvent.setup();
    const move = vi.fn(() => Promise.resolve({ refusal: null }));
    renderSidebar(
      treeOf(move, [{ ...ROOT_A, hasChildren: true }, ROOT_B, CHILD], new Set([ROOT_A.id])),
    );
    await user.click(screen.getByRole('button', { name: 'Expand First' }));

    rightClick('Nested');
    await user.click(screen.getByRole('menuitem', { name: 'Move to workspace root' }));

    await waitFor(() => {
      expect(move).toHaveBeenCalledWith(CHILD.id, null, ROOT_B.id);
    });
  });

  it('offers Open beside, with its pointer shortcut, when another pane would fit', () => {
    renderSidebar(treeOf(vi.fn()));
    rightClick('First');
    const beside = screen.getByRole('menuitem', { name: 'Open beside' });
    expect(beside).toBeEnabled();
    expect(beside).toHaveTextContent(/Click/);
  });
  it('selects several rows with Shift+click or the row menu and offers one bar for them', async () => {
    const user = userEvent.setup();
    renderSidebar(treeOf(vi.fn()));
    const row = (title: string): HTMLElement => {
      const element = screen.getByRole('button', { name: title }).closest('[role="treeitem"]');
      if (!(element instanceof HTMLElement)) throw new Error(`no row for ${title}`);
      return element;
    };
    expect(screen.queryByRole('toolbar', { name: 'Selected items' })).not.toBeInTheDocument();

    await user.keyboard('{Shift>}');
    await user.click(screen.getByRole('button', { name: 'First' }));
    await user.click(screen.getByRole('button', { name: 'Third' }));
    await user.keyboard('{/Shift}');
    expect(screen.getByText('3 selected')).toBeVisible();
    expect(row('Second')).toHaveAttribute('aria-selected', 'true');

    fireEvent.contextMenu(within(row('Second')).getByRole('button', { name: 'Second' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Deselect' }));
    expect(screen.getByText('2 selected')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.queryByRole('toolbar', { name: 'Selected items' })).not.toBeInTheDocument();
  });

  it('toggles a row with Ctrl-click and opens beside with Alt-click', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onOpenBeside = vi.fn();
    renderSidebar(treeOf(vi.fn()), null, { onSelect, onOpenBeside });

    await user.keyboard('{Control>}');
    await user.click(screen.getByRole('button', { name: 'First' }));
    await user.keyboard('{/Control}');
    expect(screen.getByText('1 selected')).toBeVisible();
    expect(onSelect).not.toHaveBeenCalled();
    expect(onOpenBeside).not.toHaveBeenCalled();

    await user.keyboard('{Alt>}');
    await user.click(screen.getByRole('button', { name: 'Second' }));
    await user.keyboard('{/Alt}');
    expect(onOpenBeside).toHaveBeenCalledWith(ROOT_B.id);
    expect(screen.getByText('1 selected')).toBeVisible();
  });

  it('selects every shown row with Ctrl-A and clears with Escape', async () => {
    const user = userEvent.setup();
    renderSidebar(treeOf(vi.fn()));
    screen.getByRole('button', { name: 'First' }).focus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('toolbar', { name: 'Selected items' })).not.toBeInTheDocument();

    await user.keyboard('{Control>}a{/Control}');
    expect(screen.getByText('3 selected')).toBeVisible();
    // Everything shown is selected, so there is nothing left to select.
    expect(screen.queryByRole('button', { name: /^Select all/ })).not.toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('toolbar', { name: 'Selected items' })).not.toBeInTheDocument();
  });
});

it.each(['desktop', 'mobile'] as const)(
  'toggles children in the %s tree menu without hiding the parent',
  async (view) => {
    vi.stubGlobal('localStorage', memoryStorage());
    signedIn();
    writeHiddenItems(hiddenItemsKey('test-subject', STUB_WORKSPACE.id) + ':tree-children', []);
    const user = userEvent.setup();
    renderSidebar(treeOf(vi.fn(), [{ ...ROOT_A, hasChildren: true }, CHILD]), null, {}, view);
    const control = view === 'desktop' ? 'Expand First' : 'Browse children of First';
    expect(screen.getByRole('button', { name: control })).toBeVisible();
    rightClick('First');
    await user.click(screen.getByRole('menuitem', { name: 'Hide children from tree' }));
    expect(screen.getByRole('button', { name: 'First' })).toBeVisible();
    expect(screen.queryByRole('button', { name: control })).not.toBeInTheDocument();
    rightClick('First');
    await user.click(screen.getByRole('menuitem', { name: 'Show children in tree' }));
    expect(screen.getByRole('button', { name: control })).toBeVisible();
  },
);
