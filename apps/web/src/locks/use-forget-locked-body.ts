import { useEffect } from 'react';

import { useSessionStore } from '@nix/web-foundation/lib/session-store';
import { reopenRefusedItemBodies, sealItemBodies } from '@nix/web-foundation/lib/body-cache';
import { useOptionalWorkspace } from '../workspaces/workspace-context';
import type { ItemLockView } from './use-item-lock';

/**
 * A locked body is never kept on this device (ADR-0053). Editors already decline to cache one;
 * this removes a copy taken before the lock existed - by this person, or before someone else
 * locked it - the moment the page learns of the lock, whether or not the body is unlocked now.
 * Core answering for an unlocked item also lifts an earlier collaboration refusal's seal, which
 * would otherwise keep the note read-only on this device.
 */
export function useForgetLockedBody(
  itemId: string,
  lock: Pick<ItemLockView, 'status' | 'locked'>,
): void {
  const subject = useSessionStore((state) => state.profile?.subject);
  const workspaceId = useOptionalWorkspace()?.workspaceId;
  const ready = lock.status === 'ready';
  const locked = ready && lock.locked;

  useEffect(() => {
    if (!ready || subject === undefined || workspaceId === undefined) return;
    if (!locked) {
      reopenRefusedItemBodies(subject, workspaceId, itemId);
      return;
    }
    if (typeof indexedDB === 'undefined') return;
    void sealItemBodies(subject, workspaceId, itemId).catch(() => undefined);
  }, [itemId, locked, ready, subject, workspaceId]);
}
