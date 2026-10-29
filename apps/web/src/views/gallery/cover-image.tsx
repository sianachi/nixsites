import { Duotone } from '@nix/ui';
import { useEffect, type ReactNode } from 'react';

import { useApiClient } from '@nix/web-platform/api/api-client-provider';
import { fileImageReferenceItemId } from '../../collections/properties/inputs/image-reference';
import { useFileImagePreview } from '../../collections/properties/inputs/use-file-image-preview';
import { useFileThumbnail } from '../../collections/thumbnails';

/**
 * The one place a cover picture is drawn.
 *
 * **Covers go through `<Duotone>`**, which is the design grammar's answer for any image
 * (AGENTS.md, styling rules): it maps the picture's luminance onto two token colours so a wall of
 * arbitrary photographs reads as one surface rather than as somebody's camera roll. This file
 * existed first as a seam - a plain `<img>` with exactly Duotone's interface - because the two were
 * built in parallel and the treatment did not exist yet. It now forwards to the real thing, and the
 * props did not have to move.
 *
 * **A component rather than an `<img>` inlined in the card**, so that seam is one place. A gallery
 * that wrote its own picture per state would have three by the time the covers, their failures and
 * their empty case were all drawn, and this swap would have been three edits with two chances to
 * leave one behind.
 *
 * **What moved off this file and into Duotone**, because they belong to whatever renders a picture
 * rather than to the gallery: `referrerPolicy="no-referrer"` - a privacy boundary and not a nicety,
 * since a cover URL is arbitrary third-party and without it every reader's browser announces a
 * workspace address carrying the item id to a host nobody here controls or can audit - along with
 * `decoding="async"` and the lazy default. Duotone sets all three and its own tests hold them, so
 * this file no longer restates them.
 *
 * **`src` is not always a web address.** A cover set from a chosen or dropped file - see
 * `properties/image-value.tsx` - stores a reference to an uploaded file item rather than an
 * address, because there is no public URL for one (AGENTS.md: files use capability URLs, never
 * Core bytes). This is the one place that reference is resolved to something `<Duotone>` can
 * fetch: a local object URL. The gallery card above stays unaware of which kind of value it is
 * passing down.
 *
 * **An uploaded cover is drawn from its stored thumbnail, not from the file.** A wall of cards
 * that each downloaded an original photograph to fill a frame a few hundred pixels wide was the
 * slowest thing a gallery did. The thumbnail is a small JPEG the worker already made, behind the
 * same Core authorisation as the file. The original is fetched only where it is needed: when the
 * file has no thumbnail (a vector image, or one the worker has not reached yet), and behind the
 * thumbnail when the caller says the frame is larger than a thumbnail can fill sharply.
 */

export interface CoverImageProps {
  readonly src: string;

  /**
   * What a screen reader is told the picture is.
   *
   * Callers in this build pass the empty string - see the gallery card for why that is the correct
   * value there and not an oversight - but the prop is required rather than optional so that a
   * caller has to make the decision rather than inherit it by forgetting.
   */
  readonly alt: string;

  readonly className?: string;

  /**
   * Called when the picture cannot be fetched or decoded.
   *
   * **Required here, though Duotone types it optional.** A failed image with a non-empty `alt`
   * stops being a replaced element, so the caller's sizing is discarded and the box collapses to
   * the width of the alt text - which in a grid reflows every card around it. The gallery's answer
   * is to replace the frame rather than let a broken one sit in the layout, and it can only do that
   * if it is told. A caller that does not care what failure looks like has not thought about it.
   */
  readonly onError: () => void;

  readonly loading?: 'lazy' | 'eager';

  /**
   * True when the frame is wide enough that a stored thumbnail would look soft in it. An uploaded
   * cover then still appears from its thumbnail at once, and is replaced by the original when
   * that arrives. Nothing changes for a web address, which has only the one picture.
   */
  readonly sharp?: boolean;
}

export function CoverImage({
  src,
  alt,
  className,
  onError,
  loading = 'lazy',
  sharp = false,
}: CoverImageProps): ReactNode {
  const client = useApiClient();
  const fileItemId = fileImageReferenceItemId(src);
  const thumbnail = useFileThumbnail({
    itemId: fileItemId ?? '',
    // A reference carries no name or type, and none is needed: saying the thumbnail exists is
    // what makes the hook ask, and Core's 404 is the answer when it does not.
    fileName: '',
    mediaType: '',
    version: null,
    hasServerThumbnail: true,
    enabled: fileItemId !== null,
  });
  const thumbnailMissing = thumbnail.status === 'none' || thumbnail.status === 'error';
  const original = useFileImagePreview(
    client,
    // The original waits for the thumbnail to settle, even in a frame that wants it: a wall of
    // large cards that started every original at once would slow the very thumbnails meant to
    // fill it first.
    fileItemId !== null && (thumbnailMissing || (sharp && thumbnail.status === 'ready'))
      ? fileItemId
      : null,
  );
  const url =
    original.status === 'ready'
      ? original.url
      : thumbnail.status === 'ready'
        ? thumbnail.url
        : null;
  // Failed only when neither picture can be had. The original's status is `error` whenever it
  // was not asked for, so it counts only once the thumbnail has itself come back without one.
  const failed = fileItemId !== null && thumbnailMissing && original.status === 'error';

  // A file reference's failure comes from the fetches above rather than from an `img` load event,
  // so it has no `onError` of its own to fire - this is what tells the caller instead. Effect
  // rather than inline, because rendering must not have side effects, and this one updates state
  // one level up (`failedCovers` in `gallery-view.tsx`).
  useEffect(() => {
    if (failed) onError();
  }, [failed, onError]);

  if (fileItemId !== null) {
    // Loading and error both draw nothing here: the frame around this component - `CoverFrame` in
    // `gallery-view.tsx` - is what reserves the space and, once `onError` above has run, what
    // switches to the words explaining why.
    if (url === null) return null;
    return (
      <Duotone
        src={url}
        alt={alt}
        loading={loading}
        onError={onError}
        {...(className === undefined ? {} : { className })}
      />
    );
  }

  // `className` is spread rather than passed, because under `exactOptionalPropertyTypes` an
  // optional prop is either given or not given: handing it an explicit `undefined` is a different
  // thing from omitting it, and Duotone declares it optional. The same idiom appears on the list
  // view's `sort`.
  return (
    <Duotone
      src={src}
      alt={alt}
      loading={loading}
      onError={onError}
      {...(className === undefined ? {} : { className })}
    />
  );
}
