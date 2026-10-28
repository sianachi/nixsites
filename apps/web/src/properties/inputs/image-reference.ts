import { isFetchableImageAddress } from '@nix/web-foundation/lib/image-address';

/**
 * The prefix marking a stored value as a reference to a file uploaded through this control,
 * rather than a web address.
 *
 * There is still no media model as such - a picture property is one string - but that string can
 * now name either kind of thing it is for. The prefix is not itself a valid URL scheme, so it can
 * never collide with an address somebody pasted.
 */
// Core's PropertyValidator.CheckImage accepts exactly this prefix followed by a GUID; a change
// here that it does not also make is refused at write time, with no compile-time signal.
const FILE_IMAGE_PREFIX = 'nix-file:';

/** Whether a stored value points at a file this control uploaded, rather than a web address. */
export function isFileImageReference(value: string): boolean {
  return value.startsWith(FILE_IMAGE_PREFIX) && value.length > FILE_IMAGE_PREFIX.length;
}

/** The uploaded file's item id, for a value {@link isFileImageReference} accepts; null otherwise. */
export function fileImageReferenceItemId(value: string): string | null {
  return isFileImageReference(value) ? value.slice(FILE_IMAGE_PREFIX.length) : null;
}

/** The value to store for a newly uploaded file. */
export function fileImageReference(itemId: string): string {
  return `${FILE_IMAGE_PREFIX}${itemId}`;
}

/**
 * Whether a stored value is something a picture surface can show: a fetchable web address, or an
 * uploaded file's reference. Shared with the gallery's cover, which draws the same four states off
 * the same rule.
 */
export function isDisplayableImageValue(value: string): boolean {
  return isFetchableImageAddress(value) || isFileImageReference(value);
}
