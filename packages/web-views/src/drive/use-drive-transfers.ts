import { files as fileResources, isNixApiError } from '@nix/api-client';
import { useUndo } from '@nix/ui';
import { useCallback, useState } from 'react';

import { announce } from '@nix/web-foundation/a11y/announcer';
import { useApiClient } from '@nix/web-platform/api/api-client-provider';
import { useWorkspaceTree } from '@nix/web-collections/items/use-workspace-tree';
import { useWorkspace } from '@nix/web-workspaces/workspaces/workspace-context';
import type { Item } from '@nix/web-collections/core/container-model';
import type { ContainerData } from '@nix/web-collections/core/use-container';

/** Uploads in flight at once: enough to overlap network latency across several files without
 * saturating the connection or losing per-file failure attribution. */
const MAX_CONCURRENT_UPLOADS = 3;

/** One picked file's own upload, kept so a failed one can be retried without re-picking the rest. */
export interface DriveUpload {
  readonly id: string;
  readonly file: File;
  readonly status: 'uploading' | 'done' | 'failed';
  readonly reason?: string | undefined;
}

/** The drive's three bulk operations: download, upload and move, reporting through `setStatus`. */
export function useDriveTransfers(
  container: ContainerData,
  setStatus: (message: string | null) => void,
): {
  readonly downloadItems: (items: readonly Item[]) => Promise<void>;
  readonly uploadFiles: (files: FileList) => Promise<void>;
  readonly moveItems: (ids: readonly string[], targetParentId: string | null) => Promise<void>;
  readonly uploads: readonly DriveUpload[];
  readonly retryUpload: (id: string) => Promise<void>;
  readonly dismissUploads: () => void;
} {
  const client = useApiClient();
  const { workspaceId } = useWorkspace();
  const tree = useWorkspaceTree();
  const undo = useUndo();
  const [uploads, setUploads] = useState<readonly DriveUpload[]>([]);

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
    const moved: { readonly id: string; readonly from: string | null }[] = [];
    for (const id of ids) {
      const from = container.children.find((child) => child.id === id)?.parentId ?? null;
      const outcome = await tree.move(id, targetParentId, null);
      if (outcome.refusal !== null) refusals.set(id, outcome.refusal);
      else moved.push({ id, from });
    }
    await container.reload();
    if (moved.length > 0) {
      const titleOf = (id: string | null, fallback: string): string => {
        const title = container.children.find((child) => child.id === id)?.title;
        return title === undefined || title === '' ? fallback : title;
      };
      const first = moved[0];
      const what =
        moved.length === 1 && first !== undefined
          ? `“${titleOf(first.id, 'Untitled')}”`
          : `${String(moved.length)} items`;
      const where = titleOf(targetParentId, 'the parent');
      undo.push(`Moved ${what} to ${where}`, async () => {
        for (const { id, from } of moved) await tree.move(id, from, null);
        await container.reload();
      });
    }
    if (refusals.size === 0) {
      announce(`${String(ids.length)} ${ids.length === 1 ? 'item' : 'items'} moved.`);
      return;
    }
    const message = `${String(moved.length)} of ${String(ids.length)} ${
      ids.length === 1 ? 'item' : 'items'
    } moved; ${String(refusals.size)} refused: ${
      refusals.values().next().value ?? 'the move was refused'
    }`;
    setStatus(message);
    announce(message);
  }

  /** One file's upload; its outcome lands on its own entry so a failure names itself. */
  async function uploadOne(entry: DriveUpload): Promise<void> {
    const mark = (patch: Pick<DriveUpload, 'status' | 'reason'>): void => {
      setUploads((current) =>
        current.map((u) => (u.id === entry.id ? { ...u, reason: undefined, ...patch } : u)),
      );
    };
    try {
      const upload = await client.execute(
        fileResources.beginUpload({
          workspaceId,
          parentId: container.itemId,
          fileName: entry.file.name,
          mediaType: entry.file.type || 'application/octet-stream',
          byteLength: entry.file.size,
          idempotencyKey: `web-drive-upload:${crypto.randomUUID()}`,
        }),
      );
      await fileResources.uploadAndCompleteFile(client, upload, entry.file);
      mark({ status: 'done' });
    } catch (error) {
      const reason = isNixApiError(error)
        ? (error.detail ?? 'the upload was refused')
        : 'the upload was refused';
      mark({ status: 'failed', reason });
      announce(`${entry.file.name} could not be uploaded: ${reason}`);
    }
  }

  /**
   * Uploads through a bounded pool (`MAX_CONCURRENT_UPLOADS` workers pulling off a shared cursor),
   * each file reporting its own uploading / done / failed state in `uploads`. A failure never stops
   * the batch: the files that made it still show up after the reload, and the failed one stays
   * listed with a retry. The upload API has no byte progress, so a file is "uploading" until done.
   */
  async function uploadFiles(files: FileList): Promise<void> {
    const entries: DriveUpload[] = Array.from(files, (file) => ({
      id: crypto.randomUUID(),
      file,
      status: 'uploading',
    }));
    setUploads((current) => [...current.filter((u) => u.status === 'failed'), ...entries]);
    let cursor = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const entry = entries[cursor++];
        if (entry === undefined) return;
        await uploadOne(entry);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(MAX_CONCURRENT_UPLOADS, entries.length) }, worker),
    );
    await container.reload();
    announce(`${String(entries.length)} ${entries.length === 1 ? 'file' : 'files'} processed.`);
  }

  async function retryUpload(id: string): Promise<void> {
    const entry = uploads.find((u) => u.id === id);
    if (entry === undefined) return;
    setUploads((current) =>
      current.map((u) => (u.id === id ? { ...u, status: 'uploading', reason: undefined } : u)),
    );
    await uploadOne(entry);
    await container.reload();
  }

  function dismissUploads(): void {
    setUploads((current) => current.filter((u) => u.status === 'uploading'));
  }

  return { downloadItems, uploadFiles, moveItems, uploads, retryUpload, dismissUploads };
}
