import { files as fileResources, type NixClient } from '@nix/api-client';
import { useState, useEffect } from 'react';

/** What an uploaded file's picture resolves to, once its item id is known. */
export type FileImagePreview =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly url: string }
  | { readonly status: 'error' };

/**
 * Resolves an uploaded file's item id to a browser-usable address.
 *
 * There is no public URL for a file item - every download goes through a signed, short-lived
 * capability (AGENTS.md: files use capability URLs, never Core bytes) - so this fetches the bytes
 * once through that capability and hands back a local object URL, the same resolution the note
 * editor's own image view does for its `fileItemId` attribute (`editor/note-image-view.tsx`). The
 * object URL is revoked the moment the id it was minted for is no longer wanted, on id change and
 * on unmount.
 */
export function useFileImagePreview(
  client: NixClient | null,
  fileItemId: string | null,
): FileImagePreview {
  const [preview, setPreview] = useState<
    | { readonly itemId: string; readonly status: 'ready'; readonly url: string }
    | { readonly itemId: string; readonly status: 'error' }
    | null
  >(null);

  useEffect(() => {
    // No client to fetch through - the same leaf-render case `useOptionalApiClient` exists for -
    // leaves this loading forever rather than erroring, which is the honest answer for a state
    // this build cannot actually resolve either way.
    if (fileItemId === null || client === null) return;
    const controller = new AbortController();
    let objectUrl: string | null = null;
    fileResources
      .fetchFileContent(client, fileItemId, undefined, true, controller.signal)
      .then(({ blob }) => {
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setPreview({ itemId: fileItemId, status: 'ready', url: objectUrl });
      })
      .catch(() => {
        if (!controller.signal.aborted) setPreview({ itemId: fileItemId, status: 'error' });
      });
    return () => {
      controller.abort();
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
    };
  }, [client, fileItemId]);

  if (fileItemId === null) return { status: 'error' };
  if (preview?.itemId !== fileItemId) return { status: 'loading' };
  return preview;
}
