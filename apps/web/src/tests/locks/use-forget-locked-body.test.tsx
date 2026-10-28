import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useSessionStore } from '@nix/web-foundation/lib/session-store';
import * as bodies from '@nix/web-foundation/lib/body-cache';
import { useForgetLockedBody } from '../../locks/use-forget-locked-body';
import * as workspaces from '@nix/web-workspaces/workspaces/workspace-context';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function signedInTo(workspaceId: string): void {
  useSessionStore.setState({
    status: 'authenticated',
    profile: { subject: 'person-1', name: 'Person', email: null },
    error: null,
  });
  vi.spyOn(workspaces, 'useOptionalWorkspace').mockReturnValue({
    workspaceId,
  } as ReturnType<typeof workspaces.useOptionalWorkspace>);
  vi.stubGlobal('indexedDB', {});
}

describe('forgetting a locked body', () => {
  it('removes this device’s copies once the item is known to be locked, open or not', () => {
    signedInTo('workspace-1');
    const seal = vi.spyOn(bodies, 'sealItemBodies').mockResolvedValue(undefined);

    renderHook(() => {
      useForgetLockedBody('item-1', { status: 'ready', locked: true });
    });

    expect(seal).toHaveBeenCalledWith('person-1', 'workspace-1', 'item-1');
  });

  it('reopens a refused copy of an unlocked item, and decides nothing while the lock is still loading', () => {
    signedInTo('workspace-1');
    const seal = vi.spyOn(bodies, 'sealItemBodies').mockResolvedValue(undefined);
    const reopen = vi.spyOn(bodies, 'reopenRefusedItemBodies').mockReturnValue(undefined);

    renderHook(() => {
      useForgetLockedBody('item-1', { status: 'loading', locked: true });
    });
    expect(reopen).not.toHaveBeenCalled();
    renderHook(() => {
      useForgetLockedBody('item-1', { status: 'ready', locked: false });
    });

    expect(seal).not.toHaveBeenCalled();
    expect(reopen).toHaveBeenCalledWith('person-1', 'workspace-1', 'item-1');
  });
});
