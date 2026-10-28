import { renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it } from 'vitest';

import { useTabStore } from '@nix/web-foundation/lib/tab-store';
import { useDocumentTabs } from '../../tabs/use-document-tabs';

beforeEach(() => {
  useTabStore.setState({ byPane: {} });
});

function renderTabs(pane: number, activeItemId: string, search = '') {
  return renderHook(() => useDocumentTabs(pane, activeItemId), {
    wrapper: ({ children }: { children: ReactNode }) =>
      createElement(MemoryRouter, { initialEntries: [`/?${search}`] }, children),
  });
}

describe('the tab strip a pane draws', () => {
  it('shows the active item as an unpinned tab when the store has never heard of it', () => {
    const { result } = renderTabs(0, 'a');

    expect(result.current.tabs).toEqual([{ itemId: 'a', pinned: false }]);
  });

  it('does not duplicate the active item when it is already tracked', () => {
    useTabStore.setState({ byPane: { 0: [{ itemId: 'a', pinned: true }] } });

    const { result } = renderTabs(0, 'a');

    expect(result.current.tabs).toEqual([{ itemId: 'a', pinned: true }]);
  });

  it('appends the active item alongside tabs already tracked for the pane', () => {
    useTabStore.setState({ byPane: { 0: [{ itemId: 'a', pinned: true }] } });

    const { result } = renderTabs(0, 'b');

    expect(result.current.tabs).toEqual([
      { itemId: 'a', pinned: true },
      { itemId: 'b', pinned: false },
    ]);
  });

  it('reads only its own pane’s tabs', () => {
    useTabStore.setState({ byPane: { 1: [{ itemId: 'z', pinned: true }] } });

    const { result } = renderTabs(0, 'a');

    expect(result.current.tabs).toEqual([{ itemId: 'a', pinned: false }]);
  });

  it('gives an addressed document to only its active pane when history restores a split', () => {
    const first = '00000000-0000-4000-8000-000000000001';
    const second = '00000000-0000-4000-8000-000000000002';
    const search = `item=${first}&item2=${second}`;
    useTabStore.setState({
      byPane: {
        0: [
          { itemId: first, pinned: true },
          { itemId: second, pinned: true },
        ],
      },
    });

    const firstPane = renderTabs(0, first, search);
    const secondPane = renderTabs(1, second, search);

    expect(firstPane.result.current.tabs).toEqual([{ itemId: first, pinned: true }]);
    expect(secondPane.result.current.tabs).toEqual([{ itemId: second, pinned: true }]);
  });

  it('draws the pane’s open conversation beside its item, pinned', () => {
    const first = '00000000-0000-4000-8000-000000000001';

    const { result } = renderTabs(0, first, `item=${first}&chat=workspace`);

    expect(result.current.tabs).toEqual([
      { itemId: first, pinned: false },
      { itemId: 'chat:workspace', pinned: true },
    ]);
  });

  it('gives a conversation to one pane only', () => {
    const first = '00000000-0000-4000-8000-000000000001';
    const second = '00000000-0000-4000-8000-000000000002';
    const search = `item=${first}&chat=workspace&item2=${second}`;
    useTabStore.setState({ byPane: { 1: [{ itemId: 'chat:workspace', pinned: true }] } });

    const firstPane = renderTabs(0, first, search);
    const secondPane = renderTabs(1, second, search);

    expect(firstPane.result.current.tabs.map((tab) => tab.itemId)).toEqual([
      first,
      'chat:workspace',
    ]);
    expect(secondPane.result.current.tabs.map((tab) => tab.itemId)).toEqual([second]);
  });
});
