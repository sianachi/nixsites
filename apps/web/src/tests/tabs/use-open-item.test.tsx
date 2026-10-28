import { act, renderHook } from '@testing-library/react';
import { type ReactNode } from 'react';
import { MemoryRouter, useLocation, useSearchParams } from 'react-router';
import { beforeEach, describe, expect, it } from 'vitest';

import { resetAnnouncements, useAnnouncement } from '../../a11y/announcer';
import { PaneProvider } from '../../panes/pane-context';
import { useTabStore } from '../../lib/tab-store';
import { useOpenItem } from '../../tabs/use-open-item';
import { stubViewport } from '../stub-viewport';

const A = '00000000-0000-4000-8000-000000000001';
const B = '00000000-0000-4000-8000-000000000002';
const C = '00000000-0000-4000-8000-000000000003';

function wrapperAt(search: string, pathname = '/', pane = 0) {
  return ({ children }: { children: ReactNode }) => (
    <MemoryRouter initialEntries={[`${pathname}?${search}`]}>
      <PaneProvider index={pane}>{children}</PaneProvider>
    </MemoryRouter>
  );
}

function renderOpenItem(search: string, pathname = '/', pane = 0) {
  return renderHook(
    () => ({
      open: useOpenItem(),
      params: useSearchParams()[0],
      pathname: useLocation().pathname,
      announcement: useAnnouncement(),
    }),
    { wrapper: wrapperAt(search, pathname, pane) },
  );
}

beforeEach(() => {
  useTabStore.setState({ byPane: {} });
  resetAnnouncements();
  stubViewport(true);
});

describe('previewing a document', () => {
  it('leaves a workspace destination and opens the document in a real pane', () => {
    useTabStore.setState({
      byPane: {
        0: [{ itemId: A, pinned: true }],
        1: [{ itemId: B, pinned: true }],
      },
    });
    const { result } = renderOpenItem('grain=week', '/calendar');

    act(() => {
      result.current.open.openPreview(B);
    });

    expect(result.current.pathname).toBe('/');
    expect(result.current.params.get('item')).toBe(B);
    expect(result.current.params.get('grain')).toBeNull();
    expect(useTabStore.getState().byPane).toEqual({
      0: [
        { itemId: A, pinned: true },
        { itemId: B, pinned: true },
      ],
    });
  });

  it('selects it in the current pane and records it as a preview tab, when it is not open anywhere', () => {
    const { result } = renderOpenItem(`item=${A}`);

    act(() => {
      result.current.open.openPreview(B);
    });

    expect(result.current.params.get('item')).toBe(B);
    expect(useTabStore.getState().byPane[0]).toEqual([{ itemId: B, pinned: false }]);
  });

  it('brings a hidden addressed pane into view without leaving a duplicate behind', () => {
    stubViewport(false);
    useTabStore.setState({
      byPane: {
        0: [{ itemId: A, pinned: true }],
        1: [{ itemId: B, pinned: true }],
      },
    });
    const { result } = renderOpenItem(`item=${A}&item2=${B}`);

    act(() => {
      result.current.open.openPreview(B);
    });

    expect(result.current.params.get('item')).toBe(B);
    expect(result.current.params.get('item2')).toBeNull();
    expect(useTabStore.getState().byPane).toEqual({
      0: [
        { itemId: A, pinned: true },
        { itemId: B, pinned: true },
      ],
    });
  });

  it('focuses the pane a document is already pinned in, rather than opening a second copy', () => {
    useTabStore.setState({ byPane: { 1: [{ itemId: B, pinned: true }] } });
    const { result } = renderOpenItem(`item=${A}&item2=${C}`);

    act(() => {
      result.current.open.openPreview(B);
    });

    // Pane 0 is untouched - the document belongs to pane 1, which the address now shows.
    expect(result.current.params.get('item')).toBe(A);
    expect(result.current.params.get('item2')).toBe(B);
    // Focusing an existing tab never demotes it.
    expect(useTabStore.getState().byPane[1]).toEqual([{ itemId: B, pinned: true }]);
    expect(result.current.announcement.text).toContain('Already open in pane 2.');
  });

  it('does nothing when the document is already the pane it is open in', () => {
    const { result } = renderOpenItem(`item=${A}&item2=${B}`);

    act(() => {
      result.current.open.openPreview(B);
    });

    expect(result.current.params.get('item')).toBe(A);
    expect(result.current.params.get('item2')).toBe(B);
  });

  it('keeps a restored pinned tab in its addressed pane when a link there opens another note', () => {
    useTabStore.setState({
      byPane: {
        0: [
          { itemId: A, pinned: true },
          { itemId: B, pinned: true },
        ],
      },
    });
    const { result } = renderOpenItem(`item=${A}&item2=${B}`, '/', 1);

    act(() => {
      result.current.open.openPreview(C);
    });

    expect(result.current.params.get('item')).toBe(A);
    expect(result.current.params.get('item2')).toBe(C);
    expect(useTabStore.getState().byPane).toEqual({
      0: [{ itemId: A, pinned: true }],
      1: [
        { itemId: B, pinned: true },
        { itemId: C, pinned: false },
      ],
    });
  });
});

describe('pinning a document', () => {
  it('opens and pins it in the current pane, when it is not open anywhere', () => {
    const { result } = renderOpenItem(`item=${A}`);

    act(() => {
      result.current.open.openPinned(B);
    });

    expect(result.current.params.get('item')).toBe(B);
    expect(useTabStore.getState().byPane[0]).toEqual([{ itemId: B, pinned: true }]);
  });

  it('promotes an already-open preview tab in another pane rather than duplicating it', () => {
    useTabStore.setState({ byPane: { 1: [{ itemId: B, pinned: false }] } });
    const { result } = renderOpenItem(`item=${A}&item2=${B}`);

    act(() => {
      result.current.open.openPinned(B);
    });

    expect(useTabStore.getState().byPane[1]).toEqual([{ itemId: B, pinned: true }]);
  });
});

describe('opening a document beside', () => {
  it('refuses on a workspace destination, where there is no document to open beside', () => {
    const { result } = renderOpenItem('grain=week', '/calendar');

    let openedPane: number | null = 1;
    act(() => {
      openedPane = result.current.open.openBeside(B);
    });

    expect(openedPane).toBeNull();
    expect(result.current.pathname).toBe('/calendar');
    expect(result.current.params.get('item')).toBeNull();
    expect(result.current.open.canOpenBeside).toBe(false);
    expect(result.current.open.besideRefusal).toBe('destination');
    expect(result.current.announcement.text).toContain('Open a note before opening another');
  });

  it('keeps the narrow-window refusal on a workspace destination', () => {
    stubViewport(false);
    const { result } = renderOpenItem('', '/calendar');

    expect(result.current.open.canOpenBeside).toBe(false);
    expect(result.current.open.besideRefusal).toBe('narrow');

    act(() => {
      result.current.open.openBeside(B);
    });

    expect(result.current.announcement.text).toContain('too narrow');
  });

  it('refuses to focus an addressed pane hidden by a narrow window', () => {
    stubViewport(false);
    useTabStore.setState({
      byPane: {
        0: [{ itemId: A, pinned: true }],
        1: [{ itemId: B, pinned: true }],
      },
    });
    const { result } = renderOpenItem(`item=${A}&item2=${B}`);

    let openedPane: number | null = 1;
    act(() => {
      openedPane = result.current.open.openBeside(B);
    });

    expect(openedPane).toBeNull();
    expect(result.current.params.get('item')).toBe(A);
    expect(result.current.params.get('item2')).toBe(B);
    expect(result.current.announcement.text).toContain('too narrow');
  });

  it('opens a new pane and pins it there immediately', () => {
    const { result } = renderOpenItem(`item=${A}`);

    let openedPane: number | null = null;
    act(() => {
      openedPane = result.current.open.openBeside(B);
    });

    expect(openedPane).toBe(1);
    expect(result.current.params.get('item2')).toBe(B);
    expect(useTabStore.getState().byPane[1]).toEqual([{ itemId: B, pinned: true }]);
  });

  it('focuses and pins an already-open backgrounded tab instead of opening a duplicate pane', () => {
    useTabStore.setState({
      byPane: {
        0: [
          { itemId: A, pinned: true },
          { itemId: B, pinned: false },
        ],
      },
    });
    const { result } = renderOpenItem(`item=${A}`);

    let openedPane: number | null = null;
    act(() => {
      openedPane = result.current.open.openBeside(B);
    });

    expect(openedPane).toBe(0);
    expect(result.current.params.get('item2')).toBeNull();
    expect(result.current.params.get('item')).toBe(B);
    expect(useTabStore.getState().byPane[0]).toEqual([
      { itemId: A, pinned: true },
      { itemId: B, pinned: true },
    ]);
  });
});
