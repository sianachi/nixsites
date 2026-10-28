export type {
  StructureFilter,
  StructureForm,
  StructureProperty,
  StructureSchema,
  StructureView,
} from './types.js';

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
} from './vocabulary/property-types.js';

export {
  findStructuredRecipe,
  keyForProperty,
  SMART_LIST_STARTERS,
  RECIPE_GROUPS,
  STRUCTURED_RECIPES,
  viewForRecipe,
} from './vocabulary/recipes.js';
export type { StructuredRecipe, StructuredRecipeId } from './vocabulary/recipes.js';

export { findSmartList, SMART_LISTS, smartListView } from './vocabulary/smart-lists.js';
export type { SmartListPreset } from './vocabulary/smart-lists.js';

export { mergeProperties } from './vocabulary/merge-properties.js';

export * from './spec/index.js';

export { buildCatalog, renderCatalog, type Catalog } from './catalog/build.js';
export {
  HABIT,
  LIMITS,
  READ_ONLY_OPERATION_NAMES,
  WORKSPACE_OPERATIONS,
} from './catalog/tables.js';
export { buildPetTools, normalizeForCodex } from './catalog/tools.js';
export { flattenToolExample as flattenToolCall } from './catalog/tool-examples.js';
export * from './compile/index.js';
export * from './describe/index.js';
export type { Problem, ValidationContext, ValidationReport } from './validate/report.js';
export { type SpecOperation, validateSpec } from './validate/spec.js';

export * from './blueprint/index.js';

export { designScenarioSchema } from './evals/schema.js';
export type { DesignScenario, Predicate } from './evals/schema.js';
export { scoreBlueprint } from './evals/score.js';
export { chatCaseSchema, chatSuiteSchema } from './evals/chat-schema.js';
export type { ChatAssertion, ChatCase } from './evals/chat-schema.js';
export type { EvalScore } from './evals/score.js';
