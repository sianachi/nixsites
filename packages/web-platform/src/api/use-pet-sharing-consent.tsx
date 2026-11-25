import {
  isNixApiError,
  petPlans,
  type NixClient,
  type PetPlanSharingQuestion,
  type PetPlanSourceScope,
} from '@nix/api-client';
import { Button, Text } from '@nix/ui';
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { PetSharingQuestion } from './pet-sharing-question';

export function useSharingConsent({
  client,
  workspaceId,
  petId,
  selectionKey,
}: {
  readonly client: NixClient;
  readonly workspaceId: string;
  readonly petId: string;
  readonly selectionKey: string;
}): {
  readonly ensure: (scope: PetPlanSourceScope | null) => Promise<boolean>;
  readonly panel: ReactElement;
  readonly cancel: () => void;
} {
  const [pending, setPending] = useState<{
    readonly question: PetPlanSharingQuestion;
    readonly scope: PetPlanSourceScope;
    readonly requestId: string;
    readonly selectionKey: string;
  } | null>(null);
  const [busyScope, setBusyScope] = useState<string | null>(null);
  const busy = busyScope === selectionKey;
  const [error, setError] = useState('');
  const resolver = useRef<((allowed: boolean) => void) | null>(null);
  const epoch = useRef(0);
  const lock = useRef(false);
  const decisionPending = useRef(false);
  const cancel = useCallback(() => {
    epoch.current += 1;
    resolver.current?.(false);
    resolver.current = null;
    setPending(null);
    setBusyScope(null);
    decisionPending.current = false;
  }, []);
  useEffect(() => {
    epoch.current += 1;
    decisionPending.current = false;
    return () => {
      epoch.current += 1;
      resolver.current?.(false);
      resolver.current = null;
    };
  }, [workspaceId, petId, selectionKey]);

  // The editor keeps its command callbacks while the sharing question changes.
  const ensure = useCallback(
    async (sourceScope: PetPlanSourceScope | null): Promise<boolean> => {
      if (sourceScope === null) return true;
      if (lock.current || resolver.current !== null) return false;
      lock.current = true;
      const activeEpoch = epoch.current;
      setError('');
      try {
        const response = await client.execute(
          petPlans.sharingQuestion(workspaceId, { petId, sourceScope }),
        );
        if (activeEpoch !== epoch.current) return false;
        if (response.question === null) return true;
        const waiting = new Promise<boolean>((resolve) => {
          resolver.current = resolve;
        });
        setPending({
          question: response.question,
          scope: response.question.sourceScope,
          requestId: crypto.randomUUID(),
          selectionKey,
        });
        return await waiting;
      } catch (reason) {
        if (activeEpoch !== epoch.current) return false;
        setError(
          isNixApiError(reason)
            ? reason.message
            : 'The sharing choice could not be checked. Your message is still here.',
        );
        return false;
      } finally {
        lock.current = false;
      }
    },
    [client, workspaceId, petId, selectionKey],
  );

  async function decide(approve: boolean): Promise<void> {
    if (pending?.selectionKey !== selectionKey || busy || decisionPending.current) return;
    const decisionNonce = pending.question.decisionNonce;
    if (decisionNonce == null) {
      if (!approve) {
        setPending(null);
        resolver.current?.(false);
        resolver.current = null;
      }
      return;
    }
    decisionPending.current = true;
    setBusyScope(selectionKey);
    const activeEpoch = epoch.current;
    try {
      const response = await client.execute(
        petPlans.sharingDecision(workspaceId, {
          petId,
          sourceScope: pending.scope,
          scopeDigest: pending.question.scopeDigest,
          recipientRevision: pending.question.recipientRevision,
          decisionNonce,
          approve,
          requestId: pending.requestId,
        }),
      );
      if (activeEpoch !== epoch.current) return;
      if (approve && response.question !== null) {
        let question = response.question;
        if (question.decisionNonce == null && question.recipient.connectionRevision !== 'unknown') {
          const refreshed = await client.execute(
            petPlans.sharingQuestion(workspaceId, {
              petId,
              sourceScope: question.sourceScope,
              forDecision: true,
            }),
          );
          if (activeEpoch !== epoch.current) return;
          if (refreshed.question !== null) question = refreshed.question;
        }
        setPending({
          ...pending,
          scope: question.sourceScope,
          question,
          requestId: crypto.randomUUID(),
        });
        return;
      }
      setPending(null);
      resolver.current?.(approve);
      resolver.current = null;
    } catch (reason) {
      if (activeEpoch !== epoch.current) return;
      setError(
        isNixApiError(reason)
          ? reason.message
          : 'The sharing choice could not be confirmed. No message was sent.',
      );
      resolver.current?.(false);
      resolver.current = null;
      setPending(null);
    } finally {
      if (activeEpoch === epoch.current) {
        decisionPending.current = false;
        setBusyScope(null);
      }
    }
  }

  return {
    ensure,
    cancel,
    panel: (
      <>
        {pending?.selectionKey !== selectionKey ? null : (
          <PetSharingQuestion
            question={pending.question}
            busy={busy}
            onDecision={(approve) => void decide(approve)}
          />
        )}
        {error ? (
          <div className="flex flex-wrap items-center gap-2">
            <Text role="alert" variant="note">
              {error}
            </Text>
            <Button
              variant="ghost"
              onClick={() => {
                setError('');
              }}
            >
              Dismiss
            </Button>
          </div>
        ) : null}
      </>
    ),
  };
}
