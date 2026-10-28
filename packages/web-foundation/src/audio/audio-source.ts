import { files as fileResources, type NixClient } from '@nix/api-client';

/**
 * A fresh, authorised address for an audio file's bytes, for the `<audio>` element to stream from.
 *
 * The same capability the file page's download uses, with the same refusals - HTTPS outside
 * loopback, no credentials in the URL - but handed to the element as an address instead of being
 * fetched into a blob, so the browser can ask the object store for ranges. Always `forceRefresh`:
 * a cached capability is exactly the expired address this is asked for in order to replace.
 */
export async function authorisedAudioUrl(
  client: NixClient,
  itemId: string,
  signal?: AbortSignal,
): Promise<string> {
  const capability = await client.query(fileResources.downloadFile(itemId, undefined, true), {
    signal,
    forceRefresh: true,
  });
  const url = new URL(capability.url);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new TypeError('Download capabilities must use HTTPS outside local development.');
  }
  if (url.username !== '' || url.password !== '') {
    throw new TypeError('Download capabilities cannot contain URL credentials.');
  }
  return url.toString();
}
