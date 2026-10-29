import type { NixClient } from '@nix/api-client';
import type { StructureFingerprint } from '@nix/companion';
import {
  WorkspaceToolRefusal,
  workspaceToolSchema,
  type WorkspaceToolArgs,
} from '@nix/companion/tool-args';
import { Text, cn, focusRing } from '@nix/ui';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';

import { PetBodyEditPreview } from '../pet-body-edit-preview';
import { PetStructurePreview } from '../pet-structure-preview';
import { ApprovalActions, ApprovalFrame, touchLink } from './approval-frame';
import { ApprovalSummary } from './approval-summary';
import { EditRequest, isEditable } from './edit-request';
import { prepareWrite, type PreparedPreview } from './prepare-write';
import {
  HELD_AFTER_LOCKED_READ,
  waitsForOwnerBecause,
  writeMayRunWithoutAsking,
  writeTextItems,
} from './write-gate';
import { PropertyValueList, WriteTextSection } from './write-text';

export type WriteDecision =
  | { readonly approved: false }
  | {
      readonly approved: true;
      readonly args: WorkspaceToolArgs;
      readonly fence: StructureFingerprint;
      readonly withoutAsking: boolean;
    };

/** A preview, and the exact request it describes: after an edit, the old one never counts. */
type Preview =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly of: WorkspaceToolArgs; readonly prepared: PreparedPreview }
  | { readonly status: 'failed'; readonly of: WorkspaceToolArgs; readonly error: string };

/**
 * The approval card for a write a generated component asks for (`Mutation(...)`): the same
 * preview, full stored text (security fix S1, never folded while pending) and gate as the pet's
 * own cards, because a model wrote the request either way. There is no claim - no pet turn is
 * waiting - so one decision settles it, and the run that follows is fenced by this preview.
 *
 * "Apply without asking" covers it only under the pet card's own rule (`writeMayRunWithoutAsking`)
 * and only when nothing read in the same component touched a lock (`held`).
 */
export function ApprovalCard({
  client,
  workspaceId,
  args: requested,
  applyWithoutAsking,
  held,
  scope,
  onDecide,
}: {
  readonly client: NixClient;
  readonly workspaceId: string;
  readonly args: WorkspaceToolArgs;
  readonly applyWithoutAsking: boolean;
  /** Something this request's component read sits under a lock: the owner decides. */
  readonly held: boolean;
  /** A note-scoped conversation's scope, so the preview checks what the run will check. */
  readonly scope?: { readonly rootItemId: string; readonly readOnly: boolean } | undefined;
  readonly onDecide: (decision: WriteDecision) => void;
}): ReactNode {
  const [preview, setPreview] = useState<Preview>({ status: 'loading' });
  const decided = useRef(false);
  // The owner's correction, which then is what previews, approves and runs.
  const [edited, setEdited] = useState<WorkspaceToolArgs | null>(null);
  const [editing, setEditing] = useState(false);
  const args = edited ?? requested;
  const scopeRoot = scope?.rootItemId;
  const scopeReadOnly = scope?.readOnly ?? true;
  // The switch covers requests made after it went on, as on the pet's cards: a card already
  // waiting when it is turned on stays the owner's (L1).
  const [switchWasOn] = useState(applyWithoutAsking);
  const mayApply = applyWithoutAsking && switchWasOn;

  useEffect(() => {
    const controller = new AbortController();
    prepareWrite(
      client,
      workspaceId,
      args,
      controller.signal,
      scopeRoot === undefined ? undefined : { rootItemId: scopeRoot, readOnly: scopeReadOnly },
    ).then(
      (prepared) => {
        if (!controller.signal.aborted) setPreview({ status: 'ready', of: args, prepared });
      },
      (reason: unknown) => {
        if (!controller.signal.aborted)
          setPreview({
            status: 'failed',
            of: args,
            error:
              reason instanceof WorkspaceToolRefusal
                ? reason.message
                : 'The preview could not be loaded. Decline it and try again.',
          });
      },
    );
    return () => {
      controller.abort();
    };
  }, [client, workspaceId, args, scopeRoot, scopeReadOnly]);

  const current = preview.status !== 'loading' && preview.of === args ? preview : undefined;
  const prepared = current?.status === 'ready' ? current.prepared : undefined;
  const problems = prepared?.model.problems ?? [];
  const clean = prepared !== undefined && problems.length === 0;
  const unattended =
    clean && !held && writeMayRunWithoutAsking(args, prepared.model, prepared.taskOccurrence);

  function decide(decision: WriteDecision) {
    if (decided.current) return;
    decided.current = true;
    onDecide(decision);
  }

  useEffect(() => {
    if (mayApply && unattended && edited === null)
      decide({ approved: true, args, fence: prepared.fingerprint, withoutAsking: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `decide` only reads a ref
  }, [mayApply, unattended, prepared, args, edited]);

  const waitReason =
    mayApply && prepared && clean && !unattended
      ? held
        ? HELD_AFTER_LOCKED_READ
        : waitsForOwnerBecause(args, prepared.model, prepared.taskOccurrence)
      : undefined;
  const target = args.itemId || args.parentId;

  const heading =
    prepared?.model.headline ??
    (preview.status === 'failed' ? 'This change' : 'Preparing a summary…');
  return (
    <ApprovalFrame
      heading={heading}
      actions={(headingId) => (
        <ApprovalActions
          headingId={headingId}
          approveDisabled={!clean || editing}
          editLabel={edited === null ? 'Edit' : 'Edit again'}
          onApprove={() => {
            if (prepared)
              decide({ approved: true, args, fence: prepared.fingerprint, withoutAsking: false });
          }}
          onDecline={() => {
            decide({ approved: false });
          }}
          onEdit={
            isEditable(requested) && !editing
              ? () => {
                  setEditing(true);
                }
              : undefined
          }
          onUndo={undefined}
        />
      )}
    >
      <Text variant="note" tone="muted">
        A component in this conversation asks to change your workspace.
      </Text>
      {prepared ? (
        <ApprovalSummary model={prepared.model} args={args} workspaceId={workspaceId} />
      ) : null}
      {prepared ? (
        <PetStructurePreview model={prepared.model} captureSummary={false} pending>
          {prepared.model.bodyEdit ? <PetBodyEditPreview edit={prepared.model.bodyEdit} /> : null}
        </PetStructurePreview>
      ) : null}
      {preview.status === 'loading' ? <Text variant="note">Preparing the preview...</Text> : null}
      {preview.status === 'failed' ? (
        <Text variant="note" role="alert">
          {preview.error}
        </Text>
      ) : null}
      {args.operation === 'set_properties' ? (
        <PropertyValueList propertiesJson={args.propertiesJson} />
      ) : null}
      <WriteTextSection items={writeTextItems(args)} />
      {target ? (
        <Link
          className={cn('underline', touchLink, focusRing)}
          to={`/w/${workspaceId}?item=${target}`}
        >
          Inspect the item
        </Link>
      ) : null}
      <Text variant="note" tone="muted">
        Approval applies this change using your Nix permissions.
      </Text>
      {waitReason ? (
        <Text variant="note" tone="muted">
          {waitReason}
        </Text>
      ) : null}
      {editing ? (
        <EditRequest
          original={requested}
          current={args}
          onSave={(next) => {
            setEdited(next === null ? null : workspaceToolSchema.parse(JSON.parse(next.arguments)));
            setEditing(false);
          }}
          onCancel={() => {
            setEditing(false);
          }}
        />
      ) : null}
    </ApprovalFrame>
  );
}
