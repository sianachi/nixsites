import { Text } from '@nix/ui';
import { lazy, Suspense, type ReactElement } from 'react';

import { bareMediaType, fileExtension, type FileViewerPlugin } from './file-viewer-registry';

/**
 * EPUB books.
 *
 * The reader and the unzip code behind it load only when a book is opened, so nobody pays for
 * them who never opens one. This file is the cheap part: how a book is recognised, and the
 * boundary the lazy chunk sits behind.
 */

const EpubReader = lazy(async () => {
  const module = await import('./epub-reader');
  return { default: module.EpubReader };
});

export function isEpubFile(fileName: string, mediaType: string): boolean {
  return bareMediaType(mediaType) === 'application/epub+zip' || fileExtension(fileName) === 'epub';
}

export function EpubViewer({
  fileName,
  blob,
  itemId,
}: {
  readonly fileName: string;
  readonly source: string;
  readonly blob?: Blob;
  readonly itemId?: string;
}): ReactElement {
  return (
    <Suspense
      fallback={
        <div className="flex min-w-0 flex-1 items-center justify-center p-2 sm:p-8">
          <Text variant="note" tone="muted" role="status">
            Opening the book…
          </Text>
        </div>
      }
    >
      <EpubReader fileName={fileName} blob={blob} itemId={itemId} />
    </Suspense>
  );
}

/**
 * A `url` viewer that reads the bytes from the `blob` the host also hands over: the application's
 * policy lets it fetch from its own origin and the object store, not from an object URL, so
 * `fetch(source)` would be refused.
 */
export const epubViewerPlugin: FileViewerPlugin = {
  id: 'nix.epub.viewer',
  matches: ({ fileName, mediaType }) => isEpubFile(fileName, mediaType),
  source: 'url',
  Component: EpubViewer,
};
