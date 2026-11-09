import type { MenuEntry } from '@nix/ui';
import type { DragEvent } from 'react';

import { formatBytes, formatWhen } from '@nix/web-collections/items/file-facts';
import type { Item } from '@nix/web-collections/core/container-model';
import { kindOf } from './drive-sort';
import type { DriveFileInfo } from './use-drive-file-info';

/** Kind, size and date as one line: the detail one tap away, not on every row. */
export function rowDetail(item: Item, info: DriveFileInfo | undefined): string {
  const kind = kindOf(item, info);
  const size =
    item.type === 'file' && info?.status === 'ready'
      ? ` · ${formatBytes(info.record.current.byteLength)}`
      : '';
  return `${kind}${size} · ${formatWhen(item.updatedAt)}`;
}

/** A file whose picture is a real thumbnail (an image), rather than a type icon. */
export function isImageRow(item: Item, info: DriveFileInfo | undefined): boolean {
  return (
    item.type === 'file' &&
    !item.hasChildren &&
    info?.status === 'ready' &&
    info.record.current.mediaType.startsWith('image/')
  );
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
