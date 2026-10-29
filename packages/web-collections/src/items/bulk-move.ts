import type { TreeItem, WorkspaceTree } from './use-workspace-tree';

/**
 * Moving several items at once (requirement 7), as data first.
 *
 * The server refuses a move into an item's own subtree, so the plan drops a selected descendant of
 * a selected ancestor: moving the ancestor carries it along, and moving it a second time would
 * either race the first move or be refused. The moves then run one at a time through the tree's
 * own `move`, which is the only write path that keeps the tree, closure and undo in step; there
 * is no batch endpoint, and pretending the sequence is atomic would be a lie the report below
 * exists to avoid.
 *
 * shortcut: sequential moves; add a batch endpoint if moves of more than ~50 items get slow.
 */

export interface BulkMovePlan {
  /** The ids that will be moved, in the order given, descendants of other selected ids dropped. */
  readonly ids: readonly string[];
  /** Selected ids skipped because a selected ancestor carries them. */
  readonly carried: readonly string[];
}

function ancestorsOf(item: TreeItem, find: (id: string) => TreeItem | null): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();
  let parentId = item.parentId;
  while (parentId !== null && !seen.has(parentId)) {
    seen.add(parentId);
    chain.push(parentId);
    parentId = find(parentId)?.parentId ?? null;
  }
  return chain;
}

export function planBulkMove(
  selectedIds: readonly string[],
  find: (id: string) => TreeItem | null,
): BulkMovePlan {
  const selected = new Set(selectedIds);
  const ids: string[] = [];
  const carried: string[] = [];
  for (const id of selectedIds) {
    const item = find(id);
    if (item !== null && ancestorsOf(item, find).some((ancestor) => selected.has(ancestor))) {
      carried.push(id);
    } else {
      ids.push(id);
    }
  }
  return { ids, carried };
}

/** Whether `targetId` is one of `ids` or sits under one of them: a destination the server refuses. */
export function isInsideSelection(
  targetId: string | null,
  ids: ReadonlySet<string>,
  find: (id: string) => TreeItem | null,
): boolean {
  if (targetId === null) return false;
  if (ids.has(targetId)) return true;
  const target = find(targetId);
  return target !== null && ancestorsOf(target, find).some((ancestor) => ids.has(ancestor));
}

/** Why a drop of `ids` onto `targetId` is refused before anything is written, or null. */
export function dropRefusal(
  ids: readonly string[],
  targetId: string,
  find: (id: string) => TreeItem | null,
): string | null {
  if (isInsideSelection(targetId, new Set(ids), find)) {
    return 'An item cannot be moved inside itself.';
  }
  const target = find(targetId);
  return target?.noChildren === true
    ? `${target.title || 'Untitled'} does not accept new children.`
    : null;
}

export interface BulkMoveOutcome {
  readonly moved: readonly string[];
  readonly refused: readonly { readonly id: string; readonly reason: string }[];
}

/** Moves each id to the end of `targetParentId`, taking every refusal seriously. */
export async function executeBulkMove(
  tree: Pick<WorkspaceTree, 'move'>,
  ids: readonly string[],
  targetParentId: string | null,
): Promise<BulkMoveOutcome> {
  const moved: string[] = [];
  const refused: { id: string; reason: string }[] = [];
  for (const id of ids) {
    const outcome = await tree.move(id, targetParentId, null);
    if (outcome.refusal === null) moved.push(id);
    else refused.push({ id, reason: outcome.refusal });
  }
  return { moved, refused };
}

/** The sentence a bulk move ends with. */
export function describeBulkMove(outcome: BulkMoveOutcome, carried: number): string {
  const total = outcome.moved.length + outcome.refused.length;
  const noun = (count: number): string => (count === 1 ? 'item' : 'items');
  const carriedNote =
    carried === 0 ? '' : ` ${String(carried)} selected ${noun(carried)} moved with their parent.`;
  if (outcome.refused.length === 0) {
    return `${String(total)} ${noun(total)} moved.${carriedNote}`;
  }
  const first = outcome.refused[0]?.reason ?? 'the move was refused';
  return `${String(outcome.moved.length)} of ${String(total)} ${noun(total)} moved; ${String(
    outcome.refused.length,
  )} refused: ${first}${carriedNote}`;
}
