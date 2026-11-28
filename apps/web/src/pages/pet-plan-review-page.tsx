import {
  isNixApiError,
  petPlans,
  type PetPlanDecisionHandoffStatus,
  type PetPlanResponse,
} from '@nix/api-client';
import { Button, Text } from '@nix/ui';
import { ErrorPanel, LoadingPanel } from '@nix/web-foundation/components/states/status-panels';
import { paneScroller } from '@nix/web-foundation/layout/regions';
import { useApiClient } from '@nix/web-platform/api/api-client-provider';
import { useWorkspace } from '@nix/web-workspaces/workspaces/workspace-context';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { z } from 'zod';
import { PetPlanCard } from '../panel/pet-plan-card';
import { PetPlanClientBridge } from '../panel/pet-plan-client-bridge';

interface Loaded {
  readonly run: PetPlanResponse;
  readonly handoff: PetPlanDecisionHandoffStatus | null;
}

function currentHandoff(
  current: PetPlanDecisionHandoffStatus | null,
  next: PetPlanDecisionHandoffStatus,
): PetPlanDecisionHandoffStatus {
  if (current?.handoffId !== next.handoffId) return next;
  if (['consumed', 'revoked', 'expired'].includes(current.status)) return current;
  return current.status === 'authorized' && next.status === 'pending' ? current : next;
}

export function PetPlanReviewPage(): ReactElement {
  const { workspaceId } = useWorkspace();
  const { runId } = useParams();
  const [search] = useSearchParams();
  const handoffId = search.get('handoffId');
  const validRun = z.uuid().safeParse(runId);
  const validHandoff = handoffId === null || z.uuid().safeParse(handoffId).success;
  if (!validRun.success || !validHandoff)
    return (
      <ErrorPanel
        title="This plan link is invalid"
        detail="Open the plan from companion activity or request a fresh link from your client."
      />
    );
  return (
    <PlanReview
      key={`${workspaceId}:${validRun.data}:${handoffId ?? ''}`}
      workspaceId={workspaceId}
      runId={validRun.data}
      handoffId={handoffId}
    />
  );
}

function PlanReview({
  workspaceId,
  runId,
  handoffId,
}: {
  readonly workspaceId: string;
  readonly runId: string;
  readonly handoffId: string | null;
}): ReactElement {
  const client = useApiClient();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState('');
  const [decisionPending, setDecisionPending] = useState(false);
  const decisionLock = useRef(false);
  const declineButton = useRef<HTMLButtonElement>(null);
  const requestStatus = useRef<HTMLDivElement>(null);
  const restoreDeclineFocus = useRef(false);
  const [refreshError, setRefreshError] = useState('');
  const [handoffRefreshError, setHandoffRefreshError] = useState('');
  const [reload, setReload] = useState(0);
  const [checkedAt, setCheckedAt] = useState(Date.now);
  useEffect(() => {
    const moved = (event: FocusEvent) => {
      if (
        restoreDeclineFocus.current &&
        event.target instanceof HTMLElement &&
        event.target !== document.body &&
        event.target !== declineButton.current
      )
        restoreDeclineFocus.current = false;
    };
    document.addEventListener('focusin', moved);
    return () => {
      document.removeEventListener('focusin', moved);
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let watchTimer: ReturnType<typeof setTimeout> | undefined;
    let handoffTimer: ReturnType<typeof setTimeout> | undefined;
    let revision = 0;
    async function watch(): Promise<void> {
      try {
        const run = await client.query(petPlans.watch(workspaceId, runId, revision), {
          signal: controller.signal,
          forceRefresh: true,
        });
        if (controller.signal.aborted) return;
        revision = Math.max(revision, run.revision);
        setCheckedAt(Date.now());
        setLoaded((current) =>
          current === null || current.run.revision > run.revision ? current : { ...current, run },
        );
        setRefreshError('');
      } catch {
        if (controller.signal.aborted) return;
        setRefreshError(
          'Progress could not be refreshed. Your last confirmed plan is still shown.',
        );
      }
      watchTimer = setTimeout(() => void watch(), 500);
    }
    async function pollHandoff(): Promise<void> {
      if (handoffId === null) return;
      try {
        const handoff = await client.query(
          petPlans.getDecisionHandoff(workspaceId, runId, handoffId),
          { signal: controller.signal, forceRefresh: true },
        );
        if (controller.signal.aborted) return;
        setCheckedAt(Date.now());
        setLoaded((current) =>
          current === null
            ? current
            : { ...current, handoff: currentHandoff(current.handoff, handoff) },
        );
        setHandoffRefreshError('');
      } catch {
        if (controller.signal.aborted) return;
        setHandoffRefreshError('The client request status could not be refreshed.');
      }
      handoffTimer = setTimeout(() => void pollHandoff(), 2_000);
    }
    void Promise.all([
      client.query(petPlans.getRun(workspaceId, runId), {
        signal: controller.signal,
        forceRefresh: true,
      }),
      handoffId === null
        ? Promise.resolve(null)
        : client.query(petPlans.getDecisionHandoff(workspaceId, runId, handoffId), {
            signal: controller.signal,
            forceRefresh: true,
          }),
    ])
      .then(([run, handoff]) => {
        if (controller.signal.aborted) return;
        revision = run.revision;
        setLoaded({ run, handoff });
        setRefreshError('');
        setHandoffRefreshError('');
        watchTimer = setTimeout(() => void watch(), 500);
        if (handoffId !== null) handoffTimer = setTimeout(() => void pollHandoff(), 2_000);
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted)
          setError(isNixApiError(reason) ? reason.message : 'The plan could not be loaded.');
      });
    return () => {
      controller.abort();
      clearTimeout(watchTimer);
      clearTimeout(handoffTimer);
    };
  }, [client, workspaceId, runId, handoffId, reload]);
  if (loaded === null)
    return error ? (
      <ErrorPanel
        title="The plan could not be opened"
        detail={error}
        action={
          <Button
            variant="ghost"
            onClick={() => {
              setError('');
              setReload((value) => value + 1);
            }}
          >
            Retry
          </Button>
        }
      />
    ) : (
      <LoadingPanel label="the prepared plan" />
    );
  const { run, handoff } = loaded;
  const matching =
    handoff === null ||
    (handoff.planId === run.plan?.id &&
      handoff.planVersion === run.plan.version &&
      handoff.reviewDigest === run.plan.reviewDigest &&
      handoff.status === 'pending' &&
      Date.parse(handoff.expiresAt) > checkedAt);
  return (
    <div className={`${paneScroller} flex min-w-0 flex-col gap-3 p-3 sm:p-4`}>
      <Text as="h1" variant="h3">
        Review the companion plan
      </Text>
      {handoff === null ? null : (
        <section aria-label="Client decision request" className="flex min-w-0 flex-col gap-2">
          <Text as="h2" variant="h5">
            {handoff.clientName} requests your decision
          </Text>
          <Text>
            Continuing lets this named client {handoff.approve ? 'approve' : 'decline'} the exact
            plan shown below once.
          </Text>
          <div ref={requestStatus} role="status" aria-label="Client request status" tabIndex={-1}>
            <Text variant="note" tone="muted">
              Request status: {handoff.status}. Expires{' '}
              {new Date(handoff.expiresAt).toLocaleString()}.
            </Text>
          </div>
          {handoff.status === 'authorized' ? (
            <Text role="status">
              Your decision is authorized for this client to use once for the reviewed plan.
            </Text>
          ) : handoff.status === 'consumed' ? (
            <Text role="status">This client has used your decision for the reviewed plan.</Text>
          ) : handoff.status === 'revoked' ? (
            <Text role="status">
              This client request was declined. The companion plan is still available.
            </Text>
          ) : !matching ? (
            <Text role="alert">
              This request is no longer current. Ask the client for a fresh link before continuing.
            </Text>
          ) : null}
        </section>
      )}
      <PetPlanCard
        client={client}
        run={run}
        onUpdate={(next) => {
          setLoaded((current) =>
            current === null || current.run.revision > next.revision
              ? current
              : { ...current, run: next },
          );
        }}
        reviewAllowed={matching && !decisionPending && !refreshError && !handoffRefreshError}
        hideCancel={handoff !== null}
        {...(handoff === null
          ? {}
          : {
              onContinue: async (current: PetPlanResponse) => {
                if (decisionLock.current || !matching || current.plan == null)
                  throw new Error('The client request no longer matches this plan.');
                decisionLock.current = true;
                setDecisionPending(true);
                try {
                  const next = await client.execute(
                    petPlans.createDecisionContext(workspaceId, runId, {
                      handoffId: handoff.handoffId,
                      planId: current.plan.id,
                      planVersion: current.plan.version,
                      reviewDigest: current.plan.reviewDigest,
                      granteeCredentialId: handoff.granteeCredentialId,
                      clientName: handoff.clientName,
                      approve: handoff.approve,
                    }),
                  );
                  setLoaded((latest) => ({
                    run: latest?.run ?? current,
                    handoff: currentHandoff(latest?.handoff ?? null, next),
                  }));
                  setError('');
                } finally {
                  decisionLock.current = false;
                  setDecisionPending(false);
                }
              },
            })}
      />
      {run.plan?.status === 'approved' &&
      run.plan.steps.some((step) => step.executor === 'client') ? (
        <PetPlanClientBridge
          client={client}
          run={run}
          onUpdate={(next) => {
            setLoaded((current) =>
              current === null || current.run.revision > next.revision
                ? current
                : { ...current, run: next },
            );
          }}
        />
      ) : null}
      {handoff?.status === 'pending' ? (
        <div>
          <Button
            ref={declineButton}
            variant="ghost"
            disabled={decisionPending}
            onClick={(event) => {
              if (decisionLock.current) return;
              restoreDeclineFocus.current = event.currentTarget.contains(document.activeElement);
              decisionLock.current = true;
              setDecisionPending(true);
              void client
                .execute(petPlans.revokeHandoff(workspaceId, runId, handoff.handoffId))
                .then((next) => {
                  setLoaded((latest) => ({
                    run: latest?.run ?? run,
                    handoff: currentHandoff(latest?.handoff ?? null, next),
                  }));
                  setError('');
                })
                .catch(() => {
                  setError(
                    'The refusal could not be confirmed. Check the request before trying again.',
                  );
                })
                .finally(() => {
                  decisionLock.current = false;
                  setDecisionPending(false);
                  if (restoreDeclineFocus.current) {
                    restoreDeclineFocus.current = false;
                    requestStatus.current?.focus();
                  }
                });
            }}
          >
            {decisionPending ? 'Saving decision…' : 'Decline client request'}
          </Button>
        </div>
      ) : null}
      {refreshError || handoffRefreshError ? (
        <div className="flex flex-wrap gap-2">
          <Text role="status">{handoffRefreshError || refreshError}</Text>
          <Button
            variant="ghost"
            onClick={() => {
              setReload((value) => value + 1);
            }}
          >
            Refresh progress
          </Button>
        </div>
      ) : null}
      {error ? <Text role="alert">{error}</Text> : null}
    </div>
  );
}
