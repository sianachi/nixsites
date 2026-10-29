import type { NixClient } from '@nix/api-client';
import type { StructureFingerprint, WorkspaceToolOutcome } from '@nix/companion';
import type { WorkspaceToolArgs } from '@nix/companion/tool-args';
import type { PreviewModel } from '@nix/structure-spec';

import { notifyItemChildrenChanged } from '@nix/web-foundation/lib/item-children-changed';

export interface PreparedPreview {
  model: PreviewModel;
  fingerprint: StructureFingerprint;
  /** The write completes one occurrence of a repeating task, which Core cannot reopen. */
  taskOccurrence: boolean;
  /** The preview refused a body edit with text quoting a note under a lock. */
  refusalQuotesLockedContent: boolean;
}

/** What a write would do, as the owner's card shows it, and the fence its run must still match.
 * Throws a `WorkspaceToolRefusal` when the request cannot even be previewed. */
export async function prepareWrite(
  client: NixClient,
  workspaceId: string,
  args: WorkspaceToolArgs,
  signal: AbortSignal,
  scope?: { rootItemId: string; readOnly: boolean },
): Promise<PreparedPreview> {
  // Keep the yjs-bearing companion package out of the initial web bundle. A card displays an
  // explicit loading state while this preview-only dependency is fetched.
  const {
    createCompanionBodies,
    defaultClock,
    defaultIds,
    describeToolCall,
    loadPreviewContext,
    prepareNoteScopedTool,
  } = await import('@nix/companion');
  const ports = {
    core: client,
    collab: client,
    bodies: createCompanionBodies(client),
    clock: defaultClock(),
    ids: defaultIds(),
  };
  const preparedArgs = scope
    ? await prepareNoteScopedTool(ports, workspaceId, args, signal, scope)
    : args;
  const context = await loadPreviewContext(ports, workspaceId, preparedArgs, signal, scope);
  return {
    model: describeToolCall(preparedArgs, context),
    fingerprint: context.fingerprint,
    taskOccurrence: context.taskCompletion?.kind === 'occurrence',
    refusalQuotesLockedContent: context.refusalQuotesLockedContent ?? false,
  };
}

/** Refreshes what a completed write changed: items, the tree under each touched parent, and the
 * caches a template or a task completion also moves. */
export function afterWrite(
  client: NixClient,
  workspaceId: string,
  args: WorkspaceToolArgs,
  outcome: WorkspaceToolOutcome,
): void {
  if (outcome.readOnly) return;
  client.invalidate(['items']);
  for (const parent of outcome.touchedParents) notifyItemChildrenChanged(workspaceId, parent);
  if (args.operation === 'apply_template') client.invalidate(['templates']);
  // A completed occurrence changes what the calendar draws, and its cache is keyed by workspace,
  // not by item.
  if (args.operation === 'complete_task')
    client.invalidate(['workspaces', workspaceId, 'calendar']);
}
