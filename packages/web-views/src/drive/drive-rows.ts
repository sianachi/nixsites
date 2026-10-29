import type { MenuEntry } from '@nix/ui';
import type { DragEvent } from 'react';

import { formatBytes } from '@nix/web-collections/items/file-facts';
import type { Item } from '@nix/web-collections/core/container-model';
import { kindOf } from './drive-sort';
import type { DriveFileInfo } from './use-drive-file-info';

/** The kind and size line a phone row and a grid card carry in place of the dropped columns. */
export function rowDetail(item: Item, info: DriveFileInfo | undefined): string {
  const kind = kindOf(item, info);
  return item.type === 'file' && info?.status === 'ready'
    ? `${kind} · ${formatBytes(info.record.current.byteLength)}`
    : kind;
}

/** A file that is not also drawn as a folder: the rows whose picture can be a thumbnail. */
export function isFileRow(item: Item): boolean {
  return item.type === 'file' && !item.hasChildren;
}

export interface RowsProps {
  readonly rows: readonly Item[];
  readonly fileInfo: ReadonlyMap<string, DriveFileInfo>;
  readonly dropTargetRow: string | null;
  readonly onOpen: (itemId: string) => void;
  readonly rowContextMenu: (item: Item) => MenuEntry[];
  readonly onDragStart: (item: Item, event: DragEvent<HTMLElement>) => void;
  readonly onDragOver: (item: Item, event: DragEvent<HTMLElement>) => void;
  readonly onDragEnd: () => void;
  readonly onDrop: (item: Item, event: DragEvent<HTMLElement>) => void;
}
