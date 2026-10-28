import { isAllowedLinkAddress } from '@nix/editor-schema';
import { Button, Dialog, Field, Input, Text } from '@nix/ui';
import { useEffect, useRef, useState, type ReactNode, type SyntheticEvent } from 'react';
import { z } from 'zod';

import { imageAddressSchema } from '@nix/web-foundation/lib/image-address';
import { isImageFile } from '@nix/web-foundation/lib/file-kind';

/** Which editor command is waiting for an address. */
export type EditorAddressKind = 'image' | 'link';

/** What the form hands back to the editor after validation. */
export interface EditorAddressValue {
  readonly address: string;
  readonly description: string;
}

export interface EditorAddressDialogProps {
  readonly kind: EditorAddressKind;
  readonly onCancel: () => void;
  readonly onSubmit: (value: EditorAddressValue) => void;
  readonly onExistingImage?: (() => void) | undefined;
  readonly onUploadImage?: ((file: File, description: string) => Promise<void>) | undefined;
}

const linkAddressSchema = z
  .string()
  .trim()
  .min(1, 'Enter a link address.')
  .refine(
    isAllowedLinkAddress,
    'Enter a relative link or an address that uses a supported protocol.',
  );

/**
 * The editor's honest address boundary.
 *
 * A modal keeps the selection in the document while making room for a labelled address field,
 * validation, and alternative text when the address is for an image. It shows a file picker only
 * when the caller can persist local media. URL insertion remains available for images that already
 * live elsewhere, while the local path uses the same durable file model as a dropped attachment.
 */
export function EditorAddressDialog({
  kind,
  onCancel,
  onSubmit,
  onUploadImage,
  onExistingImage,
}: EditorAddressDialogProps): ReactNode {
  const addressRef = useRef<HTMLInputElement>(null);
  const [address, setAddress] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const uploadRef = useRef<HTMLInputElement>(null);

  const [method, setMethod] = useState<'upload' | 'url'>(
    onUploadImage === undefined ? 'url' : 'upload',
  );
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  // Anything typed or chosen here is unsaved until the form submits, and a description alone -
  // with no address yet - is still real typing worth protecting.
  const dirty = address.trim() !== '' || description.trim() !== '' || file !== null;
  useEffect(() => {
    if (file === null || !isImageFile(file) || file.size > 10 * 1024 * 1024) return;
    const url = URL.createObjectURL(file);
    let active = true;
    queueMicrotask(() => {
      if (active) setPreview(url);
    });
    return () => {
      active = false;
      URL.revokeObjectURL(url);
    };
  }, [file]);
  const image = kind === 'image';
  const canUploadImage = image && onUploadImage !== undefined;
  const title = image ? 'Insert image' : 'Add link';
  const addressLabel = image ? 'Image address' : 'Link address';
  const addressHint = image
    ? canUploadImage
      ? 'Paste a complete http or https address, or choose a local image below.'
      : 'Paste a complete http or https address.'
    : 'Paste or type where this link should go.';
  const submitLabel =
    canUploadImage && method === 'upload' && uploading
      ? 'Uploading image…'
      : image
        ? 'Insert image'
        : 'Add link';

  function submit(event: SyntheticEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (uploading) return;
    if (canUploadImage && method === 'upload') {
      void uploadImage();
      return;
    }

    const parsed = (image ? imageAddressSchema : linkAddressSchema).safeParse(address);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Enter a valid address.');
      addressRef.current?.focus();
      return;
    }

    try {
      onSubmit({ address: parsed.data, description: image ? description.trim() : '' });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The content could not be inserted.');
    }
  }

  async function uploadImage(): Promise<void> {
    if (uploading) return;
    const file = uploadRef.current?.files?.[0];
    if (file === undefined) {
      setError('Choose an image to upload.');
      return;
    }
    if (!isImageFile(file)) {
      setError('Choose a PNG, JPEG, WebP or AVIF image no larger than 10 MiB.');
      return;
    }
    if (onUploadImage === undefined) return;
    setUploading(true);
    setError(null);
    try {
      await onUploadImage(file, description.trim());
      onCancel();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The image could not be uploaded.');
    } finally {
      setUploading(false);
    }
  }

  return (
    <Dialog
      open
      title={title}
      onClose={onCancel}
      closeLabel={`Cancel ${image ? 'image insertion' : 'link creation'}`}
      initialFocus={canUploadImage && method === 'upload' ? uploadRef : addressRef}
      dirty={dirty}
    >
      <form noValidate onSubmit={submit} className="flex flex-col gap-4">
        {canUploadImage ? (
          <div className="flex flex-wrap gap-2" role="group" aria-label="Image source">
            <Button
              type="button"
              variant="secondary"
              aria-pressed={method === 'upload'}
              onClick={() => {
                setMethod('upload');
              }}
            >
              Upload
            </Button>
            {onExistingImage !== undefined ? (
              <Button type="button" variant="secondary" onClick={onExistingImage}>
                Existing attachment
              </Button>
            ) : null}
            <Button
              type="button"
              variant="secondary"
              aria-pressed={method === 'url'}
              onClick={() => {
                setMethod('url');
              }}
            >
              Image URL
            </Button>
          </div>
        ) : null}
        {!canUploadImage || method === 'url' ? (
          <Field label={addressLabel} required={!canUploadImage} hint={addressHint} error={error}>
            {(control) => (
              <Input
                {...control}
                ref={addressRef}
                type="url"
                inputMode="url"
                autoComplete="url"
                required={!canUploadImage}
                disabled={uploading}
                value={address}
                onChange={(event) => {
                  setAddress(event.target.value);
                  setError(null);
                }}
              />
            )}
          </Field>
        ) : null}

        {image ? (
          <Field
            label="Description"
            hint="Describe what the image shows. Leave this blank only when the image is decorative."
          >
            {(control) => (
              <Input
                {...control}
                value={description}
                disabled={uploading}
                onChange={(event) => {
                  setDescription(event.target.value);
                }}
              />
            )}
          </Field>
        ) : null}

        {canUploadImage && method === 'upload' ? (
          // Choosing a file is all that happens here - the form's own submit button below
          // starts the upload, so a second "Upload image" button beside the file picker would
          // do exactly the same thing under a different name.
          <Input
            ref={uploadRef}
            type="file"
            accept="image/*"
            disabled={uploading}
            aria-label="Choose image to upload"
            onChange={(event) => {
              setFile(event.target.files?.[0] ?? null);
              setPreview(null);
              setError(null);
            }}
          />
        ) : null}

        {canUploadImage && method === 'upload' && preview !== null ? (
          <img src={preview} alt={description} className="max-h-48 max-w-full object-contain" />
        ) : null}
        {error !== null && canUploadImage && method === 'upload' ? (
          <Text variant="note" role="alert">
            {error}
          </Text>
        ) : null}
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" disabled={uploading}>
            {submitLabel}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
