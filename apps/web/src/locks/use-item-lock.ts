import { isCanceledError, isNixApiError, locks, type ItemLock } from '@nix/api-client';
import { useCallback, useEffect, useState } from 'react';

import { useApiClient } from '@nix/web-platform/api/api-client-provider';

/**
 * An item's lock, as this browser session sees it, and the actions on it.
 *
 * **Core decides; this reports.** Whether the body is served is answered by Core on every read, so
 * nothing here unlocks anything by itself. What this hook adds is the moment the grant runs out:
 * it closes the body when `unlockedUntil` passes, says so a minute before, and says afterwards why
 * the body closed - rather than waiting for the collaboration service to refuse its next re-check.
 *
 * **Every state is separate**, like the backlinks panel: loading is not "unlocked", and a failed
 * read is not "not locked". Treating either as open would draw an editor that then fails to
 * connect, which reads as the note having gone missing.
 *
 * **A lock covers its subtree.** An item inside a locked item is locked by it, and so are its
 * children and views. `lockItemId` names the item whose password opens this one - the item itself,
 * or an ancestor - and unlocking or locking again acts on that item, so a note inside a locked
 * folder is opened with the folder's password and closes with the folder.
 *
 * **A change that does not close the body keeps it on screen.** Setting, changing or removing a
 * lock re-reads the state behind the last answer rather than dropping to "loading", so the editor,
 * the toolbar button and the dialog it opened stay mounted and keep their focus. Only closing - a
 * relock or an expiry - clears the answer, because then the body must go at once.
 */

export type ItemLockStatus = 'loading' | 'ready' | 'error';

/** Why an open body closed, so the prompt that replaces it can say so. */
export type LockClosedReason = 'relocked' | 'expired';

export interface ItemLockView {
  readonly status: ItemLockStatus;

  /** Whether the item is locked, by its own lock or an ancestor's. */
  readonly locked: boolean;

  /** Whether the item has a lock of its own, which is what setting or removing a lock acts on. */
  readonly selfLocked: boolean;

  /**
   * The item whose password opens this one next - itself or an ancestor - or null when nothing is
   * locked. When it is not this item, the prompt names that item instead.
   */
  readonly lockItemId: string | null;

  /** When this session's unlock ends, or null when it holds none. */
  readonly unlockedUntil: Date | null;

  /** Whether the body may be drawn: the lock state is known, and it is absent or open. */
  readonly open: boolean;

  /** Whether the unlock ends within a minute, so the page can warn before the body closes. */
  readonly closingSoon: boolean;

  /** Why the body was closed while it was being read, or null when it was never open here. */
  readonly closedReason: LockClosedReason | null;

  readonly retry: () => void;

  /**
   * Opens the lock `lockItemId` names for this session. Resolves to a refusal message, or null once
   * the password was accepted and the state re-read - which may still be closed, when a second lock
   * covers the item.
   */
  readonly unlock: (password: string) => Promise<string | null>;

  /**
   * Closes the lock `lockItemId` names to this session again - an ancestor's closes everything
   * under it. Resolves to a refusal message, or null on success.
   */
  readonly relock: () => Promise<string | null>;

  /** Sets a lock, or changes its password when `currentPassword` is given. */
  readonly setLock: (password: string, currentPassword?: string) => Promise<string | null>;

  /** Removes the lock. */
  readonly removeLock: (password: string) => Promise<string | null>;
}

interface LockAnswer {
  readonly itemId: string;
  readonly request: string;
  readonly locked: boolean;
  readonly unlockedUntil: Date | null;
  readonly lockItemId: string | null;
  readonly selfLocked: boolean;
  readonly failed: boolean;
}

function answerFrom(itemId: string, request: string, parsed: ItemLock): LockAnswer {
  return {
    itemId,
    request,
    locked: parsed.locked,
    unlockedUntil: parsed.unlockedUntil === null ? null : new Date(parsed.unlockedUntil),
    lockItemId: parsed.lockItemId,
    selfLocked: parsed.selfLocked,
    failed: false,
  };
}

interface Reload {
  readonly attempt: number;

  /** Whether the last answer must stop being shown until the new one arrives. */
  readonly hard: boolean;
  readonly reason: LockClosedReason | null;
}

/**
 * The longest a timer is armed for. A grant is fifteen minutes; anything longer is a clock that
 * disagrees with the server's, and re-reading sooner is the safe side of that disagreement.
 */
const MAX_TIMER_MS = 15 * 60 * 1000;

/** How long before the grant ends the page is told, so a warning can come first. */
const WARNING_MS = 60 * 1000;

/**
 * The shortest a close timer waits. The expiry is the server's clock and the timer is this
 * browser's; one running ahead would otherwise fire at once, re-read the same still-valid grant,
 * and fire again in a tight loop. Closing a few seconds late is harmless - Core refuses the body
 * on its own clock regardless.
 */
const MIN_TIMER_MS = 5 * 1000;

export function useItemLock(itemId: string): ItemLockView {
  const client = useApiClient();
  const [answer, setAnswer] = useState<LockAnswer | null>(null);
  const [reload, setReload] = useState<Reload>({ attempt: 0, hard: true, reason: null });
  const [closingSoonFor, setClosingSoonFor] = useState<number | null>(null);

  const refresh = useCallback((hard: boolean, reason: LockClosedReason | null = null) => {
    setReload((previous) => ({ attempt: previous.attempt + 1, hard, reason }));
  }, []);

  const retry = useCallback(() => {
    refresh(true);
  }, [refresh]);

  const request = `${itemId}:${String(reload.attempt)}`;
  const fresh = answer !== null && answer.request === request ? answer : null;
  // The last answer for this item, kept on screen while a soft re-read is in flight. Never for a
  // different item, and never across a hard reload - that is a body that has to close now.
  const stale =
    fresh === null && !reload.hard && answer !== null && answer.itemId === itemId && !answer.failed
      ? answer
      : null;
  const current = fresh ?? stale;

  useEffect(() => {
    const controller = new AbortController();
    const live = { current: true };

    void (async () => {
      try {
        const parsed = await client.query(locks.getItemLock(itemId), {
          signal: controller.signal,
          // Always from Core: a cached "open" would draw an editor for a grant that has ended.
          forceRefresh: true,
        });
        if (!live.current) return;
        setAnswer(answerFrom(itemId, request, parsed));
      } catch (cause) {
        if (controller.signal.aborted || !live.current || isCanceledError(cause)) return;
        console.warn('The lock read failed.', cause);
        setAnswer({
          itemId,
          request,
          locked: false,
          unlockedUntil: null,
          lockItemId: null,
          selfLocked: false,
          failed: true,
        });
      }
    })();

    return () => {
      live.current = false;
      controller.abort();
    };
  }, [client, itemId, request]);

  // Warn a minute before the grant runs out, then close the body when it does.
  const expiry = current?.unlockedUntil?.getTime() ?? null;
  useEffect(() => {
    if (expiry === null) return;
    const remaining = expiry - Date.now();
    const warn = setTimeout(
      () => {
        setClosingSoonFor(expiry);
      },
      Math.min(Math.max(remaining - WARNING_MS, 0), MAX_TIMER_MS),
    );
    const close = setTimeout(
      () => {
        refresh(true, 'expired');
      },
      Math.min(Math.max(remaining, MIN_TIMER_MS), MAX_TIMER_MS),
    );
    return () => {
      clearTimeout(warn);
      clearTimeout(close);
    };
  }, [expiry, refresh]);

  // The lock to act on: the one Core named, which may be an ancestor's, or this item's own.
  const target = current?.lockItemId ?? itemId;

  const unlock = useCallback(
    async (password: string): Promise<string | null> => {
      try {
        await client.execute(locks.unlockItem(target, password));
      } catch (cause) {
        return refusal(cause, 'This could not be unlocked. Try again.');
      }
      // Re-read rather than trusting the unlock's own answer: another lock may still cover the
      // item - its own inside a locked folder, say - and only Core knows whether the body is open.
      try {
        const parsed = await client.query(locks.getItemLock(itemId), { forceRefresh: true });
        setAnswer(answerFrom(itemId, request, parsed));
      } catch (cause) {
        if (!isCanceledError(cause)) refresh(false);
      }
      return null;
    },
    [client, itemId, refresh, request, target],
  );

  const relock = useCallback(async (): Promise<string | null> => {
    try {
      await client.execute(locks.relockItem(target));
    } catch (cause) {
      // Re-read either way: if the relock failed, the grant may still stand, and the page should
      // show what Core says rather than what was asked for.
      refresh(true);
      return refusal(cause, 'This could not be locked again. Try again.');
    }
    refresh(true, 'relocked');
    return null;
  }, [client, refresh, target]);

  const setLock = useCallback(
    async (password: string, currentPassword?: string): Promise<string | null> => {
      try {
        await client.execute(locks.setItemLock(itemId, password, currentPassword));
        refresh(false);
        return null;
      } catch (cause) {
        return refusal(cause, 'The lock could not be saved. Try again.');
      }
    },
    [client, itemId, refresh],
  );

  const removeLock = useCallback(
    async (password: string): Promise<string | null> => {
      try {
        await client.execute(locks.removeItemLock(itemId, password));
        refresh(false);
        return null;
      } catch (cause) {
        return refusal(cause, 'The lock could not be removed. Try again.');
      }
    },
    [client, itemId, refresh],
  );

  const status: ItemLockStatus = current === null ? 'loading' : current.failed ? 'error' : 'ready';
  const locked = current?.locked ?? false;
  const selfLocked = current?.selfLocked ?? false;
  const lockItemId = current?.lockItemId ?? null;
  const unlockedUntil = current?.unlockedUntil ?? null;
  const open = status === 'ready' && (!locked || unlockedUntil !== null);

  return {
    status,
    locked,
    selfLocked,
    lockItemId,
    unlockedUntil,
    open,
    closingSoon: open && expiry !== null && closingSoonFor === expiry,
    closedReason: reload.reason,
    retry,
    unlock,
    relock,
    setLock,
    removeLock,
  };
}

/** What to tell somebody whose lock request was refused, by the code Core returned. */
function refusal(cause: unknown, fallback: string): string {
  if (!isNixApiError(cause)) return fallback;
  switch (cause.code) {
    case 'locks.wrong_password':
      return 'That password is not right.';
    case 'locks.password_invalid':
      return 'Use a password of 4 to 256 characters.';
    case 'locks.already_locked':
      return 'This is already locked. Enter its current password to change it.';
    case 'locks.not_locked':
      return 'This is no longer locked.';
    case 'locks.credential_cannot_unlock':
      return 'This sign-in cannot unlock items. Sign in through the browser and try again.';
    // A lock can be changed only by somebody who can edit the item; Core answers anyone else
    // as it answers an item they cannot see.
    case 'items.not_found':
      return 'You do not have permission to change this lock.';
    case 'request.rate_limited':
      return 'Too many attempts. Wait a minute and try again.';
    default:
      return fallback;
  }
}
