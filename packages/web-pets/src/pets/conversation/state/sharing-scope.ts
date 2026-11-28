import type { PetPlanSourceScope } from '@nix/api-client';

/**
 * The sources a turn discloses, or null when it carries the person's text alone: a note chat is its
 * subtree, workspace context is the whole workspace whatever is attached, and otherwise it is the
 * attached items. Plan adoption uses it as the scope the plan reads.
 */
export function sharingScope(
  noteRootItemId: string | undefined,
  workspaceAccess: boolean,
  fields: object,
): PetPlanSourceScope | null {
  if (noteRootItemId !== undefined) return { kind: 'subtree', itemIds: [noteRootItemId] };
  if (workspaceAccess) return { kind: 'workspace' };
  const ids = new Set<string>();
  if ('itemId' in fields && typeof fields.itemId === 'string') ids.add(fields.itemId);
  if ('itemIds' in fields && Array.isArray(fields.itemIds))
    for (const id of fields.itemIds) if (typeof id === 'string') ids.add(id);
  return ids.size === 0 ? null : { kind: 'selected', itemIds: [...ids].sort() };
}
