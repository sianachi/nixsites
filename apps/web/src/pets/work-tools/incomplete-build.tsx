import { items, type NixClient } from '@nix/api-client';
import { Button, Text } from '@nix/ui';
import { useState, type ReactElement } from 'react';
import { z } from 'zod';
import { notifyItemChildrenChanged } from '@nix/web-foundation/lib/item-children-changed';
import { buildOutcome } from './receipts';

/** What is left to do about a blueprint build that stopped part way: how far it got, and a way to
 * move the incomplete draft to Trash. Nothing when the build finished or the result is not a build. */
export function IncompleteBuildCleanup({
  client,
  workspaceId,
  result,
}: {
  readonly client: NixClient;
  readonly workspaceId: string;
  readonly result: string;
}): ReactElement | null {
  const incompleteBuild = buildOutcome(result);
  const incompleteRootId =
    incompleteBuild?.rootId && z.uuid().safeParse(incompleteBuild.rootId).success
      ? incompleteBuild.rootId
      : undefined;
  const [cleanupStatus, setCleanupStatus] = useState('');
  const [cleanupBusy, setCleanupBusy] = useState(false);

  async function moveIncompleteDraftToTrash(rootId: string): Promise<void> {
    if (!window.confirm('Move the incomplete draft to Trash? It can be restored later.')) return;
    setCleanupBusy(true);
    setCleanupStatus('');
    try {
      const source = await client.query(items.itemById(rootId), { forceRefresh: true });
      if (source.workspaceId !== workspaceId)
        throw new Error('This draft is outside the current workspace.');
      await client.execute(items.deleteItem(workspaceId, rootId), { forceRefresh: true });
      client.invalidate(['items']);
      notifyItemChildrenChanged(workspaceId, source.parentId);
      setCleanupStatus('Incomplete draft moved to Trash.');
    } catch {
      setCleanupStatus('The incomplete draft could not be moved to Trash. Inspect Nix first.');
    } finally {
      setCleanupBusy(false);
    }
  }

  if (!incompleteBuild || incompleteBuild.complete) return null;
  return (
    <div className="flex flex-col gap-2">
      <Text variant="note" role="status">
        Stopped after{' '}
        {String(incompleteBuild.ledger.filter((entry) => entry.status === 'done').length)} of{' '}
        {String(incompleteBuild.ledger.length)}. The draft is incomplete.
      </Text>
      {incompleteRootId ? (
        <Button
          variant="ghost"
          disabled={cleanupBusy}
          onClick={() => void moveIncompleteDraftToTrash(incompleteRootId)}
        >
          {cleanupBusy ? 'Moving draft to Trash...' : 'Move draft to trash'}
        </Button>
      ) : null}
      {cleanupStatus ? (
        <Text variant="note" role="status">
          {cleanupStatus}
        </Text>
      ) : null}
    </div>
  );
}
