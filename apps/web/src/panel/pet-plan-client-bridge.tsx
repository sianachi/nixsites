import {
  createDirectCollabClient,
  petPlans,
  type NixClient,
  type PetPlanResponse,
} from '@nix/api-client';
import { Text } from '@nix/ui';
import { readActionReceipt, writeActionReceipt } from '@nix/web-pets/pets/action-receipts';
import { useAuth } from '@nix/web-platform/auth/auth-provider';
import { useEffect, useEffectEvent, useRef, useState, type ReactElement } from 'react';

/** Executes only exact I/O prepared by Core after the frozen plan decision. */
export function PetPlanClientBridge({
  client,
  run,
  onUpdate,
}: {
  readonly client: NixClient;
  readonly run: PetPlanResponse;
  readonly onUpdate: (run: PetPlanResponse) => void;
}): ReactElement | null {
  const { getAccessToken } = useAuth();
  const [problem, setProblem] = useState<{
    readonly identity: string;
    readonly message: string;
  } | null>(null);
  const [runnerContextId] = useState(() => crypto.randomUUID());
  const claimIds = useRef(new Map<string, string>());
  const report = useEffectEvent((next: PetPlanResponse) => {
    onUpdate(next);
  });
  const plan = run.plan;
  const identity = `${run.id}:${plan?.id ?? ''}:${String(plan?.version ?? '')}:${plan?.reviewDigest ?? ''}`;
  const next = plan?.steps.find((step) => ['pending', 'claimed', 'applying'].includes(step.status));
  const active = plan?.status === 'approved' && next?.executor === 'client';
  const readCurrent = useEffectEvent(() => ({ run, plan, next }));
  useEffect(() => {
    if (!active) return;
    const { run, plan: currentPlan, next: currentStep } = readCurrent();
    if (currentPlan == null || currentStep === undefined) return;
    const plan = currentPlan;
    const next = currentStep;
    const controller = new AbortController();
    const stopped = () => controller.signal.aborted;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let claimed = next.status !== 'pending';
    async function tick(): Promise<void> {
      try {
        if (!claimed) {
          const claimKey = `${run.id}:${plan.id}:${String(plan.version)}:${next.id}`;
          let requestId = claimIds.current.get(claimKey);
          if (requestId === undefined) {
            requestId = crypto.randomUUID();
            claimIds.current.set(claimKey, requestId);
          }
          const claim = await client.execute(
            petPlans.claim(run.workspaceId, run.id, plan.id, next.id, {
              expectedRunRevision: run.revision,
              planVersion: plan.version,
              reviewDigest: plan.reviewDigest,
              requestId,
              runnerContextId,
            }),
            { signal: controller.signal },
          );
          claimed = true;
          if (stopped()) return;
          report(claim.run);
        }
        const intent = await client.query(petPlans.nextClientIntent(run.workspaceId, run.id), {
          signal: controller.signal,
          forceRefresh: true,
        });
        if (stopped()) return;
        if (intent !== null) {
          const receiptKey = `plan-io:${run.workspaceId}:${run.id}:${intent.requestId}`;
          const previous = readActionReceipt(receiptKey);
          if (previous === 'dispatched' || previous === 'uncertain') {
            setProblem({
              identity,
              message:
                'A device request may have started. Nix is waiting for its confirmed result and will not repeat it automatically.',
            });
            return;
          }
          if (previous !== 'recorded') {
            writeActionReceipt(receiptKey, 'dispatched');
            const transport =
              intent.destination === 'core'
                ? client
                : createDirectCollabClient({
                    baseUrl: new URL('/collab', window.location.origin).href,
                    tokens: {
                      getAccessToken: () => getAccessToken(),
                      refreshAccessToken: () => getAccessToken(true),
                    },
                  });
            let response;
            try {
              response = await transport.dispatchPlanIntent(intent, { signal: controller.signal });
            } catch (reason) {
              writeActionReceipt(receiptKey, 'uncertain');
              throw reason;
            }
            const recorded = await client.execute(
              petPlans.recordClientIoResult(run.workspaceId, run.id, response),
            );
            if (!recorded.recorded) {
              writeActionReceipt(receiptKey, 'uncertain');
              throw new Error('The exact request result could not be recorded.');
            }
            writeActionReceipt(receiptKey, 'recorded');
          }
        }
        if (stopped()) return;
        const current = await client.query(petPlans.getRun(run.workspaceId, run.id), {
          signal: controller.signal,
          forceRefresh: true,
        });
        if (stopped()) return;
        report(current);
        timer = setTimeout(() => void tick(), 750);
      } catch {
        if (!stopped())
          setProblem({
            identity,
            message:
              'Device execution paused because its result could not be confirmed. Inspect the plan before requesting more work.',
          });
      }
    }
    void tick();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [
    client,
    identity,
    active,
    run.id,
    run.workspaceId,
    plan?.id,
    plan?.version,
    plan?.reviewDigest,
    next?.id,
    runnerContextId,
    getAccessToken,
  ]);
  return problem?.identity === identity ? (
    <Text role="status" variant="note">
      {problem.message}
    </Text>
  ) : null;
}
