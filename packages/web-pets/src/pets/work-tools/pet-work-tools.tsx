import { pets, type PetConnection, type PetToolCall, type NixClient } from '@nix/api-client';
import {
  READ_ONLY_OPERATIONS,
  WorkspaceToolRefusal,
  workspaceToolSchema,
} from '@nix/companion/tool-args';
import type { StructureFingerprint } from '@nix/companion';
import { Text } from '@nix/ui';
import { memo, useEffect, useRef, useState, type ComponentProps, type ReactElement } from 'react';
import { readActionReceipt, writeActionReceipt } from '../action-receipts';
import { writeMayRunWithoutAsking } from '../approval/write-gate';
import type { EditedRequest } from '../approval/edit-request';
import { readReadWithoutAsking } from '@nix/web-foundation/lib/device-preferences';
import { createFileReader } from '../pet-file-reader';
import {
  APPLYING_WITHOUT_ASKING,
  DECLINED_BY_USER,
  DONE_WITHOUT_ASKING,
  NOT_RUN,
  WITHOUT_ASKING_SUFFIX,
  buildOutcome,
  type BuildLedger,
} from './receipts';
import { afterWrite } from '../approval/prepare-write';
import { PetWorkToolCard } from './tool-card';

function PetWorkToolsView({
  runtime,
  workspaceId,
  petId,
  petName = 'your pet',
  onChange,
  onNeedsDecisionChange,
  applyWithoutAsking = false,
  applyExemptToolIds = [],
  client,
  noteScope,
}: {
  readonly noteScope?: { readonly rootItemId: string; readonly readOnly: boolean } | undefined;
  readonly runtime: PetConnection;
  readonly workspaceId: string;
  readonly petId: string;
  readonly petName?: string;
  readonly onChange: (value: PetConnection) => void;
  /** Reports the ids of the pending tools that are waiting on the owner - never a read that runs
   * without asking, nor one already decided - so the header, avatar and launcher only say
   * "needs approval" when that is true. Called whenever the set changes. */
  readonly onNeedsDecisionChange?: (toolIds: readonly string[]) => void;
  /** Lane F (docs/plans/pet-tool-use-plan.md): the owner's per-conversation switch to run clean
   * writes without a click. Only `canApplyWithoutAsking` writes whose preview loaded with no
   * problems run on their own; a preview that failed, or a write with problems, still waits. */
  readonly applyWithoutAsking?: boolean;
  /** Writes that were already waiting on screen when the switch was turned on. The switch only
   * covers what arrives after it: one tap on a ghost button must not approve a card the owner
   * was in the middle of reading. */
  readonly applyExemptToolIds?: readonly string[];
  readonly client: NixClient;
}): ReactElement {
  const lock = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [decisions, setDecisions] = useState<Record<string, string>>({});
  const [progress, setProgress] = useState<Record<string, string>>({});
  const [buildLedger, setBuildLedger] = useState<BuildLedger | undefined>(undefined);
  const [readWithoutAsking, setReadWithoutAsking] = useState(() => readReadWithoutAsking());
  // Whether a pending write's own preview has problems, reported by each `PetWorkToolCard` once
  // its preview loads. A write with problems is auto-declined (see `hasProblems` below) rather
  // than shown to the owner, so it must never count towards `needsDecision` either.
  const [hasProblems, setHasProblems] = useState<Record<string, boolean>>({});
  // Whether a pending write's preview failed to load, reported by its card. Such a write can
  // never run on its own under `applyWithoutAsking`, so it counts towards `needsDecision`.
  const [previewFailed, setPreviewFailed] = useState<Record<string, boolean>>({});
  // The owner's sentence for an approved write refused before it changed anything. Kept in
  // memory only: receipts in session storage hold outcomes, never document text.
  const [ownerReasons, setOwnerReasons] = useState<Record<string, string>>({});

  useEffect(() => {
    const changed = () => {
      setReadWithoutAsking(readReadWithoutAsking());
    };
    window.addEventListener('nix-pet-device-changed', changed);
    return () => {
      window.removeEventListener('nix-pet-device-changed', changed);
    };
  }, []);

  function decisionKey(tool: PetToolCall) {
    return `tool:${workspaceId}:${petId}${noteScope ? `:note:${noteScope.rootItemId}` : ''}:${tool.id}`;
  }
  function appliesWithoutAsking(tool: PetToolCall) {
    return applyWithoutAsking && !applyExemptToolIds.includes(tool.id);
  }

  // The pet's reads carry the owner's unlocks, so once any read in this conversation returned
  // content from under a lock, no write applies without asking: injected text could otherwise
  // copy what was read out to somewhere unlocked, in this turn or any later one, since the
  // model's thread keeps the result. The worker holds the mark for the thread's whole life, so
  // every tab and every later turn sees the same answer.
  const conversationReadLockedContent = runtime.lockedRead;

  const needsDecision = (runtime.tools ?? [])
    .filter((tool) => {
      if (tool.status !== 'pending') return false;
      const key = decisionKey(tool);
      if (decisions[key] || readActionReceipt(key)) return false;
      if (hasProblems[tool.id]) return false;
      let parsed: ReturnType<typeof workspaceToolSchema.safeParse>;
      try {
        parsed = workspaceToolSchema.safeParse(JSON.parse(tool.arguments));
      } catch {
        return true;
      }
      if (!parsed.success) return true;
      if (READ_ONLY_OPERATIONS.has(parsed.data.operation) && readWithoutAsking) return false;
      return !(
        appliesWithoutAsking(tool) &&
        writeMayRunWithoutAsking(parsed.data) &&
        !previewFailed[tool.id] &&
        !conversationReadLockedContent
      );
    })
    .map((tool) => tool.id);
  const needsDecisionKey = needsDecision.join(',');
  useEffect(() => {
    onNeedsDecisionChange?.(needsDecisionKey ? needsDecisionKey.split(',') : []);
  }, [needsDecisionKey, onNeedsDecisionChange]);

  // The claim/fence/ledger contract below is security-relevant and must stay behaviourally
  // identical to how it always ran: claim on the server before any write, one approval executes
  // at most once, a fence guards every structure write, and a build ledger resumes a blueprint
  // build exactly where it left off. Only which component calls it, and how its outcome is
  // presented, may change around it.
  // Returns whether this call actually started the decision (security fix S3): a call that
  // returns early because the lock is already held, or the tool is no longer pending, returns
  // false without doing anything. `ReadActivityRow` only remembers a tool as "already auto-run"
  // once this returns true, so a second auto-run read that arrived while the first was still in
  // flight is retried once the first finishes, instead of being silently stalled forever.
  async function resolve(
    tool: PetToolCall,
    approved: boolean,
    fence?: StructureFingerprint,
    refusalResult?: string,
    reportProgress?: (completed: number, total: number) => void,
    withoutAsking = false,
    refusalQuotesLockedContent = false,
    edited?: EditedRequest,
  ): Promise<boolean> {
    const key = decisionKey(tool);
    if (lock.current || tool.status !== 'pending' || decisions[key] || readActionReceipt(key))
      return false;
    lock.current = true;
    // An auto-run never says the owner approved anything: its receipt names the switch from
    // the first moment, the way `readStatusText` guards an auto-run read.
    const submitted = withoutAsking
      ? APPLYING_WITHOUT_ASKING
      : approved
        ? 'Approval submitted. Waiting for confirmation.'
        : 'Declined. Waiting for confirmation.';
    // A stale poll or reopening the panel must not ask for the same decision again.
    // This receipt only hides repeat prompts; the worker claim still gates execution.
    writeActionReceipt(key, submitted);
    setDecisions((old) => ({ ...old, [key]: submitted }));
    setBusy(true);
    setError('');
    const requestId = crypto.randomUUID();
    const signal = AbortSignal.timeout(90000);
    try {
      // Claim on the server BEFORE any write. A lost claim response must never lead to execution.
      let claimed: PetConnection;
      try {
        claimed = await client.execute(
          pets.runtime({
            operation: 'tool_claim',
            workspaceId,
            petId,
            ...(noteScope ? { rootItemId: noteScope.rootItemId } : {}),
            toolId: tool.id,
            requestId,
          }),
          { signal },
        );
        const receipt = claimed.tools?.find((value) => value.id === tool.id);
        if (receipt?.status !== 'claimed' || receipt.claimId !== requestId)
          throw new Error('Tool was claimed elsewhere.');
      } catch (cause) {
        // Another tab or a CLI executor can settle the tool after this panel saw it pending.
        // Reconcile the exact tool once; observing a claim never gives this caller its ownership.
        const observed = await client.execute(
          pets.runtime({
            operation: 'read',
            workspaceId,
            petId,
            ...(noteScope ? { rootItemId: noteScope.rootItemId } : {}),
          }),
          { signal },
        );
        const receipt = observed.tools?.find((value) => value.id === tool.id);
        const foreignClaim =
          receipt?.status === 'claimed' && receipt.claimId !== '' && receipt.claimId !== requestId;
        const terminal =
          receipt?.status === 'completed' ||
          receipt?.status === 'failed' ||
          receipt?.status === 'interrupted';
        if (!foreignClaim && !terminal) throw cause;
        onChange(observed);
        const outcome = foreignClaim ? 'Running in another session.' : 'Already settled.';
        writeActionReceipt(key, outcome);
        setDecisions((old) => ({ ...old, [key]: outcome }));
        return true;
      }
      onChange(claimed);
      let toolResult = refusalResult ?? DECLINED_BY_USER;
      let toolSuccess = false;
      let toolImage: string | undefined;
      let notRun: string | undefined;
      // A declined result (its problems) can quote a locked note just as a read can.
      let toolLockedContent = refusalQuotesLockedContent;
      if (approved) {
        try {
          const { runWorkspaceTool, createCompanionBodies, defaultClock, defaultIds } =
            await import('@nix/companion');
          const args = workspaceToolSchema.parse(JSON.parse(edited?.arguments ?? tool.arguments));
          const ledger = args.operation === 'save_as_template' ? buildLedger : undefined;
          const outcome = await runWorkspaceTool(
            {
              core: client,
              collab: client,
              bodies: createCompanionBodies(client),
              clock: defaultClock(),
              ids: defaultIds(),
              files: createFileReader(client),
            },
            workspaceId,
            edited?.arguments ?? tool.arguments,
            signal,
            {
              ...(noteScope ? { scope: noteScope } : {}),
              toolId: tool.id,
              claimId: requestId,
              ...(fence === undefined ? {} : { fence }),
              ...(ledger === undefined ? {} : { buildLedger: ledger }),
              ...(reportProgress === undefined ? {} : { onProgress: reportProgress }),
            },
          );
          // An owner's edit is what ran, so the pet hears it before the result.
          toolResult = outcome.text;
          toolImage = outcome.image;
          toolSuccess = true;
          toolLockedContent = outcome.lockedContent;
          if (args.operation === 'build_blueprint') {
            const build = buildOutcome(outcome.text);
            if (build?.complete) setBuildLedger(build.ledger);
          }
          afterWrite(client, workspaceId, args, outcome);
        } catch (reason) {
          toolResult =
            reason instanceof WorkspaceToolRefusal
              ? reason.message
              : 'The operation failed or its result is uncertain. Inspect Nix before retrying a write. Do not assume success.';
          // A refusal that says so in the owner's words changed nothing: it is "not run", not
          // "didn't finish", and the owner reads their sentence rather than the model's.
          if (reason instanceof WorkspaceToolRefusal && reason.ownerMessage)
            notRun = reason.ownerMessage;
          if (reason instanceof WorkspaceToolRefusal) toolLockedContent = reason.lockedContent;
        }
      }
      // An owner's edit is what ran - or what failed - so the pet hears it with every outcome.
      if (approved && edited) toolResult = `${edited.note}\n${toolResult}`;
      const result = await client.execute(
        pets.runtime({
          operation: 'tool_result',
          workspaceId,
          petId,
          ...(noteScope ? { rootItemId: noteScope.rootItemId } : {}),
          toolId: tool.id,
          requestId,
          toolResult,
          toolSuccess,
          toolLockedContent,
          ...(toolImage === undefined ? {} : { toolImage }),
        }),
        { signal },
      );
      onChange(result);
      if (approved && toolSuccess) {
        const args = workspaceToolSchema.parse(JSON.parse(edited?.arguments ?? tool.arguments));
        const build = args.operation === 'build_blueprint' ? buildOutcome(toolResult) : undefined;
        const completed = build?.ledger.filter((entry) => entry.status === 'done').length;
        const outcome =
          build === undefined
            ? args.operation === 'save_as_template'
              ? 'Template saved.'
              : 'Completed.'
            : build.complete
              ? `Built ${String(completed)} of ${String(build.ledger.length)}.`
              : `Stopped after ${String(completed)} of ${String(build.ledger.length)}.`;
        const receipt = !withoutAsking
          ? outcome
          : outcome === 'Completed.'
            ? DONE_WITHOUT_ASKING
            : outcome + WITHOUT_ASKING_SUFFIX;
        writeActionReceipt(key, receipt);
        setDecisions((old) => ({ ...old, [key]: receipt }));
      } else if (approved && notRun !== undefined) {
        const reason = notRun;
        writeActionReceipt(key, NOT_RUN);
        setDecisions((old) => ({ ...old, [key]: NOT_RUN }));
        setOwnerReasons((old) => ({ ...old, [tool.id]: reason }));
      } else if (!approved) {
        // Mirrors the approved branch above: once the `tool_result` POST for a decline - a
        // plain user decline, or an automatic one sent back for a design's problems - has
        // succeeded, its receipt reads "Declined" rather than staying on the submitted message.
        writeActionReceipt(key, 'Declined');
        setDecisions((old) => ({ ...old, [key]: 'Declined' }));
      }
    } catch {
      // UX fix U23: name the recovery, not the failure - reload from the menu, then check the
      // workspace, before asking the pet again.
      setError(
        "We couldn't confirm this change. Reload the conversation from the menu and check your workspace before asking again.",
      );
    } finally {
      lock.current = false;
      setBusy(false);
      setProgress((old) =>
        Object.fromEntries(Object.entries(old).filter(([id]) => id !== tool.id)),
      );
    }
    return true;
  }

  const tools = runtime.tools ?? [];
  // UX fix U16: the section - and its label - only exist when there is something to show.
  if (tools.length === 0) return <></>;

  return (
    <section
      aria-label={`${petName}'s activity`}
      className="flex min-w-0 flex-col gap-1 wrap-anywhere"
    >
      {tools.map((tool) => (
        <PetWorkToolCard
          key={tool.id}
          tool={tool}
          client={client}
          workspaceId={workspaceId}
          noteScope={noteScope}
          petName={petName}
          busy={busy}
          readWithoutAsking={readWithoutAsking}
          applyWithoutAsking={appliesWithoutAsking(tool)}
          followsLockedRead={conversationReadLockedContent}
          progress={progress[tool.id]}
          onBuildProgress={(message) => {
            setProgress((old) => ({ ...old, [tool.id]: message }));
          }}
          onProblemsChange={(problems) => {
            setHasProblems((old) =>
              old[tool.id] === problems ? old : { ...old, [tool.id]: problems },
            );
          }}
          onPreviewFailedChange={(failed) => {
            setPreviewFailed((old) =>
              old[tool.id] === failed ? old : { ...old, [tool.id]: failed },
            );
          }}
          submitted={decisions[decisionKey(tool)] ?? readActionReceipt(decisionKey(tool))}
          ownerReason={ownerReasons[tool.id]}
          onResolve={resolve}
          scrollAnchor={needsDecision[0] === tool.id}
        />
      ))}
      {error ? <Text role="alert">{error}</Text> : null}
    </section>
  );
}

type Props = ComponentProps<typeof PetWorkToolsView>;

/** Library-contract reason for the memo: the watch stream hands the list a fresh `runtime` object
 * up to four times a second, so props are compared by what the cards actually render. Every
 * other prop, including any added later, is compared by identity. */
function sameToolInputs(prev: Props, next: Props): boolean {
  const before = prev.runtime.tools ?? [];
  const after = next.runtime.tools ?? [];
  if (before.length !== after.length || prev.runtime.lockedRead !== next.runtime.lockedRead)
    return false;
  const sameTools = before.every((tool, index) => {
    const other = after[index];
    return (
      tool.id === other?.id &&
      tool.status === other.status &&
      tool.result === other.result &&
      tool.claimId === other.claimId &&
      tool.arguments === other.arguments
    );
  });
  if (!sameTools) return false;
  if ((prev.applyExemptToolIds ?? []).join() !== (next.applyExemptToolIds ?? []).join())
    return false;
  const was = prev as Record<string, unknown>;
  const now = next as Record<string, unknown>;
  return [...new Set([...Object.keys(was), ...Object.keys(now)])].every(
    (key) => key === 'runtime' || key === 'applyExemptToolIds' || Object.is(was[key], now[key]),
  );
}

export const PetWorkTools = memo(PetWorkToolsView, sameToolInputs);
