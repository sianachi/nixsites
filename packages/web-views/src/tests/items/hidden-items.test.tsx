import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useSessionStore } from '@nix/web-foundation/lib/session-store';
import {
  hiddenItemsKey,
  readHiddenItems,
  subscribeHiddenItems,
  writeHiddenItems,
} from '@nix/web-foundation/lib/view-hidden-items';
import {
  useHiddenItems,
  useHiddenItemPredicate,
} from '@nix/web-collections/items/use-hidden-items';
import { ViewItemVisibility } from '../../core/view-item-visibility';
import { aContainer } from '@nix/web-collections/testing/container-fixture';
import { item } from '@nix/web-foundation/testing/api-stub';
import { memoryStorage } from '@nix/web-foundation/testing/memory-storage';
import { signedIn } from '@nix/web-foundation/testing/render-with-router';

const workspace = vi.hoisted(() => ({ id: 'workspace-a' }));
vi.mock('@nix/web-workspaces/workspaces/workspace-context', () => ({
  useOptionalWorkspace: () => ({ workspaceId: workspace.id }),
}));

function Subject() {
  const visibility = useHiddenItems();
  const isHidden = useHiddenItemPredicate();
  return (
    <>
      <button
        onClick={() => {
          visibility.hide('note-a', 'Note A');
        }}
      >
        Hide A
      </button>
      <button
        onClick={() => {
          visibility.show('note-a', 'Note A');
        }}
      >
        Show A
      </button>
      <button onClick={visibility.showAll}>Show all</button>
      <span>{visibility.hiddenSet.has('note-a') ? 'A hidden' : 'A visible'}</span>
      <span>{isHidden('note-a', 'workspace-a') ? 'Search hides A' : 'Search shows A'}</span>
    </>
  );
}

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  window.dispatchEvent(new StorageEvent('storage', { key: null }));
  workspace.id = 'workspace-a';
  signedIn();
});

describe('personal hidden items', () => {
  it('hides only for the current person and workspace, with an accessible recovery path', async () => {
    const user = userEvent.setup();
    const view = render(<Subject />);
    await user.click(screen.getByRole('button', { name: 'Hide A' }));
    expect(screen.getByText('A hidden')).toBeVisible();
    expect(screen.getByText('Search hides A')).toBeVisible();

    workspace.id = 'workspace-b';
    view.rerender(<Subject />);
    expect(screen.getByText('A visible')).toBeVisible();
    expect(screen.getByText('Search hides A')).toBeVisible();

    act(() => {
      useSessionStore
        .getState()
        .signInSucceeded({ subject: 'someone-else', name: 'Else', email: null });
    });
    expect(screen.getByText('A visible')).toBeVisible();
    expect(screen.getByText('Search shows A')).toBeVisible();

    workspace.id = 'workspace-a';
    act(() => {
      signedIn();
    });
    view.rerender(<Subject />);
    expect(screen.getByText('A hidden')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Show A' }));
    expect(screen.getByText('A visible')).toBeVisible();
  });

  it('retains choices on remount and shares changes across panes and tabs', () => {
    const key = hiddenItemsKey('test-subject', 'workspace-a');
    writeHiddenItems(key, ['note-a']);
    const view = render(<Subject />);
    expect(screen.getByText('A hidden')).toBeVisible();
    view.unmount();
    render(<Subject />);
    expect(screen.getByText('A hidden')).toBeVisible();
    act(() => {
      localStorage.removeItem(key);
      window.dispatchEvent(new StorageEvent('storage', { key }));
    });
    expect(screen.getByText('A visible')).toBeVisible();
  });

  it('ignores malformed storage and never exposes titles from saved preferences', () => {
    const key = hiddenItemsKey('person', 'workspace');
    localStorage.setItem(key, '{bad json');
    expect(readHiddenItems(key)).toEqual([]);
    writeHiddenItems(key, ['note-a', 'note-a']);
    expect(JSON.parse(localStorage.getItem(key) ?? 'null')).toEqual(['note-a']);
  });

  it('deduplicates IDs before applying the storage ceiling', () => {
    const key = hiddenItemsKey('bounded-person', 'workspace');
    const ids = Array.from({ length: 4000 }, (_, index) => `item-${String(index)}`);
    expect(writeHiddenItems(key, [...ids, 'item-0'])).toBe(true);
    expect(readHiddenItems(key)).toHaveLength(4000);
  });

  it('keeps choices for the open page when browser storage refuses writes', () => {
    const key = hiddenItemsKey('person', 'workspace');
    const listener = vi.fn();
    const unsubscribe = subscribeHiddenItems(listener);
    const write = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    try {
      expect(writeHiddenItems(key, ['note-a'])).toBe(false);
      expect(readHiddenItems(key)).toEqual(['note-a']);
      expect(listener).toHaveBeenCalledOnce();
    } finally {
      write.mockRestore();
      unsubscribe();
    }
  });
});

it('keeps children visible in views and search when their parent hides children in the tree', () => {
  writeHiddenItems(hiddenItemsKey('test-subject', 'workspace-a') + ':tree-children', ['note-a']);
  const container = aContainer({
    itemId: 'note-a',
    children: [item({ id: 'child', title: 'Child note', parentId: 'note-a' })],
  });
  render(
    <>
      <Subject />
      <ViewItemVisibility container={container} view={null}>
        {(visible) => (
          <ul aria-label="View children">
            {visible.children.map((child) => (
              <li key={child.id}>{child.title}</li>
            ))}
          </ul>
        )}
      </ViewItemVisibility>
    </>,
  );
  expect(screen.getByRole('list', { name: 'View children' })).toHaveTextContent('Child note');
  expect(screen.getByText('A visible')).toBeVisible();
  expect(screen.getByText('Search shows A')).toBeVisible();
});
