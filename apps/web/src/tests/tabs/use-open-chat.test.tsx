import { act, renderHook } from '@testing-library/react';
import { type ReactNode } from 'react';
import { MemoryRouter, useLocation, useSearchParams } from 'react-router';
import { beforeEach, describe, expect, it } from 'vitest';

import { PaneProvider } from '@nix/web-platform/panes/pane-context';
import { useTabStore } from '@nix/web-foundation/lib/tab-store';
import { useOpenChat } from '@nix/web-pets/pets/use-open-chat';
import { stubViewport } from '@nix/web-foundation/testing/stub-viewport';

const WORKSPACE = '00000000-0000-4000-8000-0000000000aa';
const A = '00000000-0000-4000-8000-000000000001';
const B = '00000000-0000-4000-8000-000000000002';
const EDITOR = `/w/${WORKSPACE}`;

function renderOpenChat(search: string, pathname = EDITOR, pane = 0) {
  return renderHook(
    () => ({
      openChat: useOpenChat(),
      params: useSearchParams()[0],
      location: useLocation(),
    }),
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <MemoryRouter initialEntries={[`${pathname}?${search}`]}>
          <PaneProvider index={pane}>{children}</PaneProvider>
        </MemoryRouter>
      ),
    },
  );
}

beforeEach(() => {
  useTabStore.setState({ byPane: {} });
  stubViewport(true);
});

describe('opening the conversation as a tab', () => {
  it('shows the workspace conversation in the pane and pins its tab', () => {
    const { result } = renderOpenChat(`item=${A}`);

    act(() => {
      result.current.openChat(null);
    });

    expect(result.current.params.get('chat')).toBe('workspace');
    expect(result.current.params.get('item')).toBe(A);
    expect(useTabStore.getState().byPane[0]).toEqual([{ itemId: 'chat:workspace', pinned: true }]);
  });

  it('opens a note conversation in the pane it was asked from', () => {
    const { result } = renderOpenChat(`item=${A}&item2=${B}`, EDITOR, 1);

    act(() => {
      result.current.openChat(B);
    });

    expect(result.current.params.get('chat2')).toBe(B);
    expect(result.current.params.get('chat')).toBeNull();
  });

  it('focuses the pane that already has the conversation instead of opening it twice', () => {
    const { result } = renderOpenChat(`item=${A}&item2=${B}&chat2=workspace`);

    act(() => {
      result.current.openChat(null);
    });

    expect(result.current.params.get('chat')).toBeNull();
    expect(result.current.params.get('chat2')).toBe('workspace');
  });

  it('brings a backgrounded conversation forward in the pane that holds it', () => {
    useTabStore.setState({ byPane: { 1: [{ itemId: 'chat:workspace', pinned: true }] } });
    const { result } = renderOpenChat(`item=${A}&item2=${B}`);

    act(() => {
      result.current.openChat(null);
    });

    expect(result.current.params.get('chat2')).toBe('workspace');
    expect(result.current.params.get('chat')).toBeNull();
  });

  it('opens the companion page on a narrow window, where no strip is drawn', () => {
    stubViewport(false);
    const { result } = renderOpenChat(`item=${A}`);

    act(() => {
      result.current.openChat(A);
    });

    expect(result.current.location.pathname).toBe(`${EDITOR}/pet`);
    expect(result.current.location.search).toBe(`?root=${A}`);
  });

  it('opens the companion page when no pane is open', () => {
    const { result } = renderOpenChat('');

    act(() => {
      result.current.openChat(null);
    });

    expect(result.current.location.pathname).toBe(`${EDITOR}/pet`);
    expect(result.current.location.search).toBe('');
  });
});
