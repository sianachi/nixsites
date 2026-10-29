import { files as fileResources, type NixClient } from '@nix/api-client';

import {
  authorisedBytesGeneration,
  recallAuthorisedBytes,
  rememberAuthorisedBytes,
} from '@nix/web-foundation/lib/thumbnail-cache';

/**
 * A file's stored thumbnail, as bytes.
 *
 * **Core is asked every time.** A thumbnail contains body data, so the capability is requested
 * afresh on each call, including after a lock or membership change; a device cache must never
 * substitute for that decision. Only once Core has answered, and named the object, are bytes this
 * tab already downloaded for that same object reused instead of fetched again - which is what
 * makes a revisited folder one round trip per picture rather than two.
 *
 * Rejects with Core's own error when it refuses (a 404 covers no thumbnail, unreadable and locked
 * alike), and with a plain error when the capability or the download is not usable.
 */
export async function loadServerThumbnail(
  client: NixClient,
  itemId: string,
  signal: AbortSignal,
): Promise<Blob> {
  // Include the authorization round trip: a sign-out can occur while Core is answering too.
  const generation = authorisedBytesGeneration();
  const capability = await client.query(fileResources.thumbnailFile(itemId), {
    signal,
    forceRefresh: true,
  });
  const url = new URL(capability.url);
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    throw new TypeError('Thumbnail capabilities must use HTTPS outside local development.');
  }
  if (url.username !== '' || url.password !== '') {
    throw new TypeError('Thumbnail capabilities cannot contain URL credentials.');
  }
  // The signature and expiry change on every capability; the object they sign does not. Leaving
  // the query out is safe only because the path alone names the object: Core signs path-style
  // URLs whose key is `files/thumbnails/{tenant}/{version}.jpg` (`ObjectStorageKeys.FileThumbnail`),
  // so it is unique per tenant and per file version. A signer that moved identity into the host
  // or the query would need this key to follow it.
  const objectAddress = `${url.origin}${url.pathname}`;
  const held = recallAuthorisedBytes(objectAddress);
  if (held !== null) return held;
  const response = await fetch(url, { signal, credentials: 'omit', redirect: 'error' });
  if (!response.ok) throw new Error('The thumbnail download failed.');
  const blob = await response.blob();
  // Not kept if a sign-out cleared the tab while this was in flight.
  rememberAuthorisedBytes(objectAddress, blob, generation);
  return blob;
}
