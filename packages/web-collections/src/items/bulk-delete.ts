import { planBulkMove } from './bulk-move';
import type { TreeItem, WorkspaceTree } from './use-workspace-tree';

/**
 * Deleting several items at once (requirement 7), as data first.
 *
 * Deleting a parent already deletes everything under it, so the plan deletes top-level selected
 * items only (the same dropping `planBulkMove` does). Items Core would refuse are taken out up
 * front and named, instead of being discovered one failed request at a time. The deletes then run
 * one at a time through the tree's own `remove`, the same path a single delete takes; there is no
 * batch endpoint.
 *
 * shortcut: sequential deletes; add a batch endpoint if deleting more than ~50 items gets slow.
 */

export interface BlockedDelete {
  readonly id: string;
  readonly title: string;
  readonly reason: 'protected' | 'locked';
}

export interface BulkDeletePlan {
  /** The items that will be deleted, top-level only. */
  readonly items: readonly TreeItem[];
  /** Selected ids a selected ancestor deletes along with itself. */
  readonly carried: readonly string[];
  readonly blocked: readonly BlockedDelete[];
  /** Items inside the deleted ones, or null when part of the tree is not loaded to count. */
  readonly descendants: number | null;
}

type PlanTree = Pick<WorkspaceTree, 'find' | 'childrenOf' | 'isLocked'>;

/** Counts what sits under `id`; null when a folder with children has not loaded them. */
function countInside(id: string, tree: PlanTree, seen: Set<string>): number | null {
  const children = tree.childrenOf(id);
  if (children.length === 0) return (tree.find(id)?.hasChildren ?? false) ? null : 0;
  let total = 0;
  for (const child of children) {
    if (seen.has(child.id)) continue;
    seen.add(child.id);
    const inside = countInside(child.id, tree, seen);
    if (inside === null) return null;
    total += 1 + inside;
  }
  return total;
}

function blockReason(item: TreeItem, tree: PlanTree): BlockedDelete['reason'] | null {
  if (item.noDelete === true) return 'protected';
  const seen = new Set<string>();
  let parentId = item.parentId;
  while (parentId !== null && !seen.has(parentId)) {
    if (tree.isLocked(parentId)) return 'locked';
    seen.add(parentId);
    parentId = tree.find(parentId)?.parentId ?? null;
  }
  return null;
}

export function planBulkDelete(selectedIds: readonly string[], tree: PlanTree): BulkDeletePlan {
  const blocked: BlockedDelete[] = [];
  const open: string[] = [];
  for (const id of selectedIds) {
    const item = tree.find(id);
    const reason = item === null ? null : blockReason(item, tree);
    if (item !== null && reason !== null) blocked.push({ id, title: item.title, reason });
    else open.push(id);
  }
  const { ids, carried } = planBulkMove(open, tree.find);
  const items = ids.flatMap((id) => tree.find(id) ?? []);
  const seen = new Set<string>();
  let descendants: number | null = 0;
  for (const item of items) {
    const inside = countInside(item.id, tree, seen);
    descendants = inside === null || descendants === null ? null : descendants + inside;
  }
  return { items, carried, blocked, descendants };
}

const noun = (count: number): string => (count === 1 ? 'item' : 'items');
const quoted = (title: string): string => `"${title || 'Untitled'}"`;

/** The confirm dialog's words: title, body paragraphs and the confirming button. */
export function describeDeleteConfirm(plan: BulkDeletePlan): {
  readonly title: string;
  readonly body: readonly string[];
  readonly confirm: string | null;
} {
  const count = plan.items.length;
  const body: string[] = [];
  // Unknown depth: say so without a number, rather than guess one.
  if (plan.descendants === null && plan.items.some((item) => item.hasChildren)) {
    body.push(
      `This also deletes the items inside ${count === 1 ? 'it' : 'them'}. You can restore them from Trash.`,
    );
  } else if (plan.descendants !== null && plan.descendants > 0) {
    body.push(
      `This also deletes ${String(plan.descendants)} ${noun(plan.descendants)} inside ${count === 1 ? 'it' : 'them'}. You can restore them from Trash.`,
    );
  }
  if (plan.blocked.length > 0) {
    const n = plan.blocked.length;
    const why = plan.blocked.map(
      (entry) => `${quoted(entry.title)} ${n === 1 ? 'is' : 'are'} ${entry.reason}`,
    );
    body.push(`${String(n)} ${noun(n)} can't be deleted: ${why.join(', ')}.`);
  }
  return count === 0
    ? { title: 'Nothing to delete', body, confirm: null }
    : {
        title: `Delete ${String(count)} ${noun(count)}?`,
        body,
        confirm: `Delete ${String(count)} ${noun(count)}`,
      };
}

export interface BulkDeleteOutcome {
  readonly deleted: readonly TreeItem[];
  readonly failed: readonly { readonly item: TreeItem; readonly reason: string }[];
}

/** Deletes each item, taking every refusal seriously. */
export async function executeBulkDelete(
  tree: Pick<WorkspaceTree, 'remove'>,
  items: readonly TreeItem[],
): Promise<BulkDeleteOutcome> {
  const deleted: TreeItem[] = [];
  const failed: { item: TreeItem; reason: string }[] = [];
  for (const item of items) {
    const { refusal } = await tree.remove(item.id);
    if (refusal === null) deleted.push(item);
    else failed.push({ item, reason: refusal });
  }
  return { deleted, failed };
}

/** The toast sentence a bulk delete ends with, naming the first failure and why. */
export function describeBulkDelete(outcome: BulkDeleteOutcome): string {
  const total = outcome.deleted.length + outcome.failed.length;
  const first = outcome.failed[0];
  if (first === undefined) return `Deleted ${String(total)} ${noun(total)}`;
  return `Deleted ${String(outcome.deleted.length)} of ${String(total)} ${noun(total)}. ${quoted(first.item.title)} could not be deleted: ${first.reason}`;
}
