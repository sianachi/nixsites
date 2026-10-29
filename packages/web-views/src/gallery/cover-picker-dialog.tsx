import { Button, Dialog, Field, Input, Text } from '@nix/ui';
import { useRef, useState, type ChangeEvent, type ReactNode, type SyntheticEvent } from 'react';

import { isImageFile } from '@nix/web-foundation/lib/file-kind';
import { isFetchableImageAddress } from '@nix/web-foundation/lib/image-address';

export interface CoverPickerDialogProps {
  /** Named in the dialog's own title, so a grid of identical "Set cover" buttons is never opened
   * on the wrong card by mistake. */
  readonly itemTitle: string;

  /** Whether this card already has a cover to remove. */
  readonly hasCover: boolean;

  /** False off a context with nowhere to upload to - see the gallery's own `canUpload`. */
  readonly canUpload: boolean;

  readonly onClose: () => void;
  readonly onUpload: (file: File) => Promise<void>;
  readonly onSetAddress: (address: string) => Promise<void>;
  readonly onRemove: () => Promise<void>;
}

/**
 * The gallery card's own cover source: upload a picture, paste an address, or take the cover off.
 *
 * One dialog rather than three separate affordances, because all three end up writing the same
 * property - the difference is only where the value comes from - and a card that offered three
 * corner buttons for one decision would be a worse "easy way to put images on grids" than the one
 * this exists to answer. Shaped after the editor's own `EditorAddressDialog`, but without its
 * description field (a cover's alt text is always empty - see `cover-image.tsx`) and with the one
 * thing that dialog has no use for: taking a cover off.
 */
export function CoverPickerDialog({
  itemTitle,
  hasCover,
  canUpload,
  onClose,
  onUpload,
  onSetAddress,
  onRemove,
}: CoverPickerDialogProps): ReactNode {
  const [method, setMethod] = useState<'upload' | 'url'>(canUpload ? 'upload' : 'url');
  const [address, setAddress] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const addressRef = useRef<HTMLInputElement>(null);
  // A typed address is the only thing here a dismissal could silently discard - an upload commits
  // as soon as a file is chosen, with nothing left typed in the dialog afterward.
  const dirty = address.trim() !== '';

  async function pickFile(file: File): Promise<void> {
    if (busy) return;

    if (!isImageFile(file)) {
      setError('Choose a PNG, JPEG, WebP or AVIF image no larger than 10 MiB.');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await onUpload(file);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That picture could not be uploaded.');
    } finally {
      setBusy(false);
    }
  }

  async function submitAddress(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy) return;

    const trimmed = address.trim();
    if (!isFetchableImageAddress(trimmed)) {
      setError('Enter a complete image address that starts with http:// or https://.');
      addressRef.current?.focus();
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await onSetAddress(trimmed);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That cover could not be saved.');
    } finally {
      setBusy(false);
    }
  }

  async function remove(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onRemove();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The cover could not be removed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      title={`Cover for "${itemTitle || 'Untitled'}"`}
      onClose={onClose}
      closeLabel="Cancel choosing a cover"
      dirty={dirty}
    >
      <div className="flex flex-col gap-4">
        {canUpload ? (
          <div className="flex flex-wrap gap-2" role="group" aria-label="Cover source">
            <Button
              type="button"
              variant="secondary"
              aria-pressed={method === 'upload'}
              disabled={busy}
              onClick={() => {
                setMethod('upload');
                setError(null);
              }}
            >
              Upload
            </Button>
            <Button
              type="button"
              variant="secondary"
              aria-pressed={method === 'url'}
              disabled={busy}
              onClick={() => {
                setMethod('url');
                setError(null);
              }}
            >
              Image URL
            </Button>
          </div>
        ) : null}

        {canUpload && method === 'upload' ? (
          <div className="flex flex-col gap-2">
            <Field
              label="Image file"
              hint="PNG, JPEG, WebP or AVIF, no larger than 10 MiB."
              error={error}
            >
              {(control) => (
                <input
                  {...control}
                  type="file"
                  accept="image/*"
                  disabled={busy}
                  onChange={(event: ChangeEvent<HTMLInputElement>) => {
                    const file = event.target.files?.[0] ?? null;
                    // Cleared so choosing the same file again - after fixing what made it fail,
                    // say - still fires this handler; a browser will not repeat `onChange` for a
                    // file the input already holds.
                    event.target.value = '';
                    if (file !== null) void pickFile(file);
                  }}
                />
              )}
            </Field>
            {busy ? (
              <Text variant="note" tone="muted" role="status">
                Uploading…
              </Text>
            ) : null}
          </div>
        ) : (
          <form
            noValidate
            onSubmit={(event) => {
              void submitAddress(event);
            }}
            className="flex flex-col gap-3"
          >
            <Field
              label="Image address"
              hint="Paste a complete http or https address."
              error={error}
            >
              {(control) => (
                <Input
                  {...control}
                  ref={addressRef}
                  type="url"
                  inputMode="url"
                  autoComplete="url"
                  required
                  disabled={busy}
                  value={address}
                  onChange={(event) => {
                    setAddress(event.target.value);
                    setError(null);
                  }}
                />
              )}
            </Field>
            <div className="flex justify-end gap-2">
              <Button type="submit" disabled={busy}>
                {busy ? 'Saving…' : 'Set cover'}
              </Button>
            </div>
          </form>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2">
          {hasCover ? (
            <Button
              type="button"
              variant="secondary"
              disabled={busy}
              onClick={() => {
                void remove();
              }}
            >
              Remove cover
            </Button>
          ) : (
            <span />
          )}
          <Button type="button" variant="secondary" disabled={busy} onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
