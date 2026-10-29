import { propertyTypeLabel } from '../../collections/core/property-types';
import type { ContainerData } from '../../collections/core/use-container';
import type { PropertyDefinition, View } from '../../collections/core/container-model';

/**
 * What this gallery's cover column is, or why it has none - as data rather than as flags read in
 * four places.
 *
 * `none` and the two broken cases draw the same card, and are deliberately not the same value:
 * only the broken ones earn a notice, and "nobody asked for covers" must never produce one.
 */
export type Cover =
  | { readonly kind: 'ready'; readonly property: PropertyDefinition }
  | { readonly kind: 'none' }
  | { readonly kind: 'missing'; readonly key: string }
  | { readonly kind: 'wrongType'; readonly property: PropertyDefinition };

export function resolveCover(container: ContainerData, view: View): Cover {
  if (view.coverProperty === null || view.coverProperty.length === 0) {
    return { kind: 'none' };
  }

  const property = container.schema?.properties.find(
    (candidate) => candidate.key === view.coverProperty,
  );

  if (property === undefined) {
    // Told apart from `none` on purpose. Somebody configured covers and they have stopped
    // appearing; a silent fallback to titled cards would look like the gallery had never been
    // configured, and the person would configure it again.
    return { kind: 'missing', key: view.coverProperty };
  }

  return property.type === 'image' ? { kind: 'ready', property } : { kind: 'wrongType', property };
}

/** A lost cover, named. */
export type LostCover = Extract<Cover, { kind: 'missing' } | { kind: 'wrongType' }>;

/**
 * What the notice says about a cover property that is gone.
 *
 * Both sentences end the same way and they have to: the sentence somebody needs is not "your
 * covers are missing" but "your items are not".
 */
export function describeLostCover(cover: LostCover): string {
  const still = 'Every item is still here; the cards are showing their titles instead.';

  // "properties", not "fields": that is the word the schema editor's title and the view editor's
  // hint both use, and two names for one concept across two panels is one name too many.
  //
  // The type is named by its label and quoted rather than dropped into the sentence raw. The stored
  // token is not a word anybody has been shown - somebody who picked "Picture" from a list would
  // otherwise be told their property is now a "multi_select" - and quoting keeps the sentence
  // grammatical whatever the label turns out to be.
  return cover.kind === 'missing'
    ? `Covers came from "${cover.key}", which is no longer one of this item's properties. ${still}`
    : `Covers came from "${cover.property.label}", which is now "${propertyTypeLabel(cover.property.type)}" rather than a picture. ${still}`;
}
