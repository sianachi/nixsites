/**
 * The "New" menu's structured recipes and the interactive-form default.
 *
 * Moved to `@nix/structure-spec` (task 0.3 of the pet structure-tools plan): this vocabulary is
 * pure - no browser, no `NixClient` - and the pet's structure compiler needs the same recipes the
 * creation studio offers. This file re-exports it so its importers in `apps/web` do not change.
 */

export {
  findStructuredRecipe,
  keyForProperty,
  RECIPE_GROUPS,
  SMART_LIST_STARTERS,
  STRUCTURED_RECIPES,
  viewForRecipe,
} from '@nix/structure-spec';
export type { StructuredRecipe, StructuredRecipeId } from '@nix/structure-spec';
