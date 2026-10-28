import { files as fileResources, isNixApiError } from '@nix/api-client';
import { useCallback } from 'react';

import { announce } from '@nix/web-foundation/a11y/announcer';
import { useApiClient } from '@nix/web-platform/api/api-client-provider';
import { useWorkspaceTree } from '../../items/use-workspace-tree';
import { useWorkspace } from '@nix/web-workspaces/workspaces/workspace-context';
import type { Item } from '../core/container-model';
import type { ContainerData } from '../core/use-container';

/** Uploads in flight at once: enough to overlap network latency across several files without
 * saturating the connection or losing per-file failure attribution. */
const MAX_CONCURRENT_UPLOADS = 3;

/** The drive's three bulk operations: download, upload and move, reporting through `setStatus`. */
export function useDriveTransfers(
  container: ContainerData,
  setStatus: (message: string | null) => void,
): {
  readonly downloadItems: (items: readonly Item[]) => Promise<void>;
  readonly uploadFiles: (files: FileList) => Promise<void>;
  readonly moveItems: (ids: readonly string[], targetParentId: string | null) => Promise<void>;
} {
  const client = useApiClient();
  const { workspaceId } = useWorkspace();
  const tree = useWorkspaceTree();

  // The tray-registration effect needs a stable callback to avoid updating on every render.
  const downloadItems = useCallback(
    async (items: readonly Item[]): Promise<void> => {
      const files = items.filter((row) => row.type === 'file');
      const skipped = items.length - files.length;
      setStatus(
        `Downloading ${String(files.length)} ${files.length === 1 ? 'file' : 'files'}${
          skipped > 0
            ? `; skipping ${String(skipped)} non-file ${skipped === 1 ? 'item' : 'items'}`
            : ''
        }…`,
      );
      let downloaded = 0;
      for (const item of files) {
        try {
          // Zipping the selection through the export worker is out of scope here; each file is
          // downloaded on its own, one at a time, exactly as opening the file page and clicking
          // Download would do.
          const { blob } = await fileResources.fetchFileContent(client, item.id);
          const url = URL.createObjectURL(blob);
          const anchor = document.createElement('a');
          anchor.href = url;
          anchor.download = item.title || 'download';
          anchor.click();
          URL.revokeObjectURL(url);
          downloaded += 1;
        } catch {
          // One file's refusal must not stop the rest of the selection from downloading, but the
          // announcement below has to count it as failed rather than claim it succeeded.
        }
      }
      setStatus(null);
      const failed = files.length - downloaded;
      announce(
        failed === 0
          ? `${String(downloaded)} ${downloaded === 1 ? 'file' : 'files'} downloaded.`
          : `${String(downloaded)} of ${String(files.length)} ${
              files.length === 1 ? 'file' : 'files'
            } downloaded; ${String(failed)} could not be downloaded.`,
      );
    },
    [client, setStatus],
  );

  /**
   * Moves every id to `targetParentId`, one at a time, and takes `tree.move`'s refusal seriously
   * rather than assuming success: the refusal reason is shown rather than swallowed into a blanket
   * "N items moved".
   */
  async function moveItems(ids: readonly string[], targetParentId: string | null): Promise<void> {
    const refusals = new Map<string, string>();
    for (const id of ids) {
      const outcome = await tree.move(id, targetParentId, null);
      if (outcome.refusal !== null) refusals.set(id, outcome.refusal);
    }
    await container.reload();
    if (refusals.size === 0) {
      announce(`${String(ids.length)} ${ids.length === 1 ? 'item' : 'items'} moved.`);
      return;
    }
    const moved = ids.length - refusals.size;
    const firstRefusal = refusals.values().next().value ?? 'the move was refused';
    const message = `${String(moved)} of ${String(ids.length)} ${
      ids.length === 1 ? 'item' : 'items'
    } moved; ${String(refusals.size)} refused: ${firstRefusal}`;
    setStatus(message);
    announce(message);
  }

  /**
   * Uploads every file in turn, one failure at a time, rather than stopping the whole batch and
   * skipping the reload the moment one file refuses: the files that did make it need to show up,
   * and the person needs to be told, in the status line as well as to a screen reader, exactly
   * which one did not and why.
   *
   * Uploads run through a bounded pool rather than the whole batch at once or strictly one file
   * at a time: `MAX_CONCURRENT_UPLOADS` workers each pull the next file off a shared cursor,
   * mirroring the pool in `use-habits.ts`'s `readAll`. Failures are recorded by each file's
   * original index so the reported "first" failure is the earliest file in the picked order, not
   * whichever request happens to lose the race.
   */
  async function uploadFiles(files: FileList): Promise<void> {
    const list = Array.from(files);
    setStatus(list.length === 1 ? 'Uploading 1 file…' : `Uploading ${String(list.length)} files…`);
    const failures: (string | undefined)[] = new Array<string | undefined>(list.length);
    let cursor = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = cursor++;
        const file = list[index];
        if (file === undefined) return;
        try {
          const upload = await client.execute(
            fileResources.beginUpload({
              workspaceId,
              parentId: container.itemId,
              fileName: file.name,
              mediaType: file.type || 'application/octet-stream',
              byteLength: file.size,
              idempotencyKey: `web-drive-upload:${crypto.randomUUID()}`,
            }),
          );
          await fileResources.uploadAndCompleteFile(client, upload, file);
        } catch (error) {
          failures[index] = isNixApiError(error)
            ? (error.detail ?? 'the upload was refused')
            : 'the upload was refused';
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(MAX_CONCURRENT_UPLOADS, list.length) }, worker),
    );
    await container.reload();
    const failedIndex = failures.findIndex((reason) => reason !== undefined);
    if (failedIndex === -1) {
      setStatus(null);
      announce(list.length === 1 ? 'File uploaded.' : `${String(list.length)} files uploaded.`);
      return;
    }
    const uploaded = list.length - failures.filter((reason) => reason !== undefined).length;
    const failedFile = list[failedIndex];
    const failureReason = failures[failedIndex];
    const message = `${String(uploaded)} of ${String(list.length)} uploaded; ${
      failedFile?.name ?? 'a file'
    } could not be uploaded: ${failureReason ?? 'the upload was refused'}`;
    setStatus(message);
    announce(message);
  }

  return { downloadItems, uploadFiles, moveItems };
}
