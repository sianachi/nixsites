import { READ_ONLY_OPERATIONS, type WorkspaceToolArgs } from './tool-args.js';

/** Writes that keep asking even while "apply changes without asking" is on. Each one can
 * change who sees something, which no preview makes safe to run unread and no undo takes
 * back. Existing view refinements also always require a review of the before/after card.
 * Trash hides an item from everyone until restored; a move changes which ancestors an
 * item inherits its permissions from, so it can widen the audience; a template capture copies
 * a subtree into the workspace-visible library. A generic action (publish, permanent delete,
 * sharing) can do all of that, so it never applies unattended. */
const ALWAYS_ASK_OPERATIONS: ReadonlySet<WorkspaceToolArgs['operation']> = new Set<
  WorkspaceToolArgs['operation']
>(['trash_item', 'move_item', 'save_as_template', 'update_view', 'edit_fields', 'run_action']);

/** Whether a pending write may run without a click once its preview has loaded clean. Reads
 * are governed separately (`readWithoutAsking`); this only answers for writes. Lives in this
 * package rather than the web app so the eval harness (docs/plans/pet-tool-use-plan.md, F.2)
 * applies the same rule when it is built. A preview with problems, no preview at all, and text with an
 * external link (`hasExternalLink`) are the caller's own checks: this function only knows the
 * operation. */
export function canApplyWithoutAsking(operation: WorkspaceToolArgs['operation']): boolean {
  return !READ_ONLY_OPERATIONS.has(operation) && !ALWAYS_ASK_OPERATIONS.has(operation);
}

const EXTERNAL_LINK = /(?:^|[^A-Za-z0-9])(?:https?:)?\/\/[^\s/]+/i;

/** Whether any text a write would store carries a link to another host. ADR-0050 Amendment 1
 * accepted unattended reads because every write was still read by the owner on a never-folded
 * card; with writes unattended too, injected text could make the model store an image or link
 * whose URL carries what it just read, and the browser would fetch it the first time anyone
 * opens the item. Such a write always waits for the owner. */
export function hasExternalLink(texts: readonly string[]): boolean {
  return texts.some((text) => EXTERNAL_LINK.test(text));
}
