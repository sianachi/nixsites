import {
  Button,
  Duotone,
  Input,
  Text,
  blueprintFrame,
  cn,
  disabledState,
  focusRing,
} from '@nix/ui';
import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type ReactElement,
  type ReactNode,
} from 'react';

import { useOptionalApiClient } from '@nix/web-platform/api/api-client-provider';
import { isFetchableImageAddress } from '@nix/web-foundation/lib/image-address';
import { readPropertyText } from '../../core/container-model';

import {
  fileImageReference,
  fileImageReferenceItemId,
  isDisplayableImageValue,
} from './image-reference';
import { ValueShell, type ControlProps } from './shell';
import type { PropertyInputProps } from './types';
import { useFileImagePreview } from './use-file-image-preview';
import { useImageDrop } from './use-image-drop';
import { useImageUpload } from './use-image-upload';

/**
 * The picture property's control: a picker, not a text field.
 *
 * **Still an address underneath, by design.** There is no file or media model in this build, so
 * "choose a picture" means "hand over an address a browser may fetch" - typed, pasted, or read off
 * a dragged image or link. What changed from the plain url field is what is *shown*: the thing the
 * address is for. A property whose whole point is a picture, edited as a line of text, made
 * somebody open the gallery to find out whether the line they typed was the picture they meant.
 *
 * **Four states, told apart in words, mirroring the gallery card's ladder** (`CoverPane`): nothing
 * set - an address box and the sentence saying a link can be pasted or dragged in; a value
 * that is not a fetchable address - the box, prefilled, with the reason beside it, never handed to
 * an `img` (a schema retype does not revalidate stored values, so yesterday's text can be today's
 * picture property); set - the thumbnail through `<Duotone>`, the address, an edit affordance and a
 * remove control; failed - the words that say the fetch broke, with the address still shown,
 * because the property is not empty and telling somebody it was would send them re-entering an
 * address that is already right.
 *
 * **The failure is the address that failed, not a flag.** Same reasoning as the gallery: a boolean
 * would need a mirrored copy of the address to know when to clear. Stored as the URL, "failed" is
 * derived - a corrected address simply is not the failed one, so the state self-heals with nothing
 * to reconcile.
 *
 * **Validation mirrors `PropertyValidator.CheckImage` for immediacy; the server stays the
 * authority.** An invalid address is refused in place, with the server's own sentence shape, and
 * nothing is written - a client that wrote it anyway would show the refusal a round-trip later
 * against a field that has already moved on.
 *
 * **Self-contained rather than sharing `property-input.tsx`'s shells.** The shells wire a label to
 * exactly one control; the set state here is three - thumbnail, address, remove - and importing
 * them back would make the two files a cycle. The dependency stays one-way: the dispatch imports
 * this component, and this component imports only the props type, which compiles away.
 */

/** The sentence `PropertyValidator.CheckImage` refuses with, built the same way. */
function refusalSentence(label: string): string {
  return `${label} must be a link to an image, over http or https.`;
}

export function ImageValue(props: PropertyInputProps): ReactNode {
  const { item, property, onCommit, disabled = false, error = null } = props;
  const density = props.density === 'card' ? 'cell' : (props.density ?? 'panel');

  const stored = readPropertyText(item, property.key);
  const name =
    density === 'cell' ? `${property.label} for ${item.title || 'Untitled'}` : property.label;

  const [draft, setDraft] = useState(stored);
  const [sent, setSent] = useState(stored);
  const [seen, setSeen] = useState(stored);
  const [editing, setEditing] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  // Both optional, and for related reasons. A control drawn off a public form link genuinely has
  // no workspace to upload into (see `useOptionalWorkspace`); a control under test is very often
  // rendered as a bare leaf, with no provider tree above it at all. Either way the picker falls
  // back to address-only rather than throwing - exactly how it behaved before uploading existed.
  const client = useOptionalApiClient();
  const { canUpload, uploading, uploadFile } = useImageUpload({
    client,
    item,
    allowInputStorage: props.allowInputStorage !== false,
    onUploaded: (reference) => {
      commitReference(fileImageReference(reference));
    },
    onRefusal: setRefusal,
  });
  const uploadInputRef = useRef<HTMLInputElement>(null);

  // The address a Remove just cleared, kept until the next edit so the click has a way back.
  // Removing is one click and the address is gone from the panel entirely - nothing else on screen
  // still holds it - so without this the only recovery is remembering a URL nobody reads. Local
  // rather than the global undo toast: the thing to put back is this control's own previous value,
  // and it is meaningless anywhere else.
  const [removed, setRemoved] = useState<string | null>(null);

  const addressRef = useRef<HTMLButtonElement>(null);
  const fieldRef = useRef<HTMLInputElement>(null);
  const returnFocus = useRef(false);
  // Remove and Undo unmount the button that had focus; the control that replaces it gets it.
  const focusNext = useRef<'field' | 'address' | null>(null);

  // The same discipline as `create-item-control.tsx`, for the same reasons: the address box is
  // focused when it appears because it was asked for - `autoFocus` is forbidden by the
  // accessibility rules, rightly, and clicking the address only to have to find the field again
  // is the click half-done - and focus goes back to the address when the editor closes, which has
  // to wait for the render that puts the address back.
  useEffect(() => {
    if (!editing && returnFocus.current) {
      returnFocus.current = false;
      addressRef.current?.focus();
      return;
    }

    if (editing) {
      fieldRef.current?.focus();
    }
  }, [editing]);

  useEffect(() => {
    const target = focusNext.current === 'field' ? fieldRef.current : addressRef.current;
    if (focusNext.current !== null && target !== null) {
      focusNext.current = null;
      target.focus();
    }
  }, [stored]);

  // Replaced whenever the stored value moves, during render rather than in an effect, so no render
  // ever shows a draft - or an open editor, or a refusal - belonging to a value that is gone.
  if (stored !== seen) {
    setSeen(stored);
    setDraft(stored);
    setSent(stored);
    setEditing(false);
    setRefusal(null);
  }

  const fileItemId = fileImageReferenceItemId(stored);
  const isFileRef = fileItemId !== null;
  const filePreview = useFileImagePreview(client, fileItemId);
  const storedIsDisplayable = stored.length > 0 && isDisplayableImageValue(stored);
  const failed = isFileRef ? filePreview.status === 'error' : failedSrc === stored;
  const previewLoading = isFileRef && filePreview.status === 'loading';

  function commitReference(reference: string): void {
    // The same shape as a committed address below, minus the validation - a freshly uploaded
    // file's reference is trusted by construction, not by the address grammar.
    setRemoved(null);
    setDraft(reference);
    setSent(reference);
    setRefusal(null);
    returnFocus.current = editing;
    setEditing(false);
    onCommit(reference);
  }

  function tryCommit(text: string): void {
    const trimmed = text.trim();

    // The same edit is never written twice: Enter followed by the blur it causes is one edit, and
    // an editor closed over an unchanged address is not an edit at all.
    if (trimmed === sent) {
      setRefusal(null);
      if (storedIsDisplayable) {
        returnFocus.current = editing;
        setEditing(false);
      }
      return;
    }

    // Any edit at all ends the undo window: an Undo still offering the address removed two edits
    // ago is a trap. An unchanged blur is not an edit, so it leaves Undo alone.
    setRemoved(null);

    if (trimmed.length === 0) {
      setDraft('');
      setSent('');
      setRefusal(null);
      onCommit(null);
      return;
    }

    if (!isFetchableImageAddress(trimmed)) {
      // Refused here, in place, and nothing is written. Left on screen to be corrected rather
      // than silently cleared: the person entered something, and discarding it would not say so.
      setDraft(trimmed);
      setEditing(true);
      setRefusal(refusalSentence(property.label));
      return;
    }

    setDraft(trimmed);
    setSent(trimmed);
    setRefusal(null);
    returnFocus.current = editing;
    setEditing(false);
    onCommit(trimmed);
  }

  const { dropZone, droppingFrame } = useImageDrop({
    disabled,
    onAddress: tryCommit,
    onFile: (file) => {
      void uploadFile(file);
    },
  });

  const undoButton =
    removed === null ? null : (
      <Button
        variant="ghost"
        aria-label={`Undo removing ${name}`}
        disabled={disabled}
        onClick={() => {
          focusNext.current = 'address';
          setRemoved(null);
          setDraft(removed);
          setSent(removed);
          setRefusal(null);
          onCommit(removed);
        }}
      >
        Undo
      </Button>
    );

  // The address box: nothing stored yet, a stored value that is not an address (shown prefilled
  // with the reason, never handed to an img), or an edit somebody asked for.
  if (stored.length === 0 || !storedIsDisplayable || editing) {
    const shownError =
      error ??
      refusal ??
      (!storedIsDisplayable && stored.length > 0 ? refusalSentence(property.label) : null);

    return (
      <ValueShell
        {...props}
        density={density}
        error={shownError}
        hint={
          canUpload
            ? 'Paste or drag in a link to a picture, or choose one from this device.'
            : 'Paste or drag in a link to a picture.'
        }
      >
        {(control) => (
          // `gap-3` rather than the shell's own `gap-1`: the undo below carries an 8px vertical
          // hit-area extension, and a 12px gap leaves 4px of it clear of the address box above.
          <div className="flex flex-col gap-2">
            <Input
              {...control}
              type="url"
              tone={density === 'cell' ? 'plain' : 'default'}
              value={draft}
              required={property.required}
              disabled={disabled}
              ref={fieldRef}
              className={droppingFrame}
              onChange={(event) => {
                setDraft(event.target.value);
                setRefusal(null);
                setRemoved(null);
              }}
              onBlur={() => {
                tryCommit(draft);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  tryCommit(draft);
                }

                // A way out of an edit that keeps what is stored: without it, the only exits from
                // the editor are committing or blurring into a commit.
                if (event.key === 'Escape' && storedIsDisplayable) {
                  event.preventDefault();
                  setDraft(stored);
                  setRefusal(null);
                  returnFocus.current = editing;
                  setEditing(false);
                }
              }}
              onPaste={(event: ClipboardEvent<HTMLInputElement>) => {
                const text = event.clipboardData.getData('text/plain').trim();
                if (text.length === 0) {
                  return;
                }

                // A pasted address is a finished edit - nobody pastes half a URL and keeps typing
                // - so it commits on the paste rather than waiting for a blur.
                event.preventDefault();
                tryCommit(text);
              }}
              {...dropZone}
            />

            {canUpload ? (
              // The hidden input carries the real file picker; the button is what a screen reader
              // and a coarse pointer both get a sensible target for. `sr-only` rather than
              // `hidden`, because an actually-hidden input cannot receive the click the button
              // forwards to it on every platform Testing Library exercises.
              <div className="flex items-center gap-2">
                <input
                  ref={uploadInputRef}
                  type="file"
                  accept="image/*"
                  disabled={disabled || uploading}
                  className="sr-only"
                  aria-label={`Choose an image file for ${name}`}
                  onChange={(event: ChangeEvent<HTMLInputElement>) => {
                    const file = event.target.files?.[0] ?? null;
                    // Cleared immediately: choosing the same file twice in a row - after fixing
                    // and re-choosing it, say - must fire this `onChange` a second time, which a
                    // browser will not do while the input still holds that file.
                    event.target.value = '';
                    if (file !== null) void uploadFile(file);
                  }}
                />
                <Button
                  type="button"
                  variant="secondary"
                  disabled={disabled || uploading}
                  onClick={() => {
                    uploadInputRef.current?.click();
                  }}
                >
                  {uploading ? 'Uploading picture…' : 'Choose image'}
                </Button>
              </div>
            ) : null}

            {undoButton === null ? null : <div className="flex">{undoButton}</div>}
          </div>
        )}
      </ValueShell>
    );
  }

  const thumbnail = previewLoading ? (
    // The uploaded file's own resolution ("useFileImagePreview") is asynchronous even on a warm
    // cache - it goes through Core for a fresh capability every time - so there is a real gap
    // between "set" and "drawn" that an address never has once decoded. Words rather than nothing,
    // for the same reason the failed case below is words: an unframed gap here would be the empty
    // box the gallery's cover forbids for exactly this reason.
    <Text variant="note" as="span" role="status">
      Loading picture…
    </Text>
  ) : failed ? (
    // Never the empty state: this property has a value, it is the fetch that broke, and words are
    // the only rendering that says which. Keyed on the failing address, so correcting it heals.
    // `role="status"` because the fetch fails asynchronously, after the box has already been drawn
    // and read: without it the sentence replaces a picture nobody was told about. Polite rather
    // than an alert - nothing is broken that the person did, and the address is still there to
    // correct. Not muted either: this is the control failing, and a failure set quieter than the
    // address beside it reads as a caption. (The gallery's identical sentence stays silent on
    // purpose - forty of these announcing themselves across a grid is noise; this is one control
    // the person is standing in.)
    <Text variant="note" as="span" role="status">
      {isFileRef
        ? 'This picture could not be loaded.'
        : 'This picture could not be loaded. Check the address.'}
    </Text>
  ) : (
    <Duotone
      // Empty on purpose: the picture carries nothing the address beside it does not say, and a
      // non-empty alt on a failed img collapses the reserved box (see cover-image.tsx).
      alt=""
      src={isFileRef ? (filePreview.status === 'ready' ? filePreview.url : '') : stored}
      className="absolute inset-0 size-full object-cover"
      onError={() => {
        // A file reference's own failure is `filePreview.status === 'error'`, driven by the
        // upload hook rather than this `img`'s load event - see `failed` above - so only an
        // address's fetch needs recording here.
        if (!isFileRef) setFailedSrc(stored);
      }}
    />
  );

  // A file reference is not a sentence anybody typed - showing `nix-file:<id>` here would be the
  // control leaking its own storage format. The button still opens the same editor (a chosen file
  // can be swapped for another, or for a pasted address), so it keeps a label rather than going
  // blank.
  const addressLabel = isFileRef ? 'Uploaded picture' : stored;

  const addressButton = (control: ControlProps): ReactElement => (
    <button
      {...control}
      type="button"
      ref={addressRef}
      title={addressLabel}
      disabled={disabled}
      className={cn(
        'min-h-(--control-md) any-pointer-coarse:min-h-(--control-lg) min-w-0 flex-1 truncate text-left font-body text-sm text-foreground',
        focusRing,
        disabledState,
      )}
      onClick={() => {
        setEditing(true);
      }}
    >
      {addressLabel}
    </button>
  );

  const removeButton = (
    <Button
      variant="ghost"
      aria-label={`Remove ${name}`}
      disabled={disabled}
      onClick={() => {
        focusNext.current = 'field';
        // Kept so the click has a way back - see `removed`. Held before the write, because the
        // write is what takes the address off the screen.
        setRemoved(stored);

        // Null, because that is what the contract's merge reads as "clear this one".
        onCommit(null);
      }}
    >
      Remove
    </Button>
  );

  if (density === 'cell') {
    return (
      <ValueShell {...props} density={density} error={error ?? refusal}>
        {(control) => (
          <div {...dropZone} className={cn('flex items-center gap-3 px-2 py-1', droppingFrame)}>
            {failed ? (
              thumbnail
            ) : (
              // A reserved box, or a lazy thumbnail never enters the viewport and never loads.
              // A plain hairline rather than `blueprintFrame`: the frame's `rounded-md` is a
              // radius drawn for a card, and on a 24x40px cell it rounds most of the picture away.
              // The radius scale is meant to be sized to the box it turns.
              <span className="relative h-6 w-10 shrink-0 overflow-hidden rounded-sm border border-divider">
                {thumbnail}
              </span>
            )}
            {addressButton(control)}
            {undoButton ?? removeButton}
          </div>
        )}
      </ValueShell>
    );
  }

  return (
    <ValueShell {...props} density={density} error={error ?? refusal}>
      {(control) => (
        <div {...dropZone} className={cn('flex flex-col gap-2', droppingFrame)}>
          {/* One picture-shaped box for the thumbnail and for the words about it, so nothing
              reflows when a load fails - the same frame discipline as the gallery's CoverFrame. */}
          <div
            className={cn(
              blueprintFrame,
              'relative flex aspect-video w-full flex-col items-center justify-center gap-1 overflow-hidden p-3 text-center',
            )}
          >
            {thumbnail}
          </div>

          {/* `gap-3`, not `gap-2`: Remove's hit area reaches 4px past its word on each side, and
              12px of gap keeps that clear of the address button beside it. */}
          <div className="flex items-center gap-3">
            {addressButton(control)}
            {undoButton ?? removeButton}
          </div>
        </div>
      )}
    </ValueShell>
  );
}
