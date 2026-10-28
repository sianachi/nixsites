import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { useNavigate } from 'react-router';

import { App } from '../../app';
import { item, STUB_WORKSPACE, stubCoreApi } from '../api-stub';
import { renderAt, signedIn } from '../render-with-router';
import { useTabOrientationStore } from '../../tabs/tab-orientation-store';
import { useTabStore } from '../../lib/tab-store';
import { useOpenItem } from '../../tabs/use-open-item';
import { stubViewport } from '../stub-viewport';

/**
 * Documents opened as tabs within a pane - previewed, pinned, closed, and kept straight across
 * more than one pane. `document-tab-strip.tsx` explains what this is not: not the top-level tab
 * strip `app-shell.tsx` and `view-switcher.tsx` describe rejecting. These tests hold the behaviour
 * that distinction was drawn to protect.
 */

const ALPHA = item({ id: '0a0a0a0a-0000-4000-8000-00000000000a', title: 'Alpha' });
const BRAVO = item({ id: '0b0b0b0b-0000-4000-8000-00000000000b', title: 'Bravo' });
const CHARLIE = item({ id: '0c0c0c0c-0000-4000-8000-00000000000c', title: 'Charlie' });

function tabDataTransfer(): DataTransfer {
  const values = new Map<string, string>();
  return {
    effectAllowed: 'all',
    dropEffect: 'none',
    get types() {
      return [...values.keys()];
    },
    setData(type: string, value: string) {
      values.set(type, value);
    },
    getData(type: string) {
      return values.get(type) ?? '';
    },
  } as unknown as DataTransfer;
}

function HistoryControls() {
  const navigate = useNavigate();
  const { openPreview } = useOpenItem();
  return (
    <>
      <button
        type="button"
        onClick={() => {
          openPreview(BRAVO.id);
        }}
      >
        Open Bravo
      </button>
      <button type="button" onClick={() => void navigate(-1)}>
        Browser back
      </button>
    </>
  );
}

beforeEach(() => {
  signedIn();
  stubViewport(true);
  useTabStore.setState({ workspaceId: STUB_WORKSPACE.id, byPane: {} });
  useTabOrientationStore.setState({ orientation: 'horizontal' });
});

describe('previewing a document', () => {
  it('a single click opens a preview tab that the next single click replaces', async () => {
    stubCoreApi({ items: [ALPHA, BRAVO, CHARLIE] });
    const user = userEvent.setup();
    renderAt(<App />, `/?item=${ALPHA.id}`);

    await user.click(await screen.findByRole('button', { name: 'Bravo' }));
    expect(await screen.findByRole('tab', { name: 'Bravo' })).toHaveAttribute(
      'aria-selected',
      'true',
    );

    await user.click(screen.getByRole('button', { name: 'Charlie' }));
    expect(await screen.findByRole('tab', { name: 'Charlie' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.queryByRole('tab', { name: 'Bravo' })).not.toBeInTheDocument();
  });
});

describe('pinning a document', () => {
  it('double-clicking a sidebar row pins it as a tab that survives the next preview', async () => {
    stubCoreApi({ items: [ALPHA, BRAVO, CHARLIE] });
    const user = userEvent.setup();
    renderAt(<App />, `/?item=${ALPHA.id}`);

    await user.dblClick(await screen.findByRole('button', { name: 'Bravo' }));
    expect(await screen.findByRole('tab', { name: 'Bravo' })).toHaveAttribute(
      'aria-selected',
      'true',
    );

    await user.click(screen.getByRole('button', { name: 'Charlie' }));
    expect(await screen.findByRole('tab', { name: 'Charlie' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    // Bravo was pinned by the double-click, so it survives being replaced as the preview.
    expect(screen.getByRole('tab', { name: 'Bravo' })).toBeInTheDocument();
  });

  it('editing the title pins the active tab', async () => {
    stubCoreApi({ items: [ALPHA, BRAVO] });
    const user = userEvent.setup();
    renderAt(<App />, `/?item=${ALPHA.id}`);

    await user.click(await screen.findByRole('button', { name: 'Bravo' }));
    await screen.findByRole('tab', { name: 'Bravo' });

    await user.type(screen.getByRole('textbox', { name: /note title/i }), '!');

    await user.click(screen.getByRole('button', { name: 'Alpha' }));
    await screen.findByRole('tab', { name: 'Alpha' });

    // Bravo was pinned by the edit, so it survives being replaced as the preview.
    expect(screen.getByRole('tab', { name: /^Bravo/ })).toBeInTheDocument();
  });

  it('opening an item beside pins it immediately', async () => {
    stubCoreApi({ items: [ALPHA, BRAVO] });
    const user = userEvent.setup();
    renderAt(<App />, `/?item=${ALPHA.id}`);

    await user.click(await screen.findByRole('button', { name: 'Open Bravo beside' }));

    expect(await screen.findByRole('tab', { name: 'Bravo' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(useTabStore.getState().byPane[1]).toEqual([{ itemId: BRAVO.id, pinned: true }]);
  });
});

describe('closing tabs and panes', () => {
  it('closing the last tab in a pane closes the pane', async () => {
    stubCoreApi({ items: [ALPHA, BRAVO] });
    const user = userEvent.setup();
    renderAt(<App />, `/?item=${ALPHA.id}`);

    await user.click(await screen.findByRole('button', { name: 'Open Bravo beside' }));
    await screen.findByRole('tab', { name: 'Bravo' });
    expect(screen.getAllByRole('article')).toHaveLength(2);

    // The close affordance is deliberately not an interactive role of its own (a focusable
    // control inside a role=tab is the nested-interactive axe violation); the pointer path is
    // the titled span, the keyboard path is Delete on the tab itself.
    await user.click(screen.getByTitle('Close Bravo (Delete)'));

    await waitFor(() => {
      expect(screen.getAllByRole('article')).toHaveLength(1);
    });
  });

  it('closing the middle pane of three renumbers the remaining panes’ tabs', async () => {
    stubCoreApi({ items: [ALPHA, BRAVO, CHARLIE] });
    useTabStore.setState({
      workspaceId: STUB_WORKSPACE.id,
      byPane: {
        0: [{ itemId: ALPHA.id, pinned: true }],
        1: [{ itemId: BRAVO.id, pinned: true }],
        2: [{ itemId: CHARLIE.id, pinned: true }],
      },
    });
    const user = userEvent.setup();
    renderAt(<App />, `/?item=${ALPHA.id}&item2=${BRAVO.id}&item3=${CHARLIE.id}`);

    await screen.findByRole('tab', { name: 'Bravo' });
    const middlePane = screen.getByRole('article', { name: /Pane 2 of 3/ });

    await user.click(within(middlePane).getByRole('button', { name: 'Item actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Close pane' }));

    await waitFor(() => {
      expect(screen.getAllByRole('article')).toHaveLength(2);
    });

    expect(useTabStore.getState().byPane[0]).toEqual([{ itemId: ALPHA.id, pinned: true }]);
    expect(useTabStore.getState().byPane[1]).toEqual([{ itemId: CHARLIE.id, pinned: true }]);
    expect(useTabStore.getState().byPane[2]).toBeUndefined();
  });
});

describe('the tab context menu', () => {
  async function openThreePinned(user: ReturnType<typeof userEvent.setup>): Promise<void> {
    renderAt(<App />, `/?item=${ALPHA.id}`);
    await user.dblClick(await screen.findByRole('button', { name: 'Alpha' }));
    await user.dblClick(screen.getByRole('button', { name: 'Bravo' }));
    await user.dblClick(screen.getByRole('button', { name: 'Charlie' }));
    await screen.findByRole('tab', { name: 'Charlie' });
  }

  it('closes every other tab and shows the one it was opened on', async () => {
    stubCoreApi({ items: [ALPHA, BRAVO, CHARLIE] });
    const user = userEvent.setup();
    await openThreePinned(user);

    fireEvent.contextMenu(screen.getByRole('tab', { name: 'Alpha' }));
    await user.click(screen.getByRole('menuitem', { name: 'Close other tabs' }));

    await waitFor(() => {
      expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Alpha']);
    });
    expect(screen.getByRole('tab', { name: 'Alpha' })).toHaveAttribute('aria-selected', 'true');
  });

  it('closes the tabs to the right, leaving those before it', async () => {
    stubCoreApi({ items: [ALPHA, BRAVO, CHARLIE] });
    const user = userEvent.setup();
    await openThreePinned(user);

    fireEvent.contextMenu(screen.getByRole('tab', { name: 'Bravo' }));
    await user.click(screen.getByRole('menuitem', { name: 'Close tabs to the right' }));

    await waitFor(() => {
      expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Alpha', 'Bravo']);
    });
  });

  it('keeps a preview tab open', async () => {
    stubCoreApi({ items: [ALPHA, BRAVO, CHARLIE] });
    const user = userEvent.setup();
    renderAt(<App />, `/?item=${ALPHA.id}`);
    await user.click(await screen.findByRole('button', { name: 'Bravo' }));
    await screen.findByRole('tab', { name: 'Bravo' });

    fireEvent.contextMenu(screen.getByRole('tab', { name: 'Bravo' }));
    await user.click(screen.getByRole('menuitem', { name: 'Keep open' }));
    await user.click(screen.getByRole('button', { name: 'Charlie' }));

    await screen.findByRole('tab', { name: 'Charlie' });
    expect(screen.getByRole('tab', { name: 'Bravo' })).toBeInTheDocument();
  });
});

describe('a document already open elsewhere', () => {
  it('is focused in its own pane rather than duplicated, even when only backgrounded there', async () => {
    stubCoreApi({ items: [ALPHA, BRAVO, CHARLIE] });
    useTabStore.setState({
      workspaceId: STUB_WORKSPACE.id,
      byPane: {
        1: [
          { itemId: BRAVO.id, pinned: true },
          { itemId: CHARLIE.id, pinned: false },
        ],
      },
    });
    const user = userEvent.setup();
    renderAt(<App />, `/?item=${ALPHA.id}&item2=${BRAVO.id}`);

    await screen.findByRole('article', { name: /Pane 1 of 2/ });

    await user.click(await screen.findByRole('button', { name: 'Charlie' }));

    // Still exactly two panes - a click on an already-open, backgrounded document must not open
    // a third copy of it.
    await waitFor(() => {
      expect(screen.getAllByRole('article')).toHaveLength(2);
    });

    const firstPane = screen.getByRole('article', { name: /Pane 1 of 2/ });
    const secondPane = await screen.findByRole('article', { name: /Pane 2 of 2: Charlie/ });

    // The first pane is untouched.
    expect(within(firstPane).getByRole('tab', { name: 'Alpha' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    // The second pane switched from Bravo to the backgrounded Charlie tab that was already there.
    expect(within(secondPane).getByRole('tab', { name: 'Charlie' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(within(secondPane).getByRole('tab', { name: 'Bravo' })).toBeInTheDocument();
  });

  it('does not expose the same document in two tab strips when Back restores a split', async () => {
    stubViewport(false);
    stubCoreApi({ items: [ALPHA, BRAVO] });
    useTabStore.setState({
      workspaceId: STUB_WORKSPACE.id,
      byPane: {
        0: [{ itemId: ALPHA.id, pinned: true }],
        1: [{ itemId: BRAVO.id, pinned: true }],
      },
    });
    const user = userEvent.setup();
    renderAt(
      <>
        <App />
        <HistoryControls />
      </>,
      `/?item=${ALPHA.id}&item2=${BRAVO.id}`,
    );

    await user.click(await screen.findByRole('button', { name: 'Open Bravo' }));
    expect(await screen.findByRole('textbox', { name: /note title/i })).toHaveValue('Bravo');

    await user.click(screen.getByRole('button', { name: 'Browser back' }));

    expect(await screen.findByRole('textbox', { name: /note title/i })).toHaveValue('Alpha');
    expect(screen.queryByRole('tab', { name: 'Bravo' })).not.toBeInTheDocument();
  });

  it('closes a Back-restored tab from both its visible and stale working sets', async () => {
    stubCoreApi({ items: [ALPHA, BRAVO] });
    useTabStore.setState({
      workspaceId: STUB_WORKSPACE.id,
      byPane: {
        0: [
          { itemId: ALPHA.id, pinned: true },
          { itemId: BRAVO.id, pinned: true },
        ],
      },
    });
    const user = userEvent.setup();
    renderAt(<App />, `/?item=${ALPHA.id}&item2=${BRAVO.id}`);

    const secondPane = await screen.findByRole('article', { name: /Pane 2 of 2: Bravo/ });
    await user.click(within(secondPane).getByTitle('Close Bravo (Delete)'));

    await waitFor(() => {
      expect(screen.getAllByRole('article')).toHaveLength(1);
    });
    expect(screen.queryByRole('tab', { name: 'Bravo' })).not.toBeInTheDocument();
    expect(
      Object.values(useTabStore.getState().byPane).some((tabs) =>
        tabs.some((tab) => tab.itemId === BRAVO.id),
      ),
    ).toBe(false);
  });
});

describe('activating a tab', () => {
  it('keeps keyboard focus in the tablist and does not announce an already-open detour', async () => {
    stubCoreApi({ items: [ALPHA, BRAVO] });
    useTabStore.setState({
      workspaceId: STUB_WORKSPACE.id,
      byPane: {
        0: [
          { itemId: ALPHA.id, pinned: true },
          { itemId: BRAVO.id, pinned: true },
        ],
      },
    });
    const user = userEvent.setup();
    renderAt(<App />, `/?item=${ALPHA.id}`);

    const bravo = await screen.findByRole('tab', { name: 'Bravo' });
    bravo.focus();
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(bravo).toHaveAttribute('aria-selected', 'true');
    });
    expect(bravo).toHaveFocus();
    expect(screen.queryByText(/Already open in pane/i)).not.toBeInTheDocument();
  });
});

describe('moving a tab between panes', () => {
  it('drags a background tab to another strip, activates it once, and preserves both old actives', async () => {
    stubCoreApi({ items: [ALPHA, BRAVO, CHARLIE] });
    useTabStore.setState({
      workspaceId: STUB_WORKSPACE.id,
      byPane: {
        0: [
          { itemId: ALPHA.id, pinned: true },
          { itemId: CHARLIE.id, pinned: true },
        ],
        1: [{ itemId: BRAVO.id, pinned: true }],
      },
    });
    renderAt(<App />, `/?item=${ALPHA.id}&item2=${BRAVO.id}`);

    const firstPane = await screen.findByRole('article', { name: /Pane 1 of 2/ });
    const secondPane = screen.getByRole('article', { name: /Pane 2 of 2/ });
    const dataTransfer = tabDataTransfer();
    const charlie = await within(firstPane).findByRole('tab', { name: 'Charlie' });
    fireEvent.dragStart(charlie, { dataTransfer });
    const target = within(secondPane).getByRole('tablist', { name: 'Open documents' });
    fireEvent.dragEnter(target, { dataTransfer });
    fireEvent.dragOver(target, { dataTransfer });

    expect(dataTransfer.dropEffect).toBe('move');
    expect(screen.getByText('Drop tab here')).toBeInTheDocument();

    fireEvent.drop(target, { dataTransfer });

    const movedPane = await screen.findByRole('article', { name: /Pane 2 of 2: Charlie/ });
    expect(within(firstPane).getByRole('tab', { name: 'Alpha' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(within(movedPane).getByRole('tab', { name: 'Bravo' })).toBeInTheDocument();
    expect(within(movedPane).getByRole('tab', { name: 'Charlie' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getAllByRole('tab', { name: 'Charlie' })).toHaveLength(1);
    await waitFor(() => {
      expect(within(movedPane).getByRole('tab', { name: 'Charlie' })).toHaveFocus();
    });
    expect(screen.getByText('Moved Charlie to pane 2.')).toBeInTheDocument();
    expect(useTabStore.getState().byPane).toEqual({
      0: [{ itemId: ALPHA.id, pinned: true }],
      1: [
        { itemId: BRAVO.id, pinned: true },
        { itemId: CHARLIE.id, pinned: true },
      ],
    });
  });

  it('moves the active tab with the native picker and closes an empty source pane', async () => {
    stubCoreApi({ items: [ALPHA, BRAVO] });
    const user = userEvent.setup();
    renderAt(<App />, `/?item=${ALPHA.id}&item2=${BRAVO.id}`);

    const firstPane = await screen.findByRole('article', { name: /Pane 1 of 2/ });
    await within(firstPane).findByRole('tab', { name: 'Alpha' });
    await user.selectOptions(
      within(firstPane).getByRole('combobox', {
        name: 'Move active tab, Alpha, to another pane',
      }),
      '1',
    );

    await waitFor(() => {
      expect(screen.getAllByRole('article')).toHaveLength(1);
    });
    const onlyPane = screen.getByRole('article');
    expect(within(onlyPane).getByRole('tab', { name: 'Bravo' })).toBeInTheDocument();
    expect(within(onlyPane).getByRole('tab', { name: 'Alpha' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(
      within(onlyPane).queryByRole('combobox', { name: /Move active tab.*to another pane/ }),
    ).toBeNull();
    await waitFor(() => {
      expect(within(onlyPane).getByRole('tab', { name: 'Alpha' })).toHaveFocus();
    });
    expect(screen.getByText('Moved Alpha to pane 1.')).toBeInTheDocument();
  });

  it('lists every other visible pane in visual order and keeps the picker outside the tablist', async () => {
    stubCoreApi({ items: [ALPHA, BRAVO, CHARLIE] });
    renderAt(<App />, `/?item=${ALPHA.id}&item2=${BRAVO.id}&item3=${CHARLIE.id}`);

    const firstPane = await screen.findByRole('article', { name: /Pane 1 of 3/ });
    const picker = await within(firstPane).findByRole('combobox', {
      name: 'Move active tab, Alpha, to another pane',
    });
    expect(picker).toHaveClass('focus-visible:-outline-offset-2');
    expect(
      within(picker)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Move active tab…', 'Pane 2: Bravo', 'Pane 3: Charlie']);
    expect(
      within(firstPane).getByRole('tablist', { name: 'Open documents' }).contains(picker),
    ).toBe(false);
  });

  it('ignores external and same-pane drops, and clears a cancelled target highlight', async () => {
    stubCoreApi({ items: [ALPHA, BRAVO] });
    renderAt(<App />, `/?item=${ALPHA.id}&item2=${BRAVO.id}`);

    const firstPane = await screen.findByRole('article', { name: /Pane 1 of 2/ });
    await within(firstPane).findByRole('tab', { name: 'Alpha' });
    const secondPane = screen.getByRole('article', { name: /Pane 2 of 2/ });
    const source = within(firstPane).getByRole('tab', { name: 'Alpha' });
    const sourceStrip = within(firstPane).getByRole('tablist');
    const targetStrip = within(secondPane).getByRole('tablist');

    const external = tabDataTransfer();
    external.setData('text/plain', ALPHA.id);
    fireEvent.dragEnter(targetStrip, { dataTransfer: external });
    fireEvent.drop(targetStrip, { dataTransfer: external });
    expect(screen.queryByText('Drop tab here')).toBeNull();

    const internal = tabDataTransfer();
    fireEvent.dragStart(source, { dataTransfer: internal });
    fireEvent.dragEnter(sourceStrip, { dataTransfer: internal });
    expect(screen.queryByText('Drop tab here')).toBeNull();

    fireEvent.dragEnter(targetStrip, { dataTransfer: internal });
    expect(screen.getByText('Drop tab here')).toBeVisible();
    fireEvent.dragEnd(source, { dataTransfer: internal });
    expect(screen.queryByText('Drop tab here')).toBeNull();
    expect(useTabStore.getState().byPane).toEqual({});
  });

  it('offers neither dragging nor a move picker when later addressed panes are hidden', async () => {
    stubViewport(false);
    stubCoreApi({ items: [ALPHA, BRAVO] });
    renderAt(<App />, `/?item=${ALPHA.id}&item2=${BRAVO.id}`);

    await screen.findByRole('textbox', { name: 'Note title' });
    expect(screen.queryByRole('tab', { name: 'Alpha' })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: /Move active tab.*to another pane/ })).toBeNull();
    expect(screen.getByText('One more pane in this link opens on a wider screen.')).toBeVisible();
  });

  it('keeps the native move picker on a coarse pointer without making tabs draggable', async () => {
    globalThis.matchMedia = (query: string): MediaQueryList =>
      ({
        matches: query === '(pointer: fine)' ? false : true,
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      }) as MediaQueryList;
    stubCoreApi({ items: [ALPHA, BRAVO] });
    renderAt(<App />, `/?item=${ALPHA.id}&item2=${BRAVO.id}`);

    const firstPane = await screen.findByRole('article', { name: /Pane 1 of 2/ });
    await within(firstPane).findByRole('tab', { name: 'Alpha' });
    expect(within(firstPane).getByRole('tab', { name: 'Alpha' })).not.toHaveAttribute('draggable');
    expect(
      within(firstPane).getByRole('combobox', {
        name: 'Move active tab, Alpha, to another pane',
      }),
    ).toBeVisible();
  });
});

describe('refreshing', () => {
  it('collapses a pane back to the URL’s single item', async () => {
    stubCoreApi({ items: [ALPHA, BRAVO] });
    const user = userEvent.setup();
    const { unmount } = renderAt(<App />, `/?item=${ALPHA.id}`);

    await user.dblClick(await screen.findByRole('button', { name: 'Bravo' }));
    await screen.findByRole('tab', { name: 'Bravo' });
    expect(useTabStore.getState().byPane[0]).toEqual([{ itemId: BRAVO.id, pinned: true }]);

    // A refresh discards every in-memory store along with the rest of the page, including this
    // one - the tab list is session-local rather than URL-encoded, by design (`tab-store.ts`).
    unmount();
    useTabStore.setState({ byPane: {} });
    renderAt(<App />, `/?item=${BRAVO.id}`);

    expect(await screen.findByRole('tab', { name: 'Bravo' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.queryAllByRole('tab')).toHaveLength(1);
  });
});

describe('choosing horizontal or vertical tabs', () => {
  it('toggling in one pane switches every open pane, not just the one clicked', async () => {
    stubCoreApi({ items: [ALPHA, BRAVO] });
    const user = userEvent.setup();
    renderAt(<App />, `/?item=${ALPHA.id}&item2=${BRAVO.id}`);

    await screen.findByRole('tab', { name: 'Alpha' });
    for (const tablist of screen.getAllByRole('tablist')) {
      expect(tablist).not.toHaveAttribute('aria-orientation');
    }

    const firstPane = screen.getByRole('article', { name: /Pane 1 of 2/ });
    await user.click(within(firstPane).getByRole('button', { name: 'Show tabs on the side' }));

    await waitFor(() => {
      for (const tablist of screen.getAllByRole('tablist')) {
        expect(tablist).toHaveAttribute('aria-orientation', 'vertical');
      }
    });
  });

  it('switches back to horizontal on a second click', async () => {
    stubCoreApi({ items: [ALPHA] });
    const user = userEvent.setup();
    renderAt(<App />, `/?item=${ALPHA.id}`);

    await user.click(await screen.findByRole('button', { name: 'Show tabs on the side' }));
    await screen.findByRole('button', { name: 'Show tabs across the top' });

    await user.click(screen.getByRole('button', { name: 'Show tabs across the top' }));

    await waitFor(() => {
      expect(screen.getByRole('tablist')).not.toHaveAttribute('aria-orientation');
    });
  });
});

describe('the conversation as a tab', () => {
  it('shows beside the note, switches with it, and leaves the note when closed', async () => {
    stubCoreApi({ items: [ALPHA, BRAVO] });
    const user = userEvent.setup();
    renderAt(
      <>
        <App />
        <HistoryControls />
      </>,
      `/?item=${ALPHA.id}&chat=workspace`,
    );

    expect(await screen.findByRole('tab', { name: 'Chat' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(await screen.findByRole('tab', { name: 'Alpha' })).toHaveAttribute(
      'aria-selected',
      'false',
    );

    await user.click(screen.getByRole('tab', { name: 'Alpha' }));
    expect(await screen.findByRole('textbox', { name: /note title/i })).toHaveValue('Alpha');
    expect(screen.getByRole('tab', { name: 'Alpha' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Chat' })).toHaveAttribute('aria-selected', 'false');

    await user.click(screen.getByRole('tab', { name: 'Chat' }));
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'Chat' })).toHaveAttribute('aria-selected', 'true');
    });

    // Choosing a note replaces the conversation in the pane; Back returns to it.
    await user.click(screen.getByRole('button', { name: 'Open Bravo' }));
    expect(await screen.findByRole('textbox', { name: /note title/i })).toHaveValue('Bravo');
    await user.click(screen.getByRole('button', { name: 'Browser back' }));
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'Chat' })).toHaveAttribute('aria-selected', 'true');
    });

    await user.click(screen.getByTitle('Close Chat (Delete)'));
    expect(await screen.findByRole('textbox', { name: /note title/i })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Chat' })).not.toBeInTheDocument();
  });
});
