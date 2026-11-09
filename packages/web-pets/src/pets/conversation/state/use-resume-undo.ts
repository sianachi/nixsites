import { pets, type PetConnection } from '@nix/api-client';
import { useUndo } from '@nix/ui';
import { useApiClient } from '@nix/web-platform/api/api-client-provider';

/**
 * Undo for swapping the live conversation (a new one, or a past one continued). The one that was
 * live is archived as the newest history entry, so undoing is continuing that entry; the
 * conversation left behind is archived in turn, so nothing is lost either way.
 */
export function useResumeUndo({
  workspaceId,
  petId,
  rootItemId,
  setRuntime,
}: {
  readonly workspaceId: string;
  readonly petId: string;
  readonly rootItemId: string | undefined;
  readonly setRuntime: (runtime: PetConnection) => void;
}): (label: string, hadMessages: boolean) => void {
  const client = useApiClient();
  const undo = useUndo();
  const scope = { workspaceId, petId, ...(rootItemId ? { rootItemId } : {}) };
  return (label, hadMessages) => {
    // An empty conversation is not archived, so there would be nothing to go back to.
    if (!hadMessages) return;
    undo.push(label, async () => {
      const list = await client.execute(pets.runtime({ operation: 'history', ...scope }));
      const previous = list.history?.[0];
      if (!previous) return;
      setRuntime(
        await client.execute(
          pets.runtime({ operation: 'resume_history', historyId: previous.id, ...scope }),
        ),
      );
    });
  };
}
