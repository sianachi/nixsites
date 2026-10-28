import { files as fileResources, type NixClient } from '@nix/api-client';
import { useState } from 'react';

import { isImageFile, mediaTypeForFile } from '@nix/web-foundation/lib/file-kind';
import { useOptionalWorkspace } from '@nix/web-workspaces/workspaces/workspace-context';
import type { PropertyOwner } from '../../views/core/container-model';

/**
 * What a dropped *file* is answered with when this control has nowhere to send it.
 *
 * Uploading needs a workspace to attach the file to (see {@link useOptionalWorkspace}), which a
 * control rendered off a public form link does not have. The drag paints the accent outline the
 * moment it hovers - that is `onDragOver`'s job, and it cannot know what the drag carries until the
 * drop - so staying silent would be the control lighting up and then doing nothing at all. The
 * sentence says what does work instead.
 */
const FILE_REFUSAL =
  'Pictures are added by address here. Drag in a link to a picture, or paste one.';

/** What a chosen or dropped file is refused with when it is not one this control can upload. */
const UNSUPPORTED_FILE_REFUSAL = 'Choose a PNG, JPEG, WebP or AVIF image no larger than 10 MiB.';

/**
 * The picture property's upload path: whether this control has somewhere to send a file, and the
 * one function that sends it. Refusals and the finished reference go back through the callbacks.
 */
export function useImageUpload({
  client,
  item,
  allowInputStorage,
  onUploaded,
  onRefusal,
}: {
  readonly client: NixClient | null;
  readonly item: PropertyOwner;
  readonly allowInputStorage: boolean;
  readonly onUploaded: (itemId: string) => void;
  readonly onRefusal: (refusal: string | null) => void;
}): {
  readonly canUpload: boolean;
  readonly uploading: boolean;
  readonly uploadFile: (file: File) => Promise<void>;
} {
  const [uploading, setUploading] = useState(false);
  const workspace = useOptionalWorkspace();
  const workspaceId = workspace?.workspaceId ?? null;

  // The item this value is uploaded to belong to, as a child - the same relationship a note gives
  // an image dropped into it. `PropertyOwner` only promises a title and properties, because a
  // draft not yet saved has neither an id nor a parent to upload into; every real item does, and
  // this reads it duck-typed rather than widening the shared interface for one caller's need.
  const ownerCandidate = (item as unknown as { readonly id?: unknown }).id;
  const ownerId = typeof ownerCandidate === 'string' ? ownerCandidate : null;

  const canUpload = allowInputStorage && workspaceId !== null && client !== null;

  async function uploadFile(file: File): Promise<void> {
    if (!canUpload) {
      onRefusal(FILE_REFUSAL);
      return;
    }
    if (uploading) return;

    if (!isImageFile(file)) {
      onRefusal(UNSUPPORTED_FILE_REFUSAL);
      return;
    }

    setUploading(true);
    onRefusal(null);
    try {
      const upload = await client.execute(
        fileResources.beginUpload({
          workspaceId,
          parentId: ownerId,
          fileName: file.name,
          mediaType: mediaTypeForFile(file),
          byteLength: file.size,
          idempotencyKey: `web-image-property:${crypto.randomUUID()}`,
        }),
      );
      const uploaded = await fileResources.uploadAndCompleteFile(client, upload, file);
      onUploaded(uploaded.itemId);
    } catch (cause) {
      onRefusal(cause instanceof Error ? cause.message : 'The image could not be uploaded.');
    } finally {
      setUploading(false);
    }
  }

  return { canUpload, uploading, uploadFile };
}
