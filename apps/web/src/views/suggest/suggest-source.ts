import type { Item, PropertyDefinition } from '@nix/web-collections/core/container-model';

/**
 * What a view knows that lets its create control make suggestions: the siblings to learn from and
 * to check against, the schema saying which of their properties are categories, and how to open an
 * item somebody may have meant instead.
 *
 * `children` must keep its identity between renders - `useContainer`'s own array does - because it
 * keys both the trained models and the workspace search.
 *
 * Its own module, apart from `create-suggestions.tsx`, so a view can describe its source without
 * pulling the suggestion code (the classifier, the similarity search) into its own chunk: the
 * create control loads that lazily, only once somebody opens a create field.
 */
export interface CreateSuggestSource {
  readonly children: readonly Item[];
  readonly schema: readonly PropertyDefinition[];
  readonly onOpen: (itemId: string) => void;
}

/** EMPTY rather than a fresh `[]`, so a schema-less container keeps one identity for the models. */
const NO_PROPERTIES: readonly PropertyDefinition[] = [];

/** The source a view hands its create control, from the container it is already drawing. */
export function suggestSourceOf(
  container: {
    readonly children: readonly Item[];
    readonly schema: { readonly properties: readonly PropertyDefinition[] } | null;
  },
  onOpen: (itemId: string) => void,
): CreateSuggestSource {
  return {
    children: container.children,
    schema: container.schema?.properties ?? NO_PROPERTIES,
    onOpen,
  };
}
