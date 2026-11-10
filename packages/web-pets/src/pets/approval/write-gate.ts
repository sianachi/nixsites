import {
  BODY_EDIT_OPERATIONS,
  canApplyWithoutAsking,
  hasExternalLink,
  writeTextItems,
} from '@nix/companion/auto-apply';
import type { WorkspaceToolArgs } from '@nix/companion/tool-args';
import type { PreviewModel } from '@nix/structure-spec';

/* The rules every approval card applies, from the pet's tool cards and from components' writes
 * alike (moved unchanged from pet-work-tools.tsx, where their history and the security fixes they
 * carry are recorded): when "Apply without asking" may cover a write, why one waits anyway, and
 * every string a write would store (security fix S1). */

/** Whether the switch may ever cover this write: the operation is allowed and none of the text
 * it would store links to another host (see `hasExternalLink`). The title is included because
 * `writeTextItems` lists only bodies, specs and property values. A note body edit also passes the
 * edited block as it will read afterwards (`model.bodyEdit.after`): the find and replace text can
 * join with what is already there into a link neither holds alone. An edit that would drop
 * formatting Markdown cannot carry always waits, so the owner sees the loss before it happens,
 * and so does completing an occurrence of a repeating task (`taskOccurrence`), which cannot be
 * undone. */
export function writeMayRunWithoutAsking(
  args: WorkspaceToolArgs,
  model?: PreviewModel,
  taskOccurrence = false,
): boolean {
  return (
    canApplyWithoutAsking(args.operation) &&
    // Completing an occurrence of a repeating task cannot be undone (Core has no reopen).
    !taskOccurrence &&
    // A body edit's stored text is only known once its preview has placed it.
    (!BODY_EDIT_OPERATIONS.has(args.operation) || model?.bodyEdit !== undefined) &&
    model?.bodyEdit?.losesFormatting !== true &&
    !hasExternalLink([
      args.title,
      ...writeTextItems(args).map((item) => item.text),
      ...(model?.bodyEdit ? [model.bodyEdit.after] : []),
    ])
  );
}

/** Note body edits show the whole edited block before and after (`PetBodyEditPreview`), which
 * already includes every character the request would store. */
const WAITS_FOR_FORMATTING =
  'This one waits for you: approving it removes formatting this edit can’t keep (see below).';
const WAITS_FOR_LINK = 'This one waits for you: it adds a link to another site.';
export const HELD_AFTER_LOCKED_READ =
  'This one waits for you: earlier reads need your review before changes.';
const HELD_FOR_OCCURRENCE =
  "This one waits for you: completing a repeating task's occurrence cannot be undone.";

/** Why a write the owner's switch would otherwise run is waiting anyway, in the owner's words,
 * when that is something the preview shows: formatting a body edit drops, or a link to another
 * host in what it would store. */
export function waitsForOwnerBecause(
  args: WorkspaceToolArgs,
  model: PreviewModel,
  taskOccurrence = false,
): string | undefined {
  if (taskOccurrence) return HELD_FOR_OCCURRENCE;
  if (model.bodyEdit?.losesFormatting) return WAITS_FOR_FORMATTING;
  if (
    hasExternalLink([
      args.title,
      ...writeTextItems(args).map((item) => item.text),
      ...(model.bodyEdit ? [model.bodyEdit.after] : []),
    ])
  )
    return WAITS_FOR_LINK;
  return undefined;
}

export {
  BODY_EDIT_OPERATIONS,
  writeTextItems,
  type WriteTextItem,
} from '@nix/companion/auto-apply';
