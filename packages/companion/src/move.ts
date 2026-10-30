import { items, workspaces } from '@nix/api-client';
import type { CompanionPorts } from './ports.js';
import { WorkspaceToolRefusal, type WorkspaceToolArgs } from './tool-args.js';

export interface CrossWorkspaceMove {
  workspaceId: string;
  workspaceName: string;
  sourceName: string;
  /** The parent in the destination workspace; absent when the item goes to its root. */
  parentTitle?: string;
}

/** The other workspace a `move_item` names in `specJson.destinationWorkspaceId`, confirmed to be
 * one Core offers this item (`items.move.workspaces`) with the parent inside it. Undefined for a
 * move within this workspace. */
export async function crossWorkspaceMove(
  ports: CompanionPorts,
  workspaceId: string,
  args: Pick<WorkspaceToolArgs, 'itemId' | 'parentId' | 'specJson'>,
  signal: AbortSignal,
): Promise<CrossWorkspaceMove | undefined> {
  const wanted = args.specJson.trim()
    ? (JSON.parse(args.specJson) as { destinationWorkspaceId?: string }).destinationWorkspaceId
    : undefined;
  if (wanted === undefined || wanted === workspaceId) return undefined;
  const options = { signal, forceRefresh: true };
  let target: { id: string; name: string } | undefined;
  for await (const offered of ports.core.paginate(
    items.listItemMoveWorkspaces(args.itemId),
    options,
  ))
    if (offered.id === wanted) target = offered;
  if (target === undefined)
    throw new WorkspaceToolRefusal(
      'That workspace is not one this item can be moved to. No action was run.',
    );
  const parent = args.parentId
    ? await ports.core.query(items.itemById(args.parentId), options)
    : undefined;
  if (parent !== undefined && parent.workspaceId !== wanted)
    throw new WorkspaceToolRefusal(
      'The parent is not in the destination workspace. No action was run.',
    );
  const source = await ports.core.query(workspaces.workspaceById(workspaceId), options);
  return {
    workspaceId: wanted,
    workspaceName: target.name,
    sourceName: source.name,
    ...(parent === undefined ? {} : { parentTitle: parent.title }),
  };
}
