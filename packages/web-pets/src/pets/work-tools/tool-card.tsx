import { type PetToolCall, type NixClient } from '@nix/api-client';
import {
  READ_ONLY_OPERATIONS,
  WorkspaceToolRefusal,
  workspaceToolSchema,
} from '@nix/companion/tool-args';
import type { Problem } from '@nix/structure-spec';
import { Text, cn, focusRing } from '@nix/ui';
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { Link } from 'react-router';
import { z } from 'zod';
import { touchLink } from '../approval/approval-frame';
import { PetStructurePreview } from '../pet-structure-preview';
import { PetBodyEditPreview } from '../pet-body-edit-preview';
import {
  BODY_EDIT_OPERATIONS,
  HELD_AFTER_LOCKED_READ,
  waitsForOwnerBecause,
  writeMayRunWithoutAsking,
  writeTextItems,
} from '../approval/write-gate';
import { WriteTextSection } from '../approval/write-text';
import { prepareWrite, type PreparedPreview } from '../approval/prepare-write';
import type { EditedRequest } from '../approval/edit-request';
import { ReadActivityRow, WriteReceiptRow, type Resolver } from './activity-rows';
import { IncompleteBuildCleanup } from './incomplete-build';
import { PendingWriteCard } from './pending-write-card';
import {
  DECLINED_FOR_PROBLEMS_PREFIX,
  ranWithoutAsking,
  receiptSentence,
  settledBodyEditHeadline,
} from './receipts';

interface ToolPreviewState {
  loading: boolean;
  arguments?: string;
  prepared?: PreparedPreview;
  error?: string;
}

export function PetWorkToolCard({
  tool,
  client,
  workspaceId,
  petName,
  busy,
  readWithoutAsking,
  applyWithoutAsking,
  progress,
  onBuildProgress,
  onProblemsChange,
  onPreviewFailedChange,
  followsLockedRead,
  submitted,
  ownerReason,
  onResolve,
  noteScope,
  scrollAnchor,
}: {
  readonly scrollAnchor: boolean;
  readonly noteScope?: { readonly rootItemId: string; readonly readOnly: boolean } | undefined;
  readonly tool: PetToolCall;
  readonly ownerReason?: string | undefined;
  readonly client: NixClient;
  readonly workspaceId: string;
  readonly petName: string;
  readonly busy: boolean;
  readonly readWithoutAsking: boolean;
  readonly applyWithoutAsking: boolean;
  readonly progress: string | undefined;
  readonly onBuildProgress: (message: string) => void;
  /** Reports whether this tool's own preview has problems, so the owner-facing `needsDecision`
   * count in `PetWorkTools` never includes a write that is about to be auto-declined. */
  readonly onProblemsChange: (hasProblems: boolean) => void;
  /** Reports whether this write's preview failed to load, so `needsDecision` still counts it
   * while `applyWithoutAsking` is on: nothing runs on its own without a clean preview. Also true
   * once a loaded preview shows a note body edit whose resulting text links to another host,
   * which only the preview can tell (`writeMayRunWithoutAsking` with the model). */
  readonly onPreviewFailedChange: (failed: boolean) => void;
  /** A read earlier in this conversation returned content from under a lock. */
  readonly followsLockedRead: boolean;
  readonly submitted?: string;
  readonly onResolve: Resolver;
}): ReactElement {
  const rootItemId = noteScope?.rootItemId;
  const readOnly = noteScope?.readOnly ?? true;
  const [state, setState] = useState<ToolPreviewState>({ loading: true });
  const autoDeclineKey = useRef('');
  const [decidedByClick, setDecidedByClick] = useState(false);
  // Set only once `onResolve` actually started this write on its own (the S3 pattern
  // `ReadActivityRow` follows). The receipt, not this ref, carries "without asking" into the UI.
  const autoApplyKey = useRef('');
  // The owner's correction of this request, which then is what previews, approves and runs.
  const [edit, setEdit] = useState<EditedRequest | null>(null);
  const [editing, setEditing] = useState(false);
  const effectiveArguments = edit?.arguments ?? tool.arguments;
  let parsed: ReturnType<typeof workspaceToolSchema.safeParse>;
  try {
    parsed = workspaceToolSchema.safeParse(JSON.parse(effectiveArguments));
  } catch {
    parsed = workspaceToolSchema.safeParse(null);
  }
  const args = parsed.success ? parsed.data : undefined;
  const originalArgs = useMemo(() => {
    try {
      const original = workspaceToolSchema.safeParse(JSON.parse(tool.arguments));
      return original.success ? original.data : undefined;
    } catch {
      return undefined;
    }
  }, [tool.arguments]);
  // Reads never write. There is nothing here for the owner to approve after the fact - only
  // whether it ran at all, which `readReadWithoutAsking` governs - so they are never shown as a
  // card, and never load a mutation preview.
  const isReadOp = args !== undefined && READ_ONLY_OPERATIONS.has(args.operation);
  const isBodyEdit = args !== undefined && BODY_EDIT_OPERATIONS.has(args.operation);
  const settledBodyEdit = isBodyEdit && tool.status !== 'pending';

  useEffect(() => {
    const controller = new AbortController();
    let current: ReturnType<typeof workspaceToolSchema.safeParse>;
    try {
      current = workspaceToolSchema.safeParse(JSON.parse(effectiveArguments));
    } catch {
      current = workspaceToolSchema.safeParse(null);
    }
    // Reads never need a mutation preview - they have nothing to approve,
    // only whether they ran - so the preview-only `@nix/companion` chunk is never fetched for
    // them at all.
    // A body edit that already has an outcome is never previewed again: a fresh plan would
    // describe the note as it is now, after the edit, not the text that was approved.
    if (!current.success || READ_ONLY_OPERATIONS.has(current.data.operation) || settledBodyEdit) {
      return () => {
        controller.abort();
      };
    }
    void (async () => {
      try {
        const scope = rootItemId ? { rootItemId, readOnly } : undefined;
        const prepared = await prepareWrite(
          client,
          workspaceId,
          current.data,
          controller.signal,
          scope,
        );
        if (!controller.signal.aborted)
          setState({
            loading: false,
            arguments: effectiveArguments,
            prepared,
          });
      } catch (reason) {
        if (!controller.signal.aborted)
          setState({
            loading: false,
            arguments: effectiveArguments,
            error:
              reason instanceof WorkspaceToolRefusal
                ? reason.message
                : 'The preview could not be loaded. Decline and ask the pet to try again.',
          });
      }
    })();
    return () => {
      controller.abort();
    };
  }, [effectiveArguments, workspaceId, client, settledBodyEdit, rootItemId, readOnly]);

  const currentPreview = state.arguments === effectiveArguments;
  const model = currentPreview ? state.prepared?.model : undefined;
  const problems = model?.problems ?? [];
  const problemResult = `${DECLINED_FOR_PROBLEMS_PREFIX}\n${problems
    .map((problem: Problem) => `${problem.path}: ${problem.modelMessage ?? problem.message}`)
    .join('\n')}`.slice(0, 16000);
  const itemId = args?.itemId && z.uuid().safeParse(args.itemId).success ? args.itemId : undefined;
  const parentId =
    args?.parentId && z.uuid().safeParse(args.parentId).success ? args.parentId : undefined;
  const autoRun = isReadOp && readWithoutAsking;

  // Invalid writes go straight back to the pet: once a structure write's preview proves it has
  // problems, decline it automatically, once per tool id, in both modes, rather than making the
  // owner click through a request that cannot run.
  // An edited request with problems is the owner's to fix or undo; it is never declined for them.
  const hasProblems =
    edit === null && !isReadOp && tool.status === 'pending' && problems.length > 0 && !submitted;
  useEffect(() => {
    onProblemsChange(hasProblems);
  }, [hasProblems, onProblemsChange]);
  useEffect(() => {
    if (!hasProblems || busy || autoDeclineKey.current === tool.id) return;
    // Only remembered once the decline actually started (security fix S3, as for auto-run
    // reads): a decline that lost the lock to another tool is retried once `busy` clears.
    void (async () => {
      const started = await onResolve(
        tool,
        false,
        undefined,
        problemResult,
        undefined,
        false,
        state.prepared?.refusalQuotesLockedContent ?? false,
      );
      if (started) autoDeclineKey.current = tool.id;
    })();
  }, [hasProblems, busy, tool, problemResult, onResolve, state.prepared]);

  // Completing an occurrence of a repeating task cannot be undone, so it never runs unattended.
  const taskOccurrence = currentPreview && (state.prepared?.taskOccurrence ?? false);
  const previewFailed =
    !isReadOp &&
    currentPreview &&
    !state.loading &&
    (Boolean(state.error) ||
      (args !== undefined &&
        model !== undefined &&
        !writeMayRunWithoutAsking(args, model, taskOccurrence)));
  useEffect(() => {
    onPreviewFailedChange(previewFailed);
  }, [previewFailed, onPreviewFailedChange]);

  // Lane F: with the owner's switch on, a clean write runs exactly as a click on "Approve
  // request" would - same fence, same build progress, same single-flight lock in `resolve` -
  // once its preview has loaded with no problems. The gate below mirrors the button's own
  // `disabled` expression so the switch can never run what the button could not.
  const canAutoApply =
    applyWithoutAsking &&
    edit === null &&
    !editing &&
    !isReadOp &&
    args !== undefined &&
    !followsLockedRead &&
    tool.status === 'pending' &&
    !submitted &&
    currentPreview &&
    !state.loading &&
    model !== undefined &&
    writeMayRunWithoutAsking(args, model, taskOccurrence) &&
    problems.length === 0 &&
    !state.error;
  useEffect(() => {
    if (!canAutoApply || busy || autoApplyKey.current === tool.id) return;
    const isBuild = args.operation === 'build_blueprint';
    if (isBuild) onBuildProgress('Building the draft...');
    void (async () => {
      const started = await onResolve(
        tool,
        true,
        state.prepared?.fingerprint,
        undefined,
        isBuild
          ? (completed, total) => {
              onBuildProgress(`Building ${String(completed)} of ${String(total)}...`);
            }
          : undefined,
        true,
      );
      if (started) autoApplyKey.current = tool.id;
    })();
  }, [canAutoApply, busy, tool, args, state.prepared, onResolve, onBuildProgress]);

  const cleanup =
    args?.operation === 'build_blueprint' && tool.result ? (
      <IncompleteBuildCleanup client={client} workspaceId={workspaceId} result={tool.result} />
    ) : null;

  if (isReadOp) {
    return (
      <ReadActivityRow
        tool={tool}
        args={args}
        busy={busy}
        autoRun={autoRun}
        submitted={submitted}
        onResolve={onResolve}
        anchor={scrollAnchor}
      />
    );
  }

  // A write op collapses to a one-line receipt once it has an outcome (a decision, a claim, a
  // problem it is being sent back for), rather than staying a card. The full card below is only
  // for a write still awaiting a first, real decision.
  // A body edit's comparison already shows the whole new block, so its raw replacement text is
  // only listed when there is no comparison to show.
  const textItems = args
    ? writeTextItems(args).filter(
        () => !(model?.bodyEdit && BODY_EDIT_OPERATIONS.has(args.operation)),
      )
    : [];
  // With the switch on, a clean write that waits anyway says why, above the buttons. A read of
  // locked content holds every write, previewed yet or not, so it is said first.
  const waitReason =
    applyWithoutAsking && args !== undefined && tool.status === 'pending' && !submitted
      ? followsLockedRead
        ? HELD_AFTER_LOCKED_READ
        : model !== undefined && problems.length === 0
          ? waitsForOwnerBecause(args, model, taskOccurrence)
          : undefined
      : undefined;
  // An edited request with problems stays a full card: the owner fixes, undoes or declines it
  // there (security review L2), rather than being left on a receipt with no way forward.
  const isCompactWrite =
    args !== undefined &&
    (tool.status !== 'pending' || Boolean(submitted) || (problems.length > 0 && edit === null));
  if (isCompactWrite) {
    // A body edit that ran keeps its comparison whether the owner approved it or the switch
    // did, plus the way back: the note's own history. After the panel is reopened the approved
    // text is gone (receipts never store document text), so only the way back remains.
    const bodyEditDone = isBodyEdit && tool.status === 'completed';
    const restore = bodyEditDone ? (
      <div className="flex flex-wrap items-baseline gap-2">
        <Text variant="note">
          You can restore the earlier text: open the note and choose History from its menu.
        </Text>
        {itemId ? (
          <Link
            className={cn('underline', touchLink, focusRing)}
            to={`/w/${workspaceId}?item=${itemId}`}
          >
            Open the note
          </Link>
        ) : null}
      </div>
    ) : null;
    const applied =
      (ranWithoutAsking(submitted) || bodyEditDone) && model ? (
        <div className="flex flex-col gap-2">
          <PetStructurePreview model={model} captureSummary={false}>
            {model.bodyEdit ? (
              <PetBodyEditPreview
                edit={model.bodyEdit}
                phase={tool.status === 'completed' ? 'applied' : 'pending'}
              />
            ) : null}
          </PetStructurePreview>
          {restore}
          <WriteTextSection items={textItems} />
        </div>
      ) : (
        (restore ?? undefined)
      );
    return (
      <WriteReceiptRow
        applied={applied}
        ownerReason={ownerReason}
        tool={tool}
        headline={
          // A settled body edit never borrows the preview's "I will..." beside its outcome.
          settledBodyEdit
            ? settledBodyEditHeadline(args)
            : receiptSentence(
                model?.headline ?? (state.loading ? 'Preparing a summary…' : 'This change'),
              )
        }
        problems={problems}
        petName={petName}
        submitted={submitted}
        progress={progress}
        cleanup={cleanup}
        focusOnMount={decidedByClick}
      />
    );
  }

  return (
    <PendingWriteCard
      tool={tool}
      submitted={submitted}
      busy={busy}
      workspaceId={workspaceId}
      supported={parsed.success}
      args={args}
      originalArgs={originalArgs}
      model={model}
      previewCurrent={currentPreview}
      previewLoading={state.loading}
      previewError={state.error}
      fingerprint={state.prepared?.fingerprint}
      problemCount={problems.length}
      progress={progress}
      itemId={itemId}
      parentId={parentId}
      textItems={textItems}
      waitReason={waitReason}
      cleanup={cleanup}
      edit={edit}
      editing={editing}
      onEdit={setEdit}
      onEditing={setEditing}
      onBuildProgress={onBuildProgress}
      onResolve={(...decision) => {
        // Only the card's own buttons reach here (auto-runs call `onResolve` directly), so a
        // receipt that follows is one the owner asked for and takes focus - unless the call
        // never started, when a later receipt (settled elsewhere) must not steal focus.
        setDecidedByClick(true);
        const started = onResolve(...decision);
        void started.then((ok) => {
          if (!ok) setDecidedByClick(false);
        });
        return started;
      }}
      anchor={scrollAnchor}
    />
  );
}
