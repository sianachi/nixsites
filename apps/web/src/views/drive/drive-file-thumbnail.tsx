import type { ReactNode } from 'react';

import { FileThumbnail } from '../../thumbnails';
import type { Item } from '../../collections/core/container-model';
import type { DriveFileInfo } from './use-drive-file-info';

/**
 * A file row's or tile's picture, in a box that is the same size before and after the file's
 * record arrives.
 *
 * Until the record is here the file's title stands in for its name, which is enough to choose a
 * glyph and never enough to ask for a picture: `hasServerThumbnail` is false, so no request is made
 * for it. Once it is here the record says whether a server thumbnail exists, and a file without
 * one costs nothing further. A record that failed to load stays on the glyph.
 */
export function DriveFileThumbnail({
  item,
  info,
  className,
  iconSize,
}: {
  readonly item: Item;
  readonly info: DriveFileInfo | undefined;
  readonly className: string;
  readonly iconSize: 'sm' | 'lg';
}): ReactNode {
  if (info?.status !== 'ready') {
    return (
      <FileThumbnail
        itemId={item.id}
        fileName={item.title}
        mediaType=""
        version={null}
        hasServerThumbnail={false}
        className={className}
        iconSize={iconSize}
      />
    );
  }
  const { current } = info.record;
  return (
    <FileThumbnail
      itemId={item.id}
      fileName={current.fileName}
      mediaType={current.mediaType}
      version={current.id}
      hasServerThumbnail={current.thumbnail !== null}
      byteLength={current.byteLength}
      className={className}
      iconSize={iconSize}
    />
  );
}
