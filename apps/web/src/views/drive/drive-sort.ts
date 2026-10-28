import type { Item } from '../core/container-model';
import { fileKindLabel } from '../../files/file-facts';
import { driveBodyKindLabel } from './drive-icons';
import type { DriveFileInfo } from './use-drive-file-info';

export type SortKey = 'name' | 'kind' | 'size' | 'modified';
type SortDirection = 'ascending' | 'descending';

export interface SortState {
  readonly key: SortKey;
  readonly direction: SortDirection;
}

/** The size in bytes this row would sort by, or -1 for anything that is not a file yet. */
function sizeOf(info: DriveFileInfo | undefined): number {
  return info?.status === 'ready' ? info.record.current.byteLength : -1;
}

/** The word this row would sort and print under "Kind". */
export function kindOf(item: Item, info: DriveFileInfo | undefined): string {
  if (item.type !== 'file') return driveBodyKindLabel(item.type);
  if (info?.status === 'ready')
    return fileKindLabel(info.record.current.fileName, info.record.current.mediaType);
  return 'File';
}

export function compareRows(
  a: Item,
  b: Item,
  sort: SortState,
  fileInfo: ReadonlyMap<string, DriveFileInfo>,
): number {
  const direction = sort.direction === 'ascending' ? 1 : -1;
  switch (sort.key) {
    case 'name':
      return direction * a.title.localeCompare(b.title);
    case 'kind':
      return direction * kindOf(a, fileInfo.get(a.id)).localeCompare(kindOf(b, fileInfo.get(b.id)));
    case 'size':
      return direction * (sizeOf(fileInfo.get(a.id)) - sizeOf(fileInfo.get(b.id)));
    case 'modified':
      return direction * (Date.parse(a.updatedAt) - Date.parse(b.updatedAt));
  }
}
