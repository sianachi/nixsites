import { STRUCTURED_RECIPES } from '../wizard/structured-recipes';
import type { View } from './container-model';

/** The guided recipe that configures a view of this kind, if any does. */
function guidedRecipeFor(kind: string): (typeof STRUCTURED_RECIPES)[number] | null {
  return (
    STRUCTURED_RECIPES.find((recipe) => recipe.viewKind === kind && recipe.menu === 'structured') ??
    STRUCTURED_RECIPES.find((recipe) => recipe.viewKind === kind) ??
    null
  );
}

/**
 * Where a view's settings are edited: the guided recipe for its kind, opened on that view.
 *
 * One spelling, shared by the view editor's Configure button and by every sentence that tells
 * somebody to change a view's settings, so the two can never send them to different places. Null
 * when the container is not an item or no recipe configures the kind.
 */
export function viewConfigureHref(
  itemId: string | null,
  view: Pick<View, 'id' | 'kind'>,
): string | null {
  const recipe = guidedRecipeFor(view.kind);
  return itemId === null || recipe === null
    ? null
    : `/items/${itemId}/views/${encodeURIComponent(view.id)}/edit/${recipe.id}`;
}
