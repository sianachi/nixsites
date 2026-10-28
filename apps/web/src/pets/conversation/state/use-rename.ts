import { pets, type PetConnection } from '@nix/api-client';
import { useState } from 'react';
import { useApiClient } from '@nix/web-platform/api/api-client-provider';

/** Editing the live conversation title, and why a save failed. */
export function useRename({
  workspaceId,
  petId,
  rootItemId,
  setRuntime,
}: {
  readonly workspaceId: string;
  readonly petId: string;
  readonly rootItemId: string | undefined;
  readonly setRuntime: (runtime: PetConnection) => void;
}): {
  readonly renaming: boolean;
  readonly renameBusy: boolean;
  readonly renameError: string;
  readonly startRename: () => void;
  readonly cancelRename: () => void;
  readonly renameConversation: (title: string) => Promise<void>;
} {
  const client = useApiClient();
  const [renaming, setRenaming] = useState(false);
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameError, setRenameError] = useState('');

  async function renameConversation(title: string) {
    setRenameBusy(true);
    setRenameError('');
    try {
      const result = await client.execute(
        pets.runtime({
          operation: 'rename',
          workspaceId,
          petId,
          text: title,
          ...(rootItemId ? { rootItemId } : {}),
        }),
      );
      setRuntime(result);
      setRenaming(false);
    } catch {
      setRenameError('The conversation could not be renamed. Try again.');
    } finally {
      setRenameBusy(false);
    }
  }

  return {
    renaming,
    renameBusy,
    renameError,
    startRename: () => {
      setRenameError('');
      setRenaming(true);
    },
    cancelRename: () => {
      setRenaming(false);
    },
    renameConversation,
  };
}
