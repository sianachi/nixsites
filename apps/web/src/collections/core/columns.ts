import type { EffectiveSchema, PropertyDefinition, View } from './container-model';

/**
 * How a view's configured columns resolve against the schema - decided once, used by every kind
 * that reads `view.columns`.
 *
 * Three views grew three copies of this rule (the list, the spreadsheet, the form) before it was
 * extracted; the second copy already cited the first "for the same reasons", which is the rule of
 * three announcing itself. What stays with each view is what it *does* with an unresolvable key -
 * the list and the spreadsheet keep a column headed by the key so a renamed property leaves a
 * stated blank, the form names it as a gap because there is nothing to type into - so this
 * resolves and the callers judge.
 */

/**
 * The title is the row's name, not one of its properties. It never resolves as a column key: a
 * view choosing which properties to show is not choosing whether the row says what it is.
 */
export const TITLE_COLUMN_KEY = 'title';

export interface ConfiguredColumns {
  /**
   * The property keys the view shows, in order: the view's own columns when it names any, the
   * schema's declared order otherwise, deduplicated, with `title` dropped. A key is present even
   * when `definitions` cannot answer for it - dropping it silently is the callers' call to make,
   * and none of them makes it.
   */
  readonly keys: readonly string[];

  /** What the schema says about each key, for the keys it still describes. */
  readonly definitions: ReadonlyMap<string, PropertyDefinition>;
}

export function resolveConfiguredColumns(
  view: View | null,
  schema: EffectiveSchema | null,
): ConfiguredColumns {
  // A Map keeps insertion order, so the fallback comes out in the order the schema declares
  // rather than an order of our invention.
  const definitions = new Map(
    (schema?.properties ?? []).map((definition) => [definition.key, definition]),
  );

  const configured =
    view !== null && view.columns.length > 0 ? view.columns : [...definitions.keys()];

  return {
    keys: [...new Set(configured)].filter((key) => key !== TITLE_COLUMN_KEY),
    definitions,
  };
}
