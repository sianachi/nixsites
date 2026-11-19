import { items } from '@nix/api-client';
import { requirePetItem } from '../guards.js';
import type { CompanionPorts } from '../ports.js';

export const SANDBOX_TITLE = 'Pet drafts';
const PAGE_SIZE = 100;
const MAX_PAGES = 5;

/** Finds the first exact-title workspace-root sandbox, scanning no more than five pages. */
export async function findSandbox(
  ports: CompanionPorts,
  workspaceId: string,
  signal: AbortSignal,
): Promise<{ id: string } | null> {
  for await (const item of ports.core.paginate(
    items.listItems(workspaceId, { pageSize: PAGE_SIZE }),
    { signal, maxPages: MAX_PAGES },
  )) {
    if (
      item.workspaceId === workspaceId &&
      item.parentId === null &&
      item.title === SANDBOX_TITLE
    ) {
      requirePetItem(item);
      return { id: item.id };
    }
  }
  return null;
}

/** Creates the ordinary workspace-root note used to contain blueprint drafts. */
export async function createSandbox(
  ports: CompanionPorts,
  workspaceId: string,
  signal: AbortSignal,
): Promise<{ id: string }> {
  const created = await ports.core.execute(
    items.createItem(workspaceId, { type: 'note', title: SANDBOX_TITLE, parentId: null }),
    { signal, forceRefresh: true },
  );
  return { id: created.id };
}
