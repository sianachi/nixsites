import { Button, Dialog, Text } from '@nix/ui';
import { useRef, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';

import { useAuth } from '@nix/web-platform/auth/auth-provider';
import { useSessionStore } from '@nix/web-foundation/lib/session-store';
import { bodyCacheAccountEpoch } from '@nix/web-foundation/lib/body-cache';
import { flushLocalDraftsForAccount } from '@nix/web-editor/editor/collab-sync';
import { listDraftScopes } from '@nix/web-foundation/lib/draft-journal';

interface SignOutIntent {
  readonly subject: string;
  readonly epoch: string | null;
}

type Phase = 'idle' | 'checking' | 'confirming' | 'signing-out';

export function usePendingSignOut(beforeCheck?: () => Promise<void>): {
  readonly requestSignOut: () => Promise<void>;
  readonly phase: Phase;
  readonly error: string | null;
  readonly dialog: ReactNode;
} {
  const { signOut } = useAuth();
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [hasPending, setHasPending] = useState(false);
  const running = useRef(false);
  const intentRef = useRef<SignOutIntent | null>(null);

  function assertCurrent(intent: SignOutIntent): void {
    if (
      useSessionStore.getState().profile?.subject !== intent.subject ||
      bodyCacheAccountEpoch(intent.subject) !== intent.epoch
    ) {
      throw new Error('The account changed. Sign out from its current session.');
    }
  }

  async function requestSignOut(): Promise<void> {
    const profile = useSessionStore.getState().profile;
    if (running.current || intentRef.current !== null || profile === null) return;
    const intent: SignOutIntent = {
      subject: profile.subject,
      epoch: bodyCacheAccountEpoch(profile.subject),
    };
    intentRef.current = intent;
    running.current = true;
    // Opening the native modal makes the editor inert before its final writes are drained.
    flushSync(() => {
      setError(null);
      setPhase('checking');
    });
    try {
      assertCurrent(intent);
      await beforeCheck?.();
      await flushLocalDraftsForAccount(intent.subject);
      assertCurrent(intent);
      const scopes = await listDraftScopes(intent.subject);
      assertCurrent(intent);
      setHasPending(scopes.length > 0);
      // Other tabs can keep writing after this inventory. Removal always needs an explicit choice.
      setPhase('confirming');
    } catch (cause) {
      intentRef.current = null;
      setPhase('idle');
      setError(
        cause instanceof Error
          ? cause.message
          : 'Saved edits could not be checked. Keep this note open and try again.',
      );
    } finally {
      running.current = false;
    }
  }

  function cancel(): void {
    if (running.current || phase !== 'confirming') return;
    intentRef.current = null;
    setPhase('idle');
  }

  async function confirm(): Promise<void> {
    const intent = intentRef.current;
    if (running.current || intent === null) return;
    running.current = true;
    try {
      assertCurrent(intent);
      intentRef.current = null;
      setPhase('signing-out');
      await signOut();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Sign-out could not be completed. Try again.',
      );
    } finally {
      intentRef.current = null;
      running.current = false;
      setPhase('idle');
    }
  }

  const confirming = phase === 'confirming';
  return {
    requestSignOut,
    phase,
    error,
    dialog: (
      <Dialog
        open={phase !== 'idle'}
        title={
          confirming
            ? hasPending
              ? 'Sign out with pending changes?'
              : 'Sign out and remove local notes?'
            : phase === 'signing-out'
              ? 'Signing out'
              : 'Checking saved edits'
        }
        onClose={cancel}
        actions={
          confirming ? (
            <>
              <Button variant="secondary" onClick={cancel}>
                Keep editing
              </Button>
              <Button variant="danger" onClick={() => void confirm()}>
                Sign out and remove local notes
              </Button>
            </>
          ) : undefined
        }
      >
        <Text as="p" variant="body">
          {confirming
            ? hasPending
              ? 'Signing out removes notes and pending changes from this device. Reconnect and sync first to keep your unsynced writing.'
              : 'Signing out removes this account’s notes saved on this device, including changes in other tabs. Sync your writing first to keep it.'
            : phase === 'checking'
              ? 'Saving your latest edits on this device and checking for changes that still need to sync.'
              : 'Removing this account’s notes from this device.'}
        </Text>
      </Dialog>
    ),
  };
}
