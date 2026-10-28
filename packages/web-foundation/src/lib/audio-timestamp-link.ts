/**
 * The address a transcript's timestamps carry: a recording, and a moment in it.
 *
 * Written by the collaboration service as an ordinary link to the audio item with a `t` in
 * seconds, so it is still a working link anywhere the note is read. Inside the editor a click on
 * one is taken as "play from here" rather than as navigation.
 */

export interface AudioTimestamp {
  readonly workspaceId: string;
  readonly itemId: string;
  readonly seconds: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** Reads a timestamp address, or null for any other link. Only same-origin paths qualify. */
export function parseAudioTimestamp(href: string, origin: string): AudioTimestamp | null {
  let url: URL;
  try {
    url = new URL(href, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin) return null;
  const path = /^\/w\/([^/]+)\/?$/u.exec(url.pathname);
  const workspaceId = path?.[1] ?? '';
  const itemId = url.searchParams.get('item') ?? '';
  const raw = url.searchParams.get('t');
  if (raw === null || !/^\d{1,6}$/u.test(raw)) return null;
  if (!UUID.test(workspaceId) || !UUID.test(itemId)) return null;
  return { workspaceId, itemId, seconds: Number(raw) };
}
