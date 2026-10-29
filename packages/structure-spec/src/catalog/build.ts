import { FORMULA_FUNCTION_NAMES, PROPERTY_FORMULA_HELP, type SheetErrorCode } from '@nix/sheet';

import {
  canChartBy,
  canSectionBy,
  canGroupBy,
  isDateShaped,
  PROPERTY_TYPES,
  ROLLUP_AGGREGATES,
  valueShapeOf,
} from '../vocabulary/property-types.js';
import { STRUCTURED_RECIPES } from '../vocabulary/recipes.js';
import { TASK_SEMANTIC_FIELD_TYPES } from '../spec/field.js';
import { SORTED_VIEW_KINDS } from '../spec/view.js';
import { PROPERTY_FORMULA_GUIDANCE } from './formulas.js';
import { SMART_LISTS } from '../vocabulary/smart-lists.js';
import {
  FORM_RULES,
  HABIT,
  INIT_RULE_KINDS,
  LIMITS,
  NEVER_OPERATIONS,
  NEVER_PET_PROPERTY_TYPE,
  NEVER_PET_RECIPES,
  QUERY_OPERATORS,
  RECURRENCE,
  STRUCTURE_OPERATIONS,
  TEMPLATE_INPUT_TYPES,
  VIEW_KIND_RULES,
  type CatalogLimits,
  type FormRules,
  type HabitRules,
  type QueryOperatorRule,
  type RecurrenceRules,
  type ViewKindRequirement,
  type ViewKindRule,
} from './tables.js';

/**
 * Builds the capability catalog: what the pet may design with, drawn from the tables in
 * `tables.ts` and the vocabulary the web wizards already share, rather than restated by hand.
 * This module has no side effect of its own; `scripts/build-catalog.ts` calls it and writes the
 * generated files.
 */

export interface CatalogPropertyType {
  readonly type: string;
  readonly label: string;
  readonly shape: string;
}

export interface CatalogRecipe {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly viewKind: string;
}

export interface CatalogSmartList {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
}

export interface CatalogRollupAggregate {
  readonly value: string;
  readonly label: string;
}

/**
 * A view kind as the catalog states it: its rule, with the requirement carrying the property types
 * it accepts. The list is drawn from the same predicates the validator uses, over every type the
 * vocabulary defines (assignee included), so the C# parity test can compare it against
 * `ViewKinds.All` type by type rather than trusting a shape's name.
 */
export interface CatalogViewKind extends Omit<ViewKindRule, 'requires'> {
  readonly requires:
    (NonNullable<ViewKindRequirement> & { readonly accepts: readonly string[] }) | null;
}

export interface Catalog {
  readonly propertyTypes: readonly CatalogPropertyType[];
  readonly rollupAggregates: readonly CatalogRollupAggregate[];
  readonly recipes: readonly CatalogRecipe[];
  readonly smartLists: readonly CatalogSmartList[];
  readonly viewKinds: readonly CatalogViewKind[];
  readonly queryOperators: readonly QueryOperatorRule[];
  readonly formRules: FormRules;
  readonly structureOperations: readonly string[];
  readonly limits: CatalogLimits;
  readonly templateInputTypes: readonly string[];
  readonly initRuleKinds: readonly string[];
  readonly recurrence: RecurrenceRules;
  readonly habit: HabitRules;
  readonly neverOperations: readonly string[];
  readonly formulaFunctions: readonly string[];
  readonly formulaHelp: Readonly<Record<SheetErrorCode, string>>;
}

export function buildCatalog(): Catalog {
  const propertyTypes: CatalogPropertyType[] = PROPERTY_TYPES.filter(
    (entry) => entry.value !== NEVER_PET_PROPERTY_TYPE,
  ).map((entry) => ({
    type: entry.value,
    label: entry.label,
    shape: valueShapeOf(entry.value),
  }));

  const recipes: CatalogRecipe[] = STRUCTURED_RECIPES.filter(
    (recipe) => !NEVER_PET_RECIPES.has(recipe.id),
  ).map((recipe) => ({
    id: recipe.id,
    label: recipe.label,
    detail: recipe.detail,
    viewKind: recipe.viewKind,
  }));

  const smartLists: CatalogSmartList[] = SMART_LISTS.map((preset) => ({
    id: preset.id,
    label: preset.label,
    detail: preset.detail,
  }));

  const rollupAggregates: CatalogRollupAggregate[] = ROLLUP_AGGREGATES.map((entry) => ({
    value: entry.value,
    label: entry.label,
  }));

  return {
    propertyTypes,
    rollupAggregates,
    recipes,
    smartLists,
    viewKinds: VIEW_KIND_RULES.map(withAccepts),
    queryOperators: QUERY_OPERATORS,
    formRules: FORM_RULES,
    structureOperations: STRUCTURE_OPERATIONS,
    limits: LIMITS,
    templateInputTypes: TEMPLATE_INPUT_TYPES,
    initRuleKinds: INIT_RULE_KINDS,
    recurrence: RECURRENCE,
    habit: HABIT,
    neverOperations: NEVER_OPERATIONS,
    formulaFunctions: FORMULA_FUNCTION_NAMES,
    formulaHelp: PROPERTY_FORMULA_HELP,
  };
}

/** The predicate a kind's requirement is held to, matching the validator in `view-rules.ts`. */
function requirementAccepts(kind: ViewKindRule): ((type: string) => boolean) | null {
  if (kind.requires === null) {
    return null;
  }
  if (kind.requires.field === 'date') {
    return isDateShaped;
  }
  if (kind.requires.field === 'columnBy') {
    return canSectionBy;
  }
  return kind.kind === 'chart' ? canChartBy : canGroupBy;
}

function withAccepts(kind: ViewKindRule): CatalogViewKind {
  const accepts = requirementAccepts(kind);
  if (kind.requires === null || accepts === null) {
    return { ...kind, requires: null };
  }
  return {
    ...kind,
    requires: {
      ...kind.requires,
      accepts: PROPERTY_TYPES.map((entry) => entry.value).filter((type) => accepts(type)),
    },
  };
}

/**
 * One view kind as a line of catalog text. A kind with no requirement says nothing about one
 * rather than "no required field": the chat text has a hard 3000-character ceiling, and the
 * absence of "needs ..." already says it.
 */
function viewKindLine(kind: CatalogViewKind): string {
  const clauses = [
    ...(kind.requires === null ? [] : [`needs a ${kind.requires.shape} property`]),
    ...(kind.optional.length
      ? ['optional: ' + kind.optional.map((field) => `${field.field} (${field.shape})`).join(', ')]
      : []),
  ];
  const settings = clauses.length ? `: ${clauses.join('; ')}` : '';
  return `- ${kind.label} (${kind.kind})${settings}. ${kind.description}`;
}

/**
 * The pet's catalog text: field types, view kinds and their requirements, recipes, the
 * never-ops, formulas, rollups, form rules, smart lists, recurrence, habits, the template
 * vocabulary, the blueprint schema summary and the efficiency patterns, at most 13000
 * characters. One conversation both refines existing structure and designs whole systems, so it
 * carries the full vocabulary.
 */
export function renderCatalog(catalog: Catalog, patterns: string): string {
  const lines: string[] = [];
  lines.push('Section: Structure operations');
  lines.push(catalog.structureOperations.join(', '));
  lines.push(
    `Per call: create_structured ${String(catalog.limits.viewsPerNode)} views, add_view ${String(catalog.limits.viewsPerAddView)}; ${String(catalog.limits.viewsPerContainer)} total per item. Read structure for remaining capacity.`,
  );
  lines.push('');
  lines.push('Section: View review');
  lines.push(
    'Read configuration with nix_read_structure and bounded results with nix_read_view. Reviews only read; requested refinements use nix_update_view, then read back.',
  );
  lines.push(
    `Sorting: sortBy (a field key) and sortDescending set one sort; ${SORTED_VIEW_KINDS.join(', ')} apply it. Other kinds show children in their own order and ignore saved sorts and filters.`,
  );
  lines.push(
    'Filters belong to smart lists (query): each is {field, op, value} with an op from Query operators, and all must match; $type, $inside, $created, $modified and $done test the item itself. A preset (Smart lists) is a built-in rule used instead of filters. "Any of" groups exist only when a person added them in the editor; read them, never propose them.',
  );
  lines.push(
    'Formula and rollup fields cannot be filtered or sorted when read. nix_read_view reports whether it applied the saved rules (appliedViewRules) and what it ignored or could not read (limits): read both before explaining an order, a total or a missing item.',
  );
  lines.push('');
  lines.push('Section: Property types');
  lines.push(catalog.propertyTypes.map((type) => `${type.type} (${type.label})`).join(', '));
  lines.push(
    `Task field keys equal their type: ${TASK_SEMANTIC_FIELD_TYPES.join(', ')}. Labels stay free.`,
  );
  lines.push('');
  lines.push('Section: View kinds');
  lines.push('Columns may include title; it is an item-title marker, never a form field.');
  for (const kind of catalog.viewKinds) {
    lines.push(viewKindLine(kind));
  }
  lines.push('');
  lines.push('Section: Recipes');
  lines.push(
    catalog.recipes.map((recipe) => `${recipe.id}: ${recipe.label} - ${recipe.detail}`).join('\n'),
  );
  lines.push('');
  lines.push('Section: Never');
  for (const rule of catalog.neverOperations) {
    lines.push(`- ${rule}`);
  }
  lines.push('');

  lines.push('Section: Query operators');
  for (const operator of catalog.queryOperators) {
    lines.push(`- ${operator.op}: ${operator.grammar}`);
  }
  lines.push('');

  lines.push('Section: Smart lists');
  lines.push(
    catalog.smartLists
      .map((preset) => `${preset.id}: ${preset.label} - ${preset.detail}`)
      .join('\n'),
  );
  lines.push('');

  lines.push('Section: Rollup aggregates');
  lines.push(
    catalog.rollupAggregates
      .map((aggregate) => `${aggregate.value} (${aggregate.label})`)
      .join(', '),
  );
  lines.push('');

  lines.push('Section: Formulas');
  lines.push(PROPERTY_FORMULA_GUIDANCE);
  for (const code of Object.keys(catalog.formulaHelp) as SheetErrorCode[]) {
    lines.push(`- ${code}: ${catalog.formulaHelp[code]}`);
  }
  lines.push('');

  lines.push('Section: Forms');
  lines.push(
    'For form and interactive_form views, mode:"temporary" keeps answers in memory and creates no entry; mode:"saved" creates entries. Put calculations in formula schema fields, not input blocks.',
  );
  lines.push(`Block kinds: ${catalog.formRules.blockKinds.join(', ')}`);
  lines.push(`Condition operators: ${catalog.formRules.conditionOperators.join(', ')}`);
  lines.push(`Identity roles: ${catalog.formRules.identityRoles.join(', ')}`);
  lines.push(`Title modes: ${catalog.formRules.titleModes.join(', ')}`);
  lines.push('');

  lines.push('Section: Recurrence');
  lines.push(
    `Frequencies: ${catalog.recurrence.frequencies.join(', ')}; interval ${String(catalog.recurrence.intervalMin)}-${String(catalog.recurrence.intervalMax)}. Needs a due_date value on the same node.`,
  );
  lines.push('');

  lines.push('Section: Habits');
  lines.push(
    `Frequencies: ${catalog.habit.frequencies.join(', ')}. Configure child node.habit with frequency, weekdays, target and unit; its parent needs a habit_tracker view. The view has no column mappings.`,
  );
  lines.push('');

  lines.push('Section: Templates');
  lines.push(`Input types: ${catalog.templateInputTypes.join(', ')}`);
  lines.push(`Init rule kinds: ${catalog.initRuleKinds.join(', ')}`);
  lines.push('');

  lines.push('Section: Blueprint schema');
  lines.push(
    `A blueprint is version 1, a title, a one-paragraph summary, a root node, up to ${String(catalog.limits.inputsPerBlueprint)} inputs ` +
      `and up to ${String(catalog.limits.initRulesPerBlueprint)} init rules. A node has an id, a title, up to ${String(catalog.limits.fieldsPerNode)} fields, ` +
      `up to ${String(catalog.limits.viewsPerNode)} views (a node with views is a container), markdown, recurrence, habit ` +
      `settings, values and children. Limits: ${String(catalog.limits.blueprintNodes)} nodes total, ` +
      `${String(catalog.limits.blueprintNonSampleNodes)} non-sample, depth ${String(catalog.limits.blueprintDepth)}, ` +
      `${String(catalog.limits.fieldsPerBlueprint)} fields, ${String(catalog.limits.viewsPerBlueprint)} views, ` +
      `${String(catalog.limits.sampleEntries)} sample entries, ${String(catalog.limits.plannedWritesPerBuild)} planned writes.`,
  );
  lines.push(
    'Blueprint JSON uses fields shaped as {"label":"Status","type":"select","options":["Open","Done"]}; label and type are required. Do not use name for a field. Put sample or initial field values on a node under values, keyed by field key, for example {"values":{"status":"Open"}}; do not use properties or entries for blueprint node values. A view is shaped as {"kind":"board","groupBy":"status"}; kind-specific settings must match the view kind. On a list, groupBy draws sections from a select, a checkbox or $type (body kind).',
  );
  lines.push('Valid view settings by kind:');
  for (const kind of catalog.viewKinds) {
    const settings = [
      ...(kind.requires === null ? [] : [kind.requires.field]),
      ...kind.optional.map((field) => field.field),
    ];
    lines.push(
      `- ${kind.kind}: ${settings.length ? settings.join(', ') : 'no kind-specific settings'}`,
    );
  }
  lines.push('');

  lines.push('Section: Patterns');
  lines.push(patterns.trim());

  return lines.join('\n');
}
