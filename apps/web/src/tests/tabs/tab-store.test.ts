import { beforeEach, describe, expect, it } from 'vitest';

import { browserSessionStorage } from '@nix/web-foundation/lib/browser-storage';
import { chatTabId, useTabStore } from '@nix/web-foundation/lib/tab-store';

function tabs(pane: number): readonly { itemId: string; pinned: boolean }[] {
  return useTabStore.getState().byPane[pane] ?? [];
}

beforeEach(() => {
  useTabStore.setState({ workspaceId: null, byPane: {} });
});

describe('previewing a document', () => {
  it('opens it as an unpinned tab', () => {
    useTabStore.getState().tabPreviewed(0, 'a');

    expect(tabs(0)).toEqual([{ itemId: 'a', pinned: false }]);
  });

  it('replaces the pane’s existing preview tab in place', () => {
    useTabStore.setState({
      byPane: {
        0: [
          { itemId: 'a', pinned: true },
          { itemId: 'b', pinned: false },
        ],
      },
    });

    useTabStore.getState().tabPreviewed(0, 'c');

    expect(tabs(0)).toEqual([
      { itemId: 'a', pinned: true },
      { itemId: 'c', pinned: false },
    ]);
  });

  it('does not demote a tab that is already pinned', () => {
    useTabStore.setState({ byPane: { 0: [{ itemId: 'a', pinned: true }] } });

    useTabStore.getState().tabPreviewed(0, 'a');

    expect(tabs(0)).toEqual([{ itemId: 'a', pinned: true }]);
  });

  it('keeps each pane’s strip separate', () => {
    useTabStore.getState().tabPreviewed(0, 'a');
    useTabStore.getState().tabPreviewed(1, 'b');

    expect(tabs(0)).toEqual([{ itemId: 'a', pinned: false }]);
    expect(tabs(1)).toEqual([{ itemId: 'b', pinned: false }]);
  });
});

describe('pinning a document', () => {
  it('promotes an already-open preview tab in place', () => {
    useTabStore.setState({
      byPane: {
        0: [
          { itemId: 'a', pinned: true },
          { itemId: 'b', pinned: false },
        ],
      },
    });

    useTabStore.getState().tabPinned(0, 'b');

    expect(tabs(0)).toEqual([
      { itemId: 'a', pinned: true },
      { itemId: 'b', pinned: true },
    ]);
  });

  it('inserts a pinned tab directly when the document was not already open', () => {
    useTabStore.getState().tabPinned(0, 'a');

    expect(tabs(0)).toEqual([{ itemId: 'a', pinned: true }]);
  });
});

describe('activating a tab', () => {
  it('claims a restored tab for its addressed pane and preserves its pinned state', () => {
    useTabStore.setState({
      byPane: {
        0: [
          { itemId: 'a', pinned: true },
          { itemId: 'b', pinned: true },
        ],
        1: [],
      },
    });

    useTabStore.getState().tabActivated(1, 'b');

    expect(tabs(0)).toEqual([{ itemId: 'a', pinned: true }]);
    expect(tabs(1)).toEqual([{ itemId: 'b', pinned: true }]);
  });
});

describe('installing a planned tab transfer', () => {
  it('commits the complete working set in one store event', () => {
    const next = {
      0: [{ itemId: 'a', pinned: true }],
      1: [
        { itemId: 'b', pinned: false },
        { itemId: 'c', pinned: true },
      ],
    } as const;

    useTabStore.getState().tabsTransferred(next);

    expect(useTabStore.getState().byPane).toEqual(next);
  });
});

describe('opening as the only pane', () => {
  it('reuses pane zero preview rules and drops every unaddressed pane', () => {
    useTabStore.setState({
      byPane: {
        0: [
          { itemId: 'a', pinned: true },
          { itemId: 'b', pinned: false },
        ],
        1: [{ itemId: 'z', pinned: true }],
      },
    });

    useTabStore.getState().itemOpenedAlone('c', false);

    expect(useTabStore.getState().byPane).toEqual({
      0: [
        { itemId: 'a', pinned: true },
        { itemId: 'c', pinned: false },
      ],
    });
  });

  it('preserves a pinned tab when its former pane is no longer addressed', () => {
    useTabStore.setState({
      byPane: {
        0: [{ itemId: 'a', pinned: true }],
        1: [{ itemId: 'b', pinned: true }],
      },
    });

    useTabStore.getState().itemOpenedAlone('b', false);

    expect(useTabStore.getState().byPane).toEqual({
      0: [
        { itemId: 'a', pinned: true },
        { itemId: 'b', pinned: true },
      ],
    });
  });

  it('pins a newly opened tab when the opening gesture commits to it', () => {
    useTabStore.getState().itemOpenedAlone('a', true);

    expect(tabs(0)).toEqual([{ itemId: 'a', pinned: true }]);
  });
});

describe('closing a tab', () => {
  it('removes only that document, including a stale record under another pane', () => {
    useTabStore.setState({
      byPane: {
        0: [
          { itemId: 'a', pinned: true },
          { itemId: 'b', pinned: false },
        ],
        1: [{ itemId: 'a', pinned: true }],
      },
    });

    useTabStore.getState().tabClosed('a');

    expect(tabs(0)).toEqual([{ itemId: 'b', pinned: false }]);
    expect(tabs(1)).toEqual([]);
  });
});

describe('closing a pane', () => {
  it('drops the closed pane’s tabs and leaves an untouched pane alone', () => {
    useTabStore.setState({
      byPane: { 0: [{ itemId: 'a', pinned: true }], 1: [{ itemId: 'b', pinned: true }] },
    });

    useTabStore.getState().paneClosed(1, 2);

    expect(tabs(0)).toEqual([{ itemId: 'a', pinned: true }]);
    expect(useTabStore.getState().byPane[1]).toBeUndefined();
  });

  it('renumbers the panes after the one that closed, the same order the address shifts in', () => {
    useTabStore.setState({
      byPane: {
        0: [{ itemId: 'a', pinned: true }],
        1: [{ itemId: 'b', pinned: true }],
        2: [{ itemId: 'c', pinned: true }],
      },
    });

    useTabStore.getState().paneClosed(0, 3);

    expect(tabs(0)).toEqual([{ itemId: 'b', pinned: true }]);
    expect(tabs(1)).toEqual([{ itemId: 'c', pinned: true }]);
    expect(useTabStore.getState().byPane[2]).toBeUndefined();
  });

  it('leaves no stale entry when the shifted-down pane never had tabs recorded', () => {
    useTabStore.setState({ byPane: { 0: [{ itemId: 'a', pinned: true }] } });

    useTabStore.getState().paneClosed(0, 2);

    expect(useTabStore.getState().byPane[0]).toBeUndefined();
  });
});

describe('sessionStorage persistence', () => {
  it('restores the working set a later reload would otherwise wipe', () => {
    useTabStore.getState().workspaceChanged('workspace-a');
    useTabStore.getState().tabPinned(0, 'a');
    useTabStore.getState().tabPreviewed(1, 'b');

    // Stands in for the reload itself: a fresh mount of the store, reading whatever the previous
    // one left in storage, rather than the in-memory state carried forward within this test.
    useTabStore.setState({ workspaceId: null, byPane: {} });
    useTabStore.getState().workspaceChanged('workspace-a');

    expect(tabs(0)).toEqual([{ itemId: 'a', pinned: true }]);
    expect(tabs(1)).toEqual([{ itemId: 'b', pinned: false }]);
  });

  it('starts fresh from corrupt or older-shaped storage instead of throwing', () => {
    browserSessionStorage()?.setItem('nix.open-tabs', '{"nonsense": true}');

    expect(() => {
      useTabStore.getState().workspaceChanged('workspace-a');
    }).not.toThrow();
    expect(useTabStore.getState().byPane).toEqual({});

    browserSessionStorage()?.setItem('nix.open-tabs', 'not even json');

    expect(() => {
      useTabStore.getState().workspaceChanged('workspace-b');
    }).not.toThrow();
    expect(useTabStore.getState().byPane).toEqual({});
  });

  it('never restores another workspace’s tabs on switching workspace', () => {
    useTabStore.getState().workspaceChanged('workspace-a');
    useTabStore.getState().tabPinned(0, 'a');

    useTabStore.getState().workspaceChanged('workspace-b');

    expect(useTabStore.getState().byPane).toEqual({});

    // And switching back does not resurrect workspace-a's strip either - the persisted payload
    // now belongs to workspace-b, which recorded nothing.
    useTabStore.getState().workspaceChanged('workspace-a');

    expect(useTabStore.getState().byPane).toEqual({});
  });
});

describe('chat tabs', () => {
  const note = '00000000-0000-4000-8000-000000000001';

  it('reads a payload from before chat tabs as plain document tabs', () => {
    browserSessionStorage()?.setItem(
      'nix.open-tabs',
      JSON.stringify({ workspaceId: 'w', byPane: { 0: [{ itemId: note, pinned: true }] } }),
    );
    useTabStore.getState().workspaceChanged('w');

    expect(tabs(0)).toEqual([{ itemId: note, pinned: true }]);
  });

  it('restores a well-formed chat tab and drops a payload with a malformed one', () => {
    const store = (id: string) =>
      browserSessionStorage()?.setItem(
        'nix.open-tabs',
        JSON.stringify({ workspaceId: 'w', byPane: { 0: [{ itemId: id, pinned: true }] } }),
      );
    store(chatTabId('workspace'));
    useTabStore.getState().workspaceChanged('w');
    expect(tabs(0)).toEqual([{ itemId: 'chat:workspace', pinned: true }]);

    useTabStore.setState({ workspaceId: null, byPane: {} });
    store('chat:../../x');
    useTabStore.getState().workspaceChanged('w');
    expect(useTabStore.getState().byPane).toEqual({});
  });

  it('closing a note chat leaves the note tab with the same id open', () => {
    useTabStore.setState({
      byPane: {
        0: [
          { itemId: note, pinned: true },
          { itemId: chatTabId(note), pinned: true },
        ],
      },
    });

    useTabStore.getState().tabClosed(chatTabId(note));

    expect(tabs(0)).toEqual([{ itemId: note, pinned: true }]);
  });
});
