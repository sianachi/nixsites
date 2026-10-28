import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryRouter, useLocation, useNavigate } from 'react-router';

import { parsePanes } from '../../panes/pane-state';
import { tabsForPane } from '../../tabs/tab-ownership';
import { useTabStore } from '../../lib/tab-store';
import { useTabTransfer } from '../../tabs/use-tab-transfer';

const ALPHA = '0a0a0a0a-0000-4000-8000-00000000000a';
const BRAVO = '0b0b0b0b-0000-4000-8000-00000000000b';
const CHARLIE = '0c0c0c0c-0000-4000-8000-00000000000c';

beforeEach(() => {
  useTabStore.setState({ byPane: {} });
});

describe('coordinating a tab transfer with browser history', () => {
  it('pushes one complete move and keeps Back and Forward free of duplicate ownership', async () => {
    const original =
      `/?item=${ALPHA}&view=board&f.status=open&item2=${BRAVO}` +
      '&view2=calendar&f2.owner=ada&sizes=60,40&split=h&keep=yes';
    useTabStore.setState({
      byPane: {
        0: [
          { itemId: ALPHA, pinned: true },
          { itemId: CHARLIE, pinned: false },
        ],
      },
    });

    const { result } = renderHook(
      () => ({
        transfer: useTabTransfer([0, 1]),
        location: useLocation(),
        navigate: useNavigate(),
      }),
      {
        wrapper: ({ children }) => (
          <MemoryRouter initialEntries={['/calendar', original]} initialIndex={1}>
            {children}
          </MemoryRouter>
        ),
      },
    );

    act(() => {
      result.current.transfer.moveTab({ version: 1, itemId: CHARLIE, sourcePane: 0 }, 1, 'Charlie');
    });

    let moved = new URLSearchParams(result.current.location.search);
    expect(moved.get('item')).toBe(ALPHA);
    expect(moved.get('view')).toBe('board');
    expect(moved.getAll('f.status')).toEqual(['open']);
    expect(moved.get('item2')).toBe(CHARLIE);
    expect(moved.has('view2')).toBe(false);
    expect(moved.has('f2.owner')).toBe(false);
    expect(moved.get('sizes')).toBe('60,40');
    expect(moved.get('split')).toBe('h');
    expect(moved.get('keep')).toBe('yes');

    act(() => {
      void result.current.navigate(-1);
    });
    await waitFor(() => {
      expect(result.current.location.search).toBe(original.slice(1));
    });

    const restoredParams = new URLSearchParams(result.current.location.search);
    const restored = parsePanes(restoredParams).panes;
    const byPane = useTabStore.getState().byPane;
    const visible = restored.flatMap((pane) =>
      tabsForPane(pane.index, pane.itemId, restored, byPane).filter(
        (tab) => tab.itemId === CHARLIE,
      ),
    );
    expect(visible).toHaveLength(1);

    act(() => {
      void result.current.navigate(-1);
    });
    await waitFor(() => {
      expect(result.current.location.pathname).toBe('/calendar');
    });

    act(() => {
      void result.current.navigate(2);
    });
    await waitFor(() => {
      expect(new URLSearchParams(result.current.location.search).get('item2')).toBe(CHARLIE);
    });
    moved = new URLSearchParams(result.current.location.search);
    expect(moved.get('sizes')).toBe('60,40');
  });

  it('restores and reapplies a source-closing three-pane move without duplicate owners', async () => {
    const original =
      `/?item=${ALPHA}&view=board&item2=${BRAVO}&view2=list&item3=${CHARLIE}` +
      '&view3=calendar&sizes=20,30,50&split=h';
    const { result } = renderHook(
      () => ({
        transfer: useTabTransfer([0, 1, 2]),
        location: useLocation(),
        navigate: useNavigate(),
      }),
      {
        wrapper: ({ children }) => (
          <MemoryRouter initialEntries={['/calendar', original]} initialIndex={1}>
            {children}
          </MemoryRouter>
        ),
      },
    );

    act(() => {
      result.current.transfer.moveTab({ version: 1, itemId: ALPHA, sourcePane: 0 }, 2, 'Alpha');
    });

    let current = new URLSearchParams(result.current.location.search);
    expect(current.get('item')).toBe(BRAVO);
    expect(current.get('item2')).toBe(ALPHA);
    expect(current.has('item3')).toBe(false);
    expect(current.has('sizes')).toBe(false);

    act(() => {
      void result.current.navigate(-1);
    });
    await waitFor(() => {
      expect(result.current.location.search).toBe(original.slice(1));
    });

    const restored = parsePanes(new URLSearchParams(result.current.location.search)).panes;
    const restoredCopies = restored.flatMap((pane) =>
      tabsForPane(pane.index, pane.itemId, restored, useTabStore.getState().byPane).filter(
        (tab) => tab.itemId === ALPHA,
      ),
    );
    expect(restoredCopies).toHaveLength(1);

    act(() => {
      void result.current.navigate(1);
    });
    await waitFor(() => {
      expect(new URLSearchParams(result.current.location.search).get('item2')).toBe(ALPHA);
    });

    current = new URLSearchParams(result.current.location.search);
    expect(current.get('item')).toBe(BRAVO);
    expect(current.has('item3')).toBe(false);
    const reapplied = parsePanes(current).panes;
    const reappliedCopies = reapplied.flatMap((pane) =>
      tabsForPane(pane.index, pane.itemId, reapplied, useTabStore.getState().byPane).filter(
        (tab) => tab.itemId === ALPHA,
      ),
    );
    expect(reappliedCopies).toHaveLength(1);
  });
});
