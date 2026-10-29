/**
 * What each property type is called when a person reads it.
 *
 * Moved to `@nix/structure-spec` (task 0.3 of the pet structure-tools plan): this vocabulary is
 * pure - no browser, no `NixClient` - and the pet's structure compiler needs the same words the
 * schema editor uses. This file re-exports it so its importers in `apps/web` do not change.
 */

export {
  canChartBy,
  canGroupBy,
  canSectionBy,
  canSplitBy,
  foldNeedsProperty,
  isComputedType,
  isDateShaped,
  PROPERTY_TYPES,
  propertyTypeLabel,
  propertyTypeWord,
  ROLLUP_AGGREGATES,
  rollupAggregateLabel,
  TYPE_GROUP_KEY,
  valueShapeOf,
} from '@nix/structure-spec';
