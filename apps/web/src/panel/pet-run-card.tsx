import {
  isNixApiError,
  petRuns,
  type CommandEndpoint,
  type NixClient,
  type PetRunProposal,
  type PetRunResponse,
} from '@nix/api-client';
import {
  MAX_SHEET_EDITS,
  SHEET_COLUMN_WIDTH,
  SHEET_LIMITS,
  type SheetEditChange,
} from '@nix/sheet';
import {
  Button,
  Field,
  ScrollRegion,
  Table,
  Text,
  Textarea,
  Toast,
  focusRing,
  type TableColumn,
} from '@nix/ui';
import { itemLink } from '@nix/web-foundation/lib/item-link';
import { ApprovalActions, ApprovalFrame } from '@nix/web-pets/pets/approval/approval-frame';
import { useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { z } from 'zod';
import { BrowserContinuation, useBrowserContinuations } from './pet-browser-continuation';
import { PetCanvasDecision, usePetCanvasReview } from './pet-canvas-review';
import { parseCanvasReview } from './pet-canvas-review-scene';

const revisionSchema = z.object({ headSeq: z.union([z.int().nonnegative(), z.string()]) });
const sheetSchema = z.object({
  kind: z.literal('sheet'),
  preview: z.object({ changes: z.array(z.json()), revision: revisionSchema.optional() }),
});
const cellValue = z.string().min(1).max(SHEET_LIMITS.maxRawLength).nullable();
const extent = z.int().min(1).max(SHEET_LIMITS.maxRows).nullable();
const width = z.int().min(SHEET_COLUMN_WIDTH.min).max(SHEET_COLUMN_WIDTH.max).nullable();
const sheetChange = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('cell'),
    cell: z.string().regex(/^[A-Z]{1,2}[1-9][0-9]{0,4}$/u),
    before: cellValue,
    after: cellValue,
  }),
  z.strictObject({
    kind: z.literal('extent'),
    axis: z.enum(['rows', 'cols']),
    before: extent,
    after: extent,
  }),
  z.strictObject({
    kind: z.literal('width'),
    column: z.string().regex(/^[A-Z]{1,2}$/u),
    before: width,
    after: width,
  }),
]) satisfies z.ZodType<SheetEditChange>;
const sheetChanges = z.array(sheetChange).min(1).max(MAX_SHEET_EDITS);

const renameSchema = z.object({ from: z.string(), to: z.string() });
const commentSchema = z.object({ title: z.string(), audience: z.string(), body: z.string() });
const legacyCommentSchema = z.object({ text: z.string() });
const browserVisitSchema = z
  .strictObject({
    url: z.url({ protocol: /^https?$/u }),
    connectionId: z.uuid().nullish(),
    connectionRevision: z.uuid().nullish(),
  })
  .refine(
    ({ connectionId, connectionRevision }) =>
      (connectionId == null) === (connectionRevision == null),
  );
const appendOperation = z.literal('AppendItemBody');
const appendNoteSchema = z
  .object({
    operationId: appendOperation,
    method: z.literal('POST'),
    target: z.string(),
    inputs: z.strictObject({
      operationId: appendOperation,
      path: z.strictObject({ itemId: z.uuid() }),
      query: z.strictObject({}).optional(),
      body: z.strictObject({ markdown: z.string().refine((text) => text.trim().length > 0) }),
    }),
  })
  .refine(({ target, inputs }) => target === `/api/v1/items/${inputs.path.itemId}/body`)
  .transform(({ inputs }) => ({ itemId: inputs.path.itemId, markdown: inputs.body.markdown }));

const statusText: Record<PetRunResponse['status'], string> = {
  queued: 'Queued',
  running: 'Working',
  waiting_for_input: 'Waiting for your answer',
  waiting_for_approval: 'Waiting for approval',
  waiting_for_handoff: 'Waiting for handoff',
  review_required: 'An action needs review',
  completed: 'Completed',
  failed: 'Job failed',
  cancelled: 'Cancelled',
};

const proposalStatusText: Record<string, string> = {
  pending: 'Awaiting approval',
  approved: 'Approved',
  declined: 'Declined',
  superseded: 'Draft replaced',
  stale: 'Target changed',
  applying: 'Applying…',
  applied: 'Applied',
  refused: 'Could not apply',
  unknown: 'Outcome needs review',
  undo_pending: 'Undoing…',
  undo_refused: 'Could not undo',
  undone: 'Undone',
};

const failureHeadings: Record<NonNullable<PetRunResponse['failure']>['stage'], string> = {
  planning: 'Planning stopped',
  preview: 'Draft could not be prepared',
  apply: 'Change could not be applied',
};

export function petRunStatusText(status: PetRunResponse['status']): string {
  return statusText[status];
}

export function PetRunCard({
  client,
  run,
  onUpdate,
  activeDecisionId,
  renderScopeQuestion,
  hideBrief = false,
}: {
  readonly client: NixClient;
  readonly run: PetRunResponse;
  readonly onUpdate: (run: PetRunResponse) => void;
  readonly activeDecisionId?: string | null | undefined;
  readonly renderScopeQuestion?:
    ((question: NonNullable<PetRunResponse['question']>) => ReactNode) | undefined;
  readonly hideBrief?: boolean;
}): ReactElement {
  const resultHeading = useRef<HTMLDivElement>(null);
  const actionInFlight = useRef(false);
  const activeDecision = useRef<HTMLElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [canvasApprovalId, setCanvasApprovalId] = useState<string | null>(null);
  const continuations = useBrowserContinuations(client, run);
  const canUndo =
    run.status === 'completed' || run.status === 'cancelled' || run.status === 'failed';
  const canCancel = !canUndo && run.status !== 'review_required';
  const appliedDrawing = canUndo
    ? run.results.find((result) => result.id === canvasApprovalId && result.reversible)
    : undefined;

  const dismissCanvasNotice = useCallback(() => {
    setCanvasApprovalId(null);
  }, []);

  useEffect(() => {
    if (activeDecisionId == null) return;
    activeDecision.current?.focus();
  }, [activeDecisionId]);

  async function apply(key: string, command: CommandEndpoint<PetRunResponse>): Promise<void> {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    setBusy(key);
    setError(null);
    try {
      onUpdate(await client.execute(command));
      resultHeading.current?.focus();
    } catch (error) {
      if (isNixApiError(error) && error.status === 409) {
        try {
          onUpdate(await client.query(petRuns.getRun(run.itemId, run.id), { forceRefresh: true }));
        } catch {
          // Keep the original decision error if the job is no longer readable.
        }
      }
      setError(
        isNixApiError(error)
          ? error.message
          : 'This request could not be confirmed. Check the job before trying again.',
      );
    } finally {
      actionInFlight.current = false;
      setBusy(null);
    }
  }

  return (
    <article className="flex min-w-0 flex-col gap-2">
      {hideBrief ? null : (
        <Text variant="bodySmall" className="wrap-anywhere whitespace-pre-wrap">
          {run.brief}
        </Text>
      )}
      <div ref={resultHeading} tabIndex={-1}>
        <Text variant="note" role="status" className={hideBrief ? 'sr-only' : ''}>
          {petRunStatusText(run.status)}
        </Text>
      </div>
      {run.status === 'review_required' ? (
        <Text variant="note" tone="muted">
          Nix could not confirm what happened. Check the destination before trying this action
          again.
        </Text>
      ) : null}
      {run.status === 'failed' && run.failure != null ? (
        <section aria-label="Job failure" className="flex min-w-0 flex-col gap-1">
          <Text as="h3" variant="h5">
            {failureHeadings[run.failure.stage]}
          </Text>
          <Text variant="bodySmall" className="wrap-anywhere whitespace-pre-wrap">
            {run.failure.message}
          </Text>
        </section>
      ) : null}
      {error !== null ? (
        <Text variant="note" role="alert">
          {error}
        </Text>
      ) : null}
      {run.status === 'waiting_for_input' && run.question != null ? (
        <section
          ref={activeDecisionId === run.question.id ? activeDecision : undefined}
          tabIndex={-1}
          aria-label="Pet question"
          key={run.question.id}
        >
          {run.question.scope == null ? (
            <RunQuestion
              question={run.question}
              busy={busy !== null}
              answer={(questionId, text) =>
                apply(questionId, petRuns.answer(run.itemId, run.id, questionId, text))
              }
            />
          ) : (
            (renderScopeQuestion?.(run.question) ?? (
              <Text variant="bodySmall">{run.question.text}</Text>
            ))
          )}
        </section>
      ) : null}
      {run.proposals.map((proposal) => {
        const waiting = run.status === 'waiting_for_approval';
        const canDecide = waiting && proposal.status === 'pending';
        const stale = waiting && proposal.status === 'stale';
        const appendNote =
          proposal.capability === 'nix.action'
            ? appendNoteSchema.safeParse(proposal.preview).data
            : undefined;
        const heading = appendNote === undefined ? proposal.description : 'Add to end of note';
        const preview =
          appendNote === undefined ? (
            <ProposalPreview proposal={proposal} />
          ) : (
            <AppendNotePreview workspaceId={run.workspaceId} {...appendNote} />
          );
        const approve = () =>
          apply(proposal.id, petRuns.decide(run.itemId, run.id, proposal.id, true));
        const decline = () =>
          void apply(proposal.id, petRuns.decide(run.itemId, run.id, proposal.id, false));
        const revise = (feedback?: string) =>
          void apply(proposal.id, petRuns.revise(run.itemId, run.id, proposal.id, feedback));
        return (
          <section
            key={proposal.id}
            ref={activeDecisionId === proposal.id ? activeDecision : undefined}
            tabIndex={-1}
            aria-label={heading}
            className="flex min-w-0 flex-col gap-2"
          >
            {proposal.capability === 'canvas.edit' && (canDecide || stale) ? (
              <DrawingProposal
                proposal={proposal}
                stale={stale}
                busy={busy !== null}
                error={error}
                openOnMount={activeDecisionId === proposal.id}
                onApprove={() => {
                  setCanvasApprovalId(proposal.id);
                  return approve();
                }}
                onDecline={decline}
                onRevise={revise}
              />
            ) : canDecide ? (
              <ApprovalFrame
                heading={heading}
                actions={(headingId) => (
                  <ApprovalActions
                    headingId={headingId}
                    approveLabel={
                      appendNote === undefined ? approvalLabel(proposal.capability) : 'Add to note'
                    }
                    approveDisabled={false}
                    busy={busy !== null}
                    onApprove={() => void approve()}
                    onDecline={decline}
                    onRequestChanges={revise}
                  />
                )}
              >
                {preview}
              </ApprovalFrame>
            ) : stale ? (
              <ApprovalFrame
                heading={heading}
                actions={(headingId) => (
                  <div>
                    <Button
                      type="button"
                      aria-describedby={headingId}
                      disabled={busy !== null}
                      onClick={() => {
                        revise();
                      }}
                    >
                      Refresh draft
                    </Button>
                  </div>
                )}
              >
                <Text variant="note" tone="muted">
                  The target changed. Refresh the draft to review it again.
                </Text>
              </ApprovalFrame>
            ) : (
              <>
                <Text variant="bodySmall" className="wrap-anywhere">
                  {heading}
                </Text>
                <Text variant="note" tone="muted">
                  {proposalStatusText[proposal.status] ?? proposal.status}
                </Text>
                {proposal.status === 'unknown' ? preview : null}
              </>
            )}
            <BrowserContinuation
              step={continuations.find((step) => step.proposalId === proposal.id)}
            />
          </section>
        );
      })}
      {appliedDrawing === undefined ? null : (
        <Toast
          message="Drawing applied."
          action={{
            label: 'Undo',
            onAction: () => {
              void apply(appliedDrawing.id, petRuns.undo(run.itemId, run.id, appliedDrawing.id));
            },
          }}
          onDismiss={dismissCanvasNotice}
          // eslint-disable-next-line jsx-a11y/no-autofocus -- This disables Toast's mount focus.
          autoFocus={false}
        />
      )}
      {run.results.length > 0 ? (
        <ul aria-label="Job results" className="flex min-w-0 flex-col gap-2">
          {run.results.map((result) => (
            <li key={result.id} className="flex flex-wrap items-center justify-between gap-2">
              <Text variant="note" className="wrap-anywhere whitespace-pre-wrap">
                {result.text}
              </Text>
              {result.reversible && canUndo && result.id !== appliedDrawing?.id ? (
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy !== null}
                  onClick={() => void apply(result.id, petRuns.undo(run.itemId, run.id, result.id))}
                >
                  {busy === result.id ? 'Undoing…' : 'Undo'}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {run.status === 'failed' ? (
        <div>
          <Button
            type="button"
            variant="secondary"
            disabled={busy !== null}
            onClick={() => void apply('retry', petRuns.retry(run.itemId, run.id))}
          >
            {busy === 'retry' ? 'Retrying…' : 'Retry job'}
          </Button>
        </div>
      ) : canCancel ? (
        <div>
          <Button
            type="button"
            variant="ghost"
            disabled={busy !== null}
            onClick={() => void apply('cancel', petRuns.cancel(run.itemId, run.id))}
          >
            {busy === 'cancel' ? 'Cancelling…' : 'Cancel job'}
          </Button>
        </div>
      ) : null}
    </article>
  );
}

function DrawingProposal({
  proposal,
  stale,
  busy,
  error,
  openOnMount,
  onApprove,
  onDecline,
  onRevise,
}: {
  readonly proposal: PetRunProposal;
  readonly stale: boolean;
  readonly busy: boolean;
  readonly error: string | null;
  readonly openOnMount: boolean;
  readonly onApprove: () => Promise<void>;
  readonly onDecline: () => void;
  readonly onRevise: (feedback?: string) => void;
}): ReactElement {
  const layout = usePetCanvasReview();
  const select = layout?.select;
  const open = layout?.activeId === proposal.id;
  const reviewButton = useRef<HTMLButtonElement>(null);
  const requestConsumed = useRef(false);
  const previouslyOpen = useRef(false);
  const draft = parseCanvasReview(proposal.preview);
  const canOpen = draft !== null && select !== undefined;

  useEffect(() => {
    if (!openOnMount || requestConsumed.current || !canOpen) return;
    requestConsumed.current = true;
    select(proposal.id);
  }, [openOnMount, canOpen, proposal.id, select]);

  useEffect(
    () => () => {
      requestConsumed.current = false;
      select?.((current) => (current === proposal.id ? null : current));
    },
    [proposal.id, select],
  );

  useEffect(() => {
    if (previouslyOpen.current && layout?.activeId === null) reviewButton.current?.focus();
    previouslyOpen.current = open;
  }, [layout?.activeId, open]);

  return (
    <>
      <ApprovalFrame
        heading={proposal.description}
        actions={(headingId) =>
          canOpen ? (
            <Button
              ref={reviewButton}
              type="button"
              variant="secondary"
              aria-describedby={headingId}
              aria-expanded={open}
              disabled={busy}
              onClick={() => {
                select(proposal.id);
              }}
            >
              Review drawing
            </Button>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                disabled={busy}
                onClick={() => {
                  onRevise();
                }}
              >
                Refresh draft
              </Button>
              {stale ? null : (
                <Button type="button" variant="ghost" disabled={busy} onClick={onDecline}>
                  Decline request
                </Button>
              )}
            </div>
          )
        }
      >
        {canOpen && !stale ? null : (
          <Text variant="note" tone="muted">
            {stale ? 'The canvas changed.' : 'This draft could not be opened for review.'}
          </Text>
        )}
      </ApprovalFrame>
      {open && draft !== null && layout.pane
        ? createPortal(
            <PetCanvasDecision
              key={proposal.id}
              draft={draft}
              heading={proposal.description}
              stale={stale}
              busy={busy}
              error={error}
              onApprove={onApprove}
              onDecline={onDecline}
              onRequestChanges={onRevise}
              onRefresh={() => {
                onRevise();
              }}
            />,
            layout.pane,
          )
        : null}
    </>
  );
}

function RunQuestion({
  question,
  busy,
  answer,
}: {
  readonly question: { readonly id: string; readonly text: string };
  readonly busy: boolean;
  readonly answer: (questionId: string, text: string) => Promise<void>;
}): ReactElement {
  const [text, setText] = useState('');
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy && text.trim().length > 0) void answer(question.id, text.trim());
      }}
    >
      <Field label={question.text}>
        {(control) => (
          <Textarea
            {...control}
            rows={2}
            value={text}
            disabled={busy}
            maxLength={2000}
            required
            onChange={(event) => {
              setText(event.target.value);
            }}
          />
        )}
      </Field>
      <div>
        <Button type="submit" disabled={busy || text.trim().length === 0}>
          Answer
        </Button>
      </div>
    </form>
  );
}

function approvalLabel(capability: string): string {
  switch (capability) {
    case 'task.rename':
      return 'Rename task';
    case 'task.comment':
    case 'comment.create':
      return 'Post comment';
    case 'sheet.edit':
      return 'Apply sheet changes';
    case 'browser.browse':
      return 'Open web page';
    case 'browser.submitForm':
      return 'Submit form';
    default:
      return 'Approve request';
  }
}

function AppendNotePreview({
  workspaceId,
  itemId,
  markdown,
}: {
  readonly workspaceId: string;
  readonly itemId: string;
  readonly markdown: string;
}): ReactElement {
  return (
    <>
      <Text variant="note" tone="muted">
        <a
          href={itemLink('', workspaceId, itemId)}
          target="_blank"
          rel="noreferrer"
          className={`underline ${focusRing}`}
        >
          Open target note
        </a>
      </Text>
      <ScrollRegion
        aria-label="Text to add"
        className={`max-h-60 overflow-y-auto rounded-sm border border-divider p-2 ${focusRing}`}
      >
        <Text as="div" variant="bodySmall" className="whitespace-pre-wrap">
          {markdown}
        </Text>
      </ScrollRegion>
    </>
  );
}

function sheetChangeTarget(change: SheetEditChange): string {
  switch (change.kind) {
    case 'cell':
      return change.cell;
    case 'extent':
      return change.axis === 'rows' ? 'Rows' : 'Columns';
    case 'width':
      return `Column ${change.column} width`;
  }
}

function sheetChangeValue(change: SheetEditChange, side: 'before' | 'after'): ReactElement {
  const value = change[side];
  let display;
  if (value === null) display = change.kind === 'cell' ? 'Empty' : 'Default';
  else if (change.kind === 'width') display = `${String(value)} px`;
  else display = value;
  return (
    <Text
      as="span"
      variant="bodySmall"
      tone={value === null ? 'muted' : 'default'}
      className="block wrap-anywhere whitespace-pre-wrap"
    >
      {display}
    </Text>
  );
}

const sheetColumns: readonly TableColumn<SheetEditChange>[] = [
  {
    key: 'target',
    header: 'Change',
    rowHeader: true,
    cell: (change) => (
      <Text as="span" variant="bodySmall">
        {sheetChangeTarget(change)}
      </Text>
    ),
  },
  { key: 'before', header: 'Before', cell: (change) => sheetChangeValue(change, 'before') },
  { key: 'after', header: 'After', cell: (change) => sheetChangeValue(change, 'after') },
];

function ProposalPreview({ proposal }: { readonly proposal: PetRunProposal }): ReactElement {
  const { capability, preview } = proposal;
  if (capability === 'browser.browse') {
    const visit = browserVisitSchema.safeParse(preview);
    if (visit.success) {
      return (
        <Text variant="note" tone="muted">
          {visit.data.connectionId == null ? 'Public browsing' : 'Uses the connected site session'}
        </Text>
      );
    }
  }
  if (capability === 'task.rename') {
    const rename = renameSchema.safeParse(preview);
    if (rename.success) {
      return (
        <dl className="flex flex-col gap-2">
          <div>
            <Text as="dt" variant="note" tone="muted">
              Current title
            </Text>
            <Text as="dd" variant="bodySmall" className="whitespace-pre-wrap">
              {rename.data.from}
            </Text>
          </div>
          <div>
            <Text as="dt" variant="note" tone="muted">
              New title
            </Text>
            <Text as="dd" variant="bodySmall" className="whitespace-pre-wrap">
              {rename.data.to}
            </Text>
          </div>
        </dl>
      );
    }
  }
  if (capability === 'task.comment') {
    const comment = commentSchema.safeParse(preview);
    if (comment.success) {
      return (
        <>
          <Text variant="note" tone="muted">
            {comment.data.title} · {comment.data.audience}
          </Text>
          <Text variant="bodySmall" className="whitespace-pre-wrap">
            {comment.data.body}
          </Text>
        </>
      );
    }
  }
  if (capability === 'comment.create') {
    const comment = legacyCommentSchema.strict().safeParse(preview);
    if (comment.success) {
      return (
        <Text variant="bodySmall" className="whitespace-pre-wrap">
          {comment.data.text}
        </Text>
      );
    }
  }
  const sheet = sheetSchema.safeParse(preview);
  if (capability === 'sheet.edit' && sheet.success) {
    const changes = sheetChanges.safeParse(sheet.data.preview.changes);
    if (changes.success) {
      return (
        <Table
          caption="Sheet changes"
          captionHidden
          className="table-fixed"
          columns={sheetColumns}
          rows={changes.data}
          rowKey={sheetChangeTarget}
          emptyMessage="No sheet changes"
        />
      );
    }
  }
  const details = sheet.success ? sheet.data.preview.changes : preview;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {sheet.success && sheet.data.preview.revision !== undefined ? (
        <Text variant="note" tone="muted">
          Sheet revision {sheet.data.preview.revision.headSeq}
        </Text>
      ) : null}
      <Text as="div" variant="note" className="min-w-0 wrap-anywhere whitespace-pre-wrap">
        {typeof details === 'string' ? details : JSON.stringify(details, null, 2)}
      </Text>
    </div>
  );
}
