import { files as fileResources, isNixApiError } from '@nix/api-client';
import { useEffect, useState } from 'react';

import { useApiClient } from '@nix/web-platform/api/api-client-provider';
import { loadServerThumbnail } from './server-thumbnail';
import { usePdfThumbnail, type PdfThumbnailStatus } from './use-pdf-thumbnail';

/** The same five words as the PDF renderer's, so a card draws one set of states for any source. */
export type FileThumbnailStatus = PdfThumbnailStatus;

export interface FileThumbnailResult {
  readonly status: FileThumbnailStatus;
  readonly url: string | null;
}

export type FileThumbnailKind = 'image' | 'audio' | 'epub' | 'pdf' | 'other';

/**
 * A PDF this large is not worth downloading for a picture the size of a postage stamp. Below the
 * renderer's own ceiling on purpose: that one protects the tab, this one protects the connection.
 */
export const PDF_THUMBNAIL_BYTE_CEILING = 25 * 1024 * 1024;

// The kinds the worker makes a thumbnail for, beyond PDFs which the browser draws itself:
// uploaded raster images, the cover art embedded in audio, and an EPUB's cover.
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
const AUDIO_EXTENSIONS = new Set(['.mp3', '.flac', '.m4a']);
const IMAGE_MEDIA_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/bmp',
]);
const AUDIO_MEDIA_TYPES = new Set([
  'audio/mpeg',
  'audio/mp3',
  'audio/flac',
  'audio/x-flac',
  'audio/mp4',
  'audio/x-m4a',
  'audio/m4a',
]);

function extensionOf(fileName: string): string {
  const name = fileName.trim().toLowerCase();
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot);
}

/** What a file is, from its media type and failing that its extension. Either may be empty. */
export function fileThumbnailKind(fileName: string, mediaType: string): FileThumbnailKind {
  const type = mediaType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  const extension = extensionOf(fileName);
  if (type === 'application/pdf' || extension === '.pdf') return 'pdf';
  if (type === 'application/epub+zip' || extension === '.epub') return 'epub';
  if (IMAGE_MEDIA_TYPES.has(type) || IMAGE_EXTENSIONS.has(extension)) return 'image';
  if (AUDIO_MEDIA_TYPES.has(type) || AUDIO_EXTENSIONS.has(extension)) return 'audio';
  return 'other';
}

type Source = 'server' | 'pdf' | 'none';

export interface UseFileThumbnailOptions {
  readonly itemId: string;
  readonly fileName: string;
  readonly mediaType: string;

  /**
   * Anything that changes when the file does - a version id, say. Null when the caller cannot
   * say (the gallery has no file records): the picture is then fetched afresh each time rather
   * than kept on this device, because a kept one could outlive a replaced file.
   */
  readonly version: string | null;

  /**
   * True when the file's record says the current version has a server thumbnail, false when it
   * says it does not, undefined when the caller has no record and the answer has to be asked for.
   */
  readonly hasServerThumbnail: boolean | undefined;

  /** The file's size when the caller knows it. A PDF is only drawn when it is known and small. */
  readonly byteLength?: number;

  /** Hold false until the card is on screen; it should latch. */
  readonly enabled: boolean;
}

function chooseSource(options: UseFileThumbnailOptions): Source {
  const { fileName, mediaType, version, hasServerThumbnail, byteLength } = options;
  if (hasServerThumbnail === true) return 'server';
  const kind = fileThumbnailKind(fileName, mediaType);
  if (kind === 'pdf') {
    // An unknown size is as good as a large one: the whole file would be downloaded to find out.
    // And a PDF's picture is kept under its version, so one without a version is not drawn.
    return version !== null && byteLength !== undefined && byteLength <= PDF_THUMBNAIL_BYTE_CEILING
      ? 'pdf'
      : 'none';
  }
  if (
    hasServerThumbnail === undefined &&
    (kind === 'image' || kind === 'audio' || kind === 'epub')
  ) {
    return 'server';
  }
  return 'none';
}

interface ServerOutcome {
  /** Which request this answers, so an answer to an old one is never shown for a new. */
  readonly token: string;
  readonly status: 'ready' | 'none' | 'error';
  readonly url: string | null;
}

/**
 * Where a card's picture comes from, and how far along it is.
 *
 * **Three sources, one answer.** The worker's stored JPEG for images, cover art and EPUBs; the
 * browser's own drawing of a PDF's first page; or nothing, in which case the caller shows a
 * type glyph. Which one is decided from what the caller knows, and a file that cannot have a
 * thumbnail never costs a request.
 *
 * **An `<img>` cannot be handed the signed URL.** The page's policy allows `blob:` and `data:`
 * images but the object store's origin is only a `connect-src`, so the JPEG is fetched like any
 * other capability download and shown from an object URL - the way a cover picture is (see
 * `views/gallery/cover-image.tsx`). The URL is revoked when the file or the card goes. Core is
 * asked for the capability on every mount; the bytes behind it are downloaded once per tab (see
 * `server-thumbnail.ts`).
 *
 * **A 404 is an answer, not a failure.** Core says `files.thumbnail_not_found` alike for a file
 * with no thumbnail, an unreadable one and a locked one, and none of those is worth an error:
 * the status is `none` and nothing is logged.
 */
export function useFileThumbnail(options: UseFileThumbnailOptions): FileThumbnailResult {
  const { itemId, version, enabled } = options;
  const client = useApiClient();
  const source = chooseSource(options);
  const [outcome, setOutcome] = useState<ServerOutcome | null>(null);

  const token = `${itemId}\n${version ?? ''}`;

  useEffect(() => {
    if (!enabled || source !== 'server') return;
    const controller = new AbortController();
    const { signal } = controller;
    let objectUrl: string | null = null;

    const settle = (status: ServerOutcome['status'], blob: Blob | null) => {
      if (signal.aborted) return;
      if (blob !== null) objectUrl = URL.createObjectURL(blob);
      setOutcome({ token, status, url: objectUrl });
    };

    void (async () => {
      try {
        const blob = await loadServerThumbnail(client, itemId, signal);
        settle('ready', blob);
      } catch (error) {
        if (signal.aborted) return;
        settle(isNixApiError(error) && error.status === 404 ? 'none' : 'error', null);
      }
    })();

    return () => {
      controller.abort();
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
    };
  }, [client, itemId, version, enabled, source, token]);

  const pdf = usePdfThumbnail({
    itemId,
    version: version ?? '',
    enabled: enabled && source === 'pdf',
    load: (signal) =>
      fileResources.fetchFileContent(client, itemId, undefined, true, signal).then((r) => r.blob),
  });

  if (source === 'none') return { status: 'none', url: null };
  if (source === 'pdf') return pdf;
  if (!enabled) return { status: 'idle', url: null };
  if (outcome?.token !== token) return { status: 'loading', url: null };
  return { status: outcome.status, url: outcome.url };
}
