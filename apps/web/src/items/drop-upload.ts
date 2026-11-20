import { files, isNixApiError, items, type NixClient } from '@nix/api-client';

/** Uploads in flight at once, as in the drive's bulk upload. */
const MAX_CONCURRENT_UPLOADS = 3;

/**
 * What an OS drop carries, read synchronously: `DataTransfer` is emptied once the event ends, so
 * the entries must be taken before anything awaits.
 */
export function collectDropped(transfer: DataTransfer): (File | FileSystemEntry)[] {
  const dropped: (File | FileSystemEntry)[] = [];
  for (const item of Array.from(transfer.items)) {
    if (item.kind !== 'file') continue;
    const entry = item.webkitGetAsEntry();
    const found = entry ?? item.getAsFile();
    if (found !== null) dropped.push(found);
  }
  return dropped;
}

const readAll = async (reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> => {
  const all: FileSystemEntry[] = [];
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => {
      reader.readEntries(resolve, reject);
    });
    if (batch.length === 0) return all;
    all.push(...batch);
  }
};

/** OS litter and trees nobody means to upload, skipped by name. */
const SKIPPED_NAMES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini', '.git', 'node_modules']);

export interface UploadOutcome {
  readonly folders: number;
  readonly uploaded: number;
  /** Files that failed or were never started after the first failure. */
  readonly failed: number;
  readonly error: unknown;
}

/** A running tally, reported as folders are found and files go up. */
export interface UploadProgress {
  /** Still walking the dropped folders. */
  readonly discovering: boolean;
  readonly folders: number;
  /** Files found so far. */
  readonly found: number;
  readonly uploaded: number;
  readonly failed: number;
}

/** The status line for a running drop. */
export function progressText(progress: UploadProgress): string {
  const { discovering, folders, found, uploaded, failed } = progress;
  const failures = failed > 0 ? `, ${String(failed)} failed` : '';
  if (discovering && found === 0) return `Reading folders: ${String(folders)} found...`;
  const total = discovering ? `${String(found)} found so far` : `of ${String(found)}`;
  return `Uploading ${String(uploaded)} ${total}${failures}`;
}

/**
 * Creates a note per dropped folder (containers are plain notes) and uploads every file under its
 * parent through a bounded pool. Uploads start as files are found, each after its parent folder
 * exists. The first upload failure stops the pool from starting more and stops the walk; the
 * outcome counts what went up.
 */
export async function uploadEntries(
  entries: readonly (File | FileSystemEntry)[],
  rootParentId: string | null,
  io: {
    readonly createFolder: (name: string, parentId: string | null) => Promise<string>;
    readonly uploadFile: (file: File, parentId: string | null) => Promise<void>;
  },
  onProgress?: (progress: UploadProgress) => void,
): Promise<UploadOutcome> {
  let folders = 0;
  let uploaded = 0;
  let failedUploads = 0;
  let failed = false;
  let error: unknown = null;
  let discovering = true;
  const discovery: { error?: { readonly caught: unknown } } = {};
  const queue: { file: File; parentId: string | null }[] = [];
  let found = 0;
  let wake: (() => void) | null = null;
  const notify = (): void => {
    const waiting = wake;
    wake = null;
    waiting?.();
  };
  const report = (): void => {
    onProgress?.({ discovering, folders, found, uploaded, failed: failedUploads });
  };
  const enqueue = (file: File, parentId: string | null): void => {
    queue.push({ file, parentId });
    found++;
    report();
    notify();
  };

  const walk = async (entry: File | FileSystemEntry, parentId: string | null): Promise<void> => {
    if (failed || SKIPPED_NAMES.has(entry.name)) return;
    if (entry instanceof File) enqueue(entry, parentId);
    else if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) => {
        (entry as FileSystemFileEntry).file(resolve, reject);
      });
      enqueue(file, parentId);
    } else {
      const id = await io.createFolder(entry.name, parentId);
      folders++;
      report();
      for (const child of await readAll((entry as FileSystemDirectoryEntry).createReader())) {
        await walk(child, id);
      }
    }
  };
  const discover = async (): Promise<void> => {
    try {
      for (const entry of entries) await walk(entry, rootParentId);
    } catch (caught) {
      discovery.error = { caught };
    } finally {
      discovering = false;
      report();
      notify();
    }
  };

  const worker = async (): Promise<void> => {
    while (!failed) {
      const next = queue.shift();
      if (next === undefined) {
        if (!discovering) return;
        await new Promise<void>((resolve) => {
          const previous = wake;
          wake = () => {
            previous?.();
            resolve();
          };
        });
        continue;
      }
      try {
        await io.uploadFile(next.file, next.parentId);
        uploaded++;
        report();
      } catch (caught) {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- another worker may have failed first
        if (!failed) error = caught;
        failed = true;
        failedUploads++;
        report();
        notify();
      }
    }
  };
  await Promise.all([discover(), ...Array.from({ length: MAX_CONCURRENT_UPLOADS }, worker)]);
  // A failed walk is the drop's error, as before; uploads already done stay done.
  if (discovery.error !== undefined) throw discovery.error.caught;
  return { folders, uploaded, failed: found - uploaded, error };
}

export function uploadWorkspaceEntries(
  client: NixClient,
  workspaceId: string,
  dropped: readonly (File | FileSystemEntry)[],
  parentId: string | null,
  onProgress?: (progress: UploadProgress) => void,
): Promise<UploadOutcome> {
  return uploadEntries(
    dropped,
    parentId,
    {
      createFolder: async (title, parentId) =>
        (
          await client.execute(
            items.createItem(workspaceId, {
              type: 'note',
              title,
              parentId,
              idempotencyKey: crypto.randomUUID(),
            }),
          )
        ).id,
      uploadFile: async (file, parentId) => {
        const upload = await client.execute(
          files.beginUpload({
            workspaceId,
            parentId,
            fileName: file.name,
            mediaType: file.type || 'application/octet-stream',
            byteLength: file.size,
            idempotencyKey: `web-file:${crypto.randomUUID()}`,
          }),
        );
        await files.uploadAndCompleteFile(client, upload, file);
      },
    },
    onProgress,
  );
}

export function uploadErrorText(error: unknown): string {
  if (isNixApiError(error)) return error.detail ?? 'The file could not be uploaded.';
  return error instanceof Error ? error.message : 'The file could not be uploaded.';
}
