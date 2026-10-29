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

/**
 * Creates a note per dropped folder (containers are plain notes) and uploads every file under its
 * parent through a bounded pool. Returns how many files went up; the first failure aborts.
 */
export async function uploadEntries(
  entries: readonly (File | FileSystemEntry)[],
  rootParentId: string | null,
  io: {
    readonly createFolder: (name: string, parentId: string | null) => Promise<string>;
    readonly uploadFile: (file: File, parentId: string | null) => Promise<void>;
  },
): Promise<number> {
  const files: { file: File; parentId: string | null }[] = [];
  const walk = async (entry: File | FileSystemEntry, parentId: string | null): Promise<void> => {
    if (entry instanceof File) files.push({ file: entry, parentId });
    else if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) => {
        (entry as FileSystemFileEntry).file(resolve, reject);
      });
      files.push({ file, parentId });
    } else {
      const id = await io.createFolder(entry.name, parentId);
      for (const child of await readAll((entry as FileSystemDirectoryEntry).createReader())) {
        await walk(child, id);
      }
    }
  };
  for (const entry of entries) await walk(entry, rootParentId);

  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const next = files[cursor++];
      if (next === undefined) return;
      await io.uploadFile(next.file, next.parentId);
    }
  };
  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_UPLOADS, files.length) }, worker));
  return files.length;
}
