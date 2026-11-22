import {
  formulaFieldNames,
  propertyFormulaProblem,
  planPropertyFormulas,
  PROPERTY_FORMULA_HELP,
  PROPERTY_FORMULA_LIMITS,
} from '@nix/sheet';

import { LIMITS } from '../catalog/tables.js';
import type { Cond, FormSpec } from '../spec/form.js';
import { keyFor } from '../spec/keys.js';
import { resolveFieldRef, type ResolvedField } from '../spec/refs.js';
import type { ViewSpec } from '../spec/view.js';
import type {
  StructureForm,
  StructureFormBlock,
  StructureFormCondition,
  StructureFormPage,
  StructureProperty,
  StructureView,
} from '../types.js';
import { isDateShaped, TYPE_GROUP_KEY, valueShapeOf } from '../vocabulary/property-types.js';
import { refuseSchema } from '../validate/schema-rules.js';
import { refuseViews } from '../validate/view-rules.js';
import { validateValue } from '../validate/values.js';
import {
  refFailureMessage,
  zodIssuesToProblems,
  type Problem,
  type ValidationContext,
  type ValidationReport,
} from '../validate/report.js';
import { compileChartOptions } from '../compile/views.js';
import { effectiveSchemaPerNode } from './effective.js';
import { blueprintSchema, type Blueprint, type Node } from './schema.js';
import { collectWarnings } from './warnings.js';

/** Architecture 4 check 8: validate references and formula plans in each node's effective schema. */
export function validateFormulas(
  bp: Blueprint,
  effective: ReadonlyMap<string, readonly StructureProperty[]>,
): Problem[] {
  const problems: Problem[] = [];

  function visit(node: Node, path: string): void {
    const fields = effective.get(node.id) ?? [];
    const fieldByKey = new Map(fields.map((field) => [field.key, field]));
    const formulas = fields
      .filter((field) => field.type === 'formula' && field.expression !== null)
      .map((field) => ({ key: field.key, expression: field.expression ?? '' }));

    for (const formula of formulas) {
      const names = formulaFieldNames(formula.expression);
      if (names === null) continue;
      for (const name of names) {
        if (!fieldByKey.has(name)) {
          problems.push({
            path: `${path}.fields`,
            code: 'formula.unknown_field',
            message: `${PROPERTY_FORMULA_HELP['#NAME?']} Formula '${formula.key}' refers to '${name}'.`,
          });
        }
      }
      if (names.every((name) => fieldByKey.has(name))) {
        const problem = propertyFormulaProblem(formula.expression, new Set(fieldByKey.keys()));
        if (problem !== null) {
          problems.push({
            path: `${path}.fields`,
            code: 'formula.invalid_expression',
            message: `Formula '${formula.key}': ${problem}`,
          });
        }
      }
    }

    const plan = planPropertyFormulas(formulas, PROPERTY_FORMULA_LIMITS);
    for (const [key, result] of plan.fixed) {
      if (typeof result !== 'object' || result === null || !('error' in result)) continue;
      if (result.error !== '#PARSE!' && result.error !== '#LIMIT!' && result.error !== '#CYCLE!') {
        continue;
      }
      problems.push({
        path: `${path}.fields`,
        code: `formula.${result.error === '#PARSE!' ? 'parse' : result.error === '#LIMIT!' ? 'limit' : 'cycle'}`,
        message: `Formula '${key}': ${PROPERTY_FORMULA_HELP[result.error]}`,
      });
    }

    (node.children ?? []).forEach((child, index) => {
      visit(child, `${path}.children[${String(index)}]`);
    });
  }

  visit(bp.root, 'root');
  return problems;
}

interface RefScope {
  existing: readonly StructureProperty[];
  added: readonly ResolvedField[];
}

/** Resolves one `FieldRef`, pushing a problem at `path` when it does not resolve. */
function resolveRef(
  ref: string | undefined,
  scope: RefScope,
  path: string,
  problems: Problem[],
): string | null {
  if (ref === undefined) {
    return null;
  }
  const resolution = resolveFieldRef(ref, scope);
  if (!resolution.ok) {
    problems.push({ path, code: resolution.code, message: refFailureMessage(ref, resolution) });
    return null;
  }
  return resolution.key;
}

/**
 * Compiles one node's `showWhen`/page/block ids for `refuseViews`'s form checks, mirroring
 * `@nix/structure-spec/validate/spec.ts`'s own `compileFormForValidation` (task A.1c): page ids
 * `p1..`, block ids `b1..`, a condition's `field` resolved to the id of the earlier field block it
 * means. Kept as a local copy, not a shared export, because a blueprint node's path prefix
 * (`root.children[2].views[0]`) differs from a flat operation's (`views[0]`) and because
 * `validate/spec.ts` is a sibling task's file this task must not edit.
 */
function compileFormForValidation(
  form: FormSpec,
  scope: RefScope,
  viewPath: string,
  problems: Problem[],
): StructureForm {
  const fieldBlockIdByKey = new Map<string, string>();
  let blockCounter = 0;
  let pageCounter = 0;

  function compileConditions(
    conditions: readonly Cond[] | undefined,
    path: string,
  ): StructureFormCondition[] {
    return (conditions ?? []).map((condition) => {
      const key = resolveRef(condition.field, scope, `${path}.showWhen.field`, problems);
      const fieldBlockId = key !== null ? fieldBlockIdByKey.get(key) : undefined;
      return {
        fieldBlockId: fieldBlockId ?? '',
        operator: condition.op,
        value: condition.value ?? null,
      };
    });
  }

  const pages: StructureFormPage[] = form.pages.map((page) => {
    pageCounter += 1;
    const pageId = `p${String(pageCounter)}`;
    const pageVisibleWhen = compileConditions(page.showWhen, `${viewPath}.form.${pageId}`);

    const blocks: StructureFormBlock[] = page.blocks.map((block) => {
      blockCounter += 1;
      const blockId = `b${String(blockCounter)}`;

      if ('field' in block) {
        const key = resolveRef(block.field, scope, `${viewPath}.form.${blockId}.field`, problems);
        const visibleWhen = compileConditions(block.showWhen, `${viewPath}.form.${blockId}`);
        if (key !== null) {
          fieldBlockIdByKey.set(key, blockId);
        }
        return {
          id: blockId,
          kind: 'field',
          propertyKey: key,
          text: '',
          help: block.help ?? null,
          required: block.required ?? false,
          identityRole: block.identity ?? null,
          visibleWhen,
        };
      }

      if ('heading' in block) {
        return {
          id: blockId,
          kind: 'heading',
          propertyKey: null,
          text: block.heading,
          help: null,
          required: false,
          identityRole: null,
          visibleWhen: [],
        };
      }

      return {
        id: blockId,
        kind: 'paragraph',
        propertyKey: null,
        text: block.paragraph,
        help: null,
        required: false,
        identityRole: null,
        visibleWhen: [],
      };
    });

    return {
      id: pageId,
      title: page.title,
      description: page.description ?? null,
      visibleWhen: pageVisibleWhen,
      blocks,
    };
  });

  const titleMode = form.title?.from ?? 'generated';
  let titleFieldBlockId: string | null = null;
  if (form.title?.from === 'field') {
    const key = resolveRef(form.title.field, scope, `${viewPath}.form.title.field`, problems);
    titleFieldBlockId = key !== null ? (fieldBlockIdByKey.get(key) ?? null) : null;
  }

  return {
    pages,
    titleMode,
    titleFieldBlockId,
    confirmationTitle: form.confirmation?.title ?? '',
    confirmationMessage: form.confirmation?.message ?? '',
  };
}

/**
 * Compiles one node's view spec into enough of a `StructureView` for `refuseViews` to check,
 * mirroring `validate/spec.ts`'s `compileViewForValidation` for the same reason
 * `compileFormForValidation` above does.
 */
function compileViewForValidation(
  view: ViewSpec,
  scope: RefScope,
  path: string,
  problems: Problem[],
): StructureView {
  // `$type` sections a list by body kind and names no property, so it has nothing to resolve.
  const groupBy =
    view.kind === 'matrix'
      ? resolveRef(view.columnBy, scope, `${path}.columnBy`, problems)
      : view.groupBy === TYPE_GROUP_KEY
        ? TYPE_GROUP_KEY
        : resolveRef(view.groupBy, scope, `${path}.groupBy`, problems);
  const rowBy = resolveRef(view.rowBy, scope, `${path}.rowBy`, problems);
  const dateProperty = resolveRef(view.date, scope, `${path}.date`, problems);
  const endDateProperty = resolveRef(view.endDate, scope, `${path}.endDate`, problems);
  const coverProperty = resolveRef(view.cover, scope, `${path}.cover`, problems);
  const measureProperty = resolveRef(view.measureField, scope, `${path}.measureField`, problems);
  const doneProperty = resolveRef(view.doneProperty, scope, `${path}.doneProperty`, problems);
  const splitBy = resolveRef(view.splitBy, scope, `${path}.splitBy`, problems);
  const sortBy = resolveRef(view.sortBy, scope, `${path}.sortBy`, problems);
  const columns = (view.columns ?? []).map(
    (ref, index) => resolveRef(ref, scope, `${path}.columns[${String(index)}]`, problems) ?? ref,
  );

  // A filter's property is never resolved against the schema, matching Core's own `FilterRule`
  // comment (`view-rules.ts`'s `refuseFilter` doc comment carries the same reasoning): a query view
  // spans containers, and a rule naming a property nothing declares simply matches nothing.
  const filters = (view.filters ?? []).map((filter) => ({
    property: filter.field,
    operator: filter.op,
    value: filter.value,
  }));

  const interactiveForm =
    view.kind === 'interactive_form' && view.form !== undefined
      ? compileFormForValidation(view.form, scope, path, problems)
      : null;

  return {
    id: `view-${path}`,
    name: view.name ?? view.kind,
    kind: view.kind,
    columns,
    groupBy,
    groupOrder: view.groupOrder ?? [],
    dateProperty,
    sortBy,
    sortDescending: view.sortDescending ?? false,
    mode: view.mode ?? null,
    coverProperty,
    endDateProperty,
    cardSize: view.cardSize ?? null,
    layout: null,
    filters,
    measure: view.measure ?? null,
    measureProperty,
    chart: compileChartOptions(
      view,
      scope.existing.find((field) => field.key === groupBy)?.type,
      splitBy,
    ),
    interactiveForm,
    doneProperty,
    rowBy,
  };
}

/**
 * Whether a rollup's fold fits its source's shape, porting `PropertySchemaRules.Fits`
 * (`backend/src/Nix.Api/Domain/Properties/PropertySchemaRules.cs:157-177`) - the same rule
 * `validate/schema-rules.ts`'s own private `fitsAggregate` already ports for a flat schema's
 * self-referencing rollups. Kept as a second, local copy rather than an import: that function is
 * not exported, and exporting it would mean editing a sibling task's file (`validate/spec.ts`'s
 * neighbour) this task must leave alone.
 */
const NUMERIC_AGGREGATES: ReadonlySet<string> = new Set(['sum', 'average', 'min', 'max']);

function fitsAggregate(aggregate: string, sourceType: string): boolean {
  const shape = valueShapeOf(sourceType);
  return NUMERIC_AGGREGATES.has(aggregate) ? shape === 'number' : shape === 'checkbox';
}

/**
 * Architecture 4 check 9: a rollup's `source` names a property on the node's *children*, not on
 * the node itself - unlike a flat schema's self-referencing rollup (`refuseSchema`'s own, more
 * permissive check, which only fires when a match happens to exist in the same schema). The
 * lookup scope is the union of every immediate child's effective schema. Children may omit a
 * source, but every effective declaration of a resolved source key must fit the aggregate; this
 * avoids making validation depend on child order when siblings override an inherited field to
 * different types.
 */
function checkRollups(
  node: Node,
  path: string,
  effectiveMap: Map<string, StructureProperty[]>,
  problems: Problem[],
): void {
  const children = node.children ?? [];
  const childScope = new Map<string, StructureProperty[]>();
  for (const child of children) {
    for (const property of effectiveMap.get(child.id) ?? []) {
      const matches = childScope.get(property.key) ?? [];
      matches.push(property);
      childScope.set(property.key, matches);
    }
  }
  // Resolve the requested key once, then check every child's effective definition of that key.
  // Siblings can legally override an inherited key to different types; checking only the first
  // child would make validation depend on their order and let an incompatible fold through.
  const childProperties = [...childScope.values()].flat();

  (node.fields ?? []).forEach((field, index) => {
    if (field.type !== 'rollup' || field.rollup === undefined) {
      return;
    }
    const { aggregate, source } = field.rollup;
    const sourcePath = `${path}.fields[${String(index)}].rollup.source`;
    if (source === undefined) {
      if (aggregate !== 'count') {
        problems.push({
          path: sourcePath,
          code: 'rollup-source-required',
          message: `'${field.label}' folds its children with ${aggregate}, which needs a property to fold.`,
        });
      }
      return;
    }

    const resolution = resolveFieldRef(source, { existing: childProperties, added: [] });
    if (!resolution.ok) {
      problems.push({
        path: sourcePath,
        code: resolution.code,
        message:
          resolution.code === 'unknown'
            ? `'${source}' does not name a field on this node's children.`
            : `'${source}' could mean ${resolution.candidates.join(' or ')}; say which.`,
      });
      return;
    }

    if (aggregate === 'count') {
      return;
    }

    const sourceProperties = childScope.get(resolution.key) ?? [];
    const incompatibleSource = sourceProperties.find(
      (sourceProperty) => !fitsAggregate(aggregate, sourceProperty.type),
    );
    if (incompatibleSource !== undefined) {
      problems.push({
        path: sourcePath,
        code: 'rollup-fit',
        message:
          `'${field.label}' folds '${incompatibleSource.label}' with ${aggregate}, which needs ` +
          (NUMERIC_AGGREGATES.has(aggregate) ? 'a number.' : 'a checkbox.'),
      });
    }
  });
}

/** Architecture 4 check 10: node values against the node's own effective schema. */
function checkValues(
  node: Node,
  path: string,
  effective: readonly StructureProperty[],
  problems: Problem[],
): void {
  if (node.values === undefined) {
    return;
  }
  const scope: RefScope = { existing: effective, added: [] };
  for (const [ref, value] of Object.entries(node.values)) {
    const valuePath = `${path}.values.${ref}`;
    const key = resolveRef(ref, scope, valuePath, problems);
    if (key === null) {
      continue;
    }
    const property = effective.find((candidate) => candidate.key === key);
    if (property === undefined) {
      continue;
    }
    const reason = validateValue(property, value);
    if (reason !== null) {
      problems.push({ path: valuePath, code: 'value', message: reason });
    }
  }
}

/** Whether `node`'s own effective schema and values together carry a due-date value. */
function hasDueDateValue(
  node: Node,
  effective: readonly StructureProperty[],
  dueDateKey: string,
): boolean {
  if (node.values === undefined) {
    return false;
  }
  const scope: RefScope = { existing: effective, added: [] };
  return Object.entries(node.values).some(([ref, value]) => {
    const resolution = resolveFieldRef(ref, scope);
    return resolution.ok && resolution.key === dueDateKey && value !== null;
  });
}

/** Architecture 4 check 11: recurrence needs an effective due date and a value for it; a habit node needs a habit-tracker parent. */
function checkRecurrenceAndHabit(
  node: Node,
  path: string,
  effective: readonly StructureProperty[],
  parent: Node | null,
  problems: Problem[],
): void {
  if (node.recurrence !== undefined) {
    const dueDate = effective.find((property) => property.type === 'due_date');
    if (dueDate === undefined) {
      problems.push({
        path: `${path}.recurrence`,
        code: 'recurrence-needs-due-date',
        message: 'Recurrence needs a due date property in effect on this node.',
      });
    } else if (!hasDueDateValue(node, effective, dueDate.key)) {
      problems.push({
        path: `${path}.recurrence`,
        code: 'recurrence-needs-due-date-value',
        message: 'Recurrence needs a due date value set on this node.',
      });
    }
  }

  if (node.habit !== undefined) {
    const parentIsTracker = (parent?.views ?? []).some((view) => view.kind === 'habit_tracker');
    if (!parentIsTracker) {
      problems.push({
        path: `${path}.habit`,
        code: 'habit-needs-tracker-parent',
        message: 'A habit node must be a child of a node with a habit tracker view.',
      });
    }
  }
}

/** Architecture 4 check 13: sample nodes are leaves, and only a sample node's title may start with "Sample: ". */
function checkSample(node: Node, path: string, problems: Problem[]): void {
  if (node.sample === true && node.children !== undefined && node.children.length > 0) {
    problems.push({
      path: `${path}.children`,
      code: 'sample-not-leaf',
      message: 'A sample node cannot have children.',
    });
  }
  if (node.sample !== true && node.title.startsWith('Sample: ')) {
    problems.push({
      path: `${path}.title`,
      code: 'sample-title-reserved',
      message: "Only a sample node's title may start with 'Sample: '.",
    });
  }
}

interface TreeStats {
  totalNodes: number;
  nonSampleNodes: number;
  sampleNodes: number;
  totalFields: number;
  totalViews: number;
  maxDepth: number;
  markdownWrites: number;
  recurrenceWrites: number;
  habitWrites: number;
  schemaWrites: number;
  propertyWrites: number;
}

/**
 * Architecture 4's per-node checks and every count `validateBlueprint`'s limit checks and
 * `plannedWrites` computation need, in one walk. Node id uniqueness is checked here too - the one
 * shape rule `blueprintSchema` cannot express, since a `.regex()` on `id` says nothing about
 * another node in the same tree sharing it.
 */
function walkTree(
  bp: Blueprint,
  effectiveMap: Map<string, StructureProperty[]>,
  problems: Problem[],
): TreeStats {
  const stats: TreeStats = {
    totalNodes: 0,
    nonSampleNodes: 0,
    sampleNodes: 0,
    totalFields: 0,
    totalViews: 0,
    maxDepth: 0,
    markdownWrites: 0,
    recurrenceWrites: 0,
    habitWrites: 0,
    schemaWrites: 0,
    propertyWrites: 0,
  };
  const seenIds = new Set<string>();

  function visit(node: Node, path: string, parent: Node | null, depth: number): void {
    stats.totalNodes += 1;
    stats.maxDepth = Math.max(stats.maxDepth, depth);
    if (node.sample === true) {
      stats.sampleNodes += 1;
    } else {
      stats.nonSampleNodes += 1;
    }
    stats.totalFields += node.fields?.length ?? 0;
    stats.totalViews += node.views?.length ?? 0;
    const hasViews = (node.views?.length ?? 0) > 0;
    const needsOwnSchema = !hasViews && ((node.fields?.length ?? 0) > 0 || node.inherit === false);
    if (needsOwnSchema) stats.schemaWrites += 1;
    if (
      node.values !== undefined &&
      Object.keys(node.values).length > 0 &&
      (hasViews || needsOwnSchema)
    ) {
      stats.propertyWrites += 1;
    }
    if (node.markdown !== undefined && node.markdown.length > 0) {
      stats.markdownWrites += 1;
    }
    if (node.recurrence !== undefined) {
      stats.recurrenceWrites += 1;
    }
    if (node.habit !== undefined) {
      stats.habitWrites += 1;
    }

    if (seenIds.has(node.id)) {
      problems.push({
        path: `${path}.id`,
        code: 'duplicate-node-id',
        message: `'${node.id}' is used by more than one node; every node id must be unique in the blueprint.`,
      });
    }
    seenIds.add(node.id);

    const effective = effectiveMap.get(node.id) ?? [];

    const schemaProblem = refuseSchema({ properties: effective, inherit: node.inherit ?? true });
    if (schemaProblem !== null) {
      problems.push({ path: `${path}.fields`, code: 'schema', message: schemaProblem });
    }

    checkRollups(node, path, effectiveMap, problems);
    checkValues(node, path, effective, problems);
    checkRecurrenceAndHabit(node, path, effective, parent, problems);
    checkSample(node, path, problems);

    if (node.views !== undefined && node.views.length > 0) {
      const ownAdded: ResolvedField[] = (node.fields ?? []).map((field) => ({
        key: keyFor(field),
        label: field.label,
      }));
      const scope: RefScope = { existing: effective, added: ownAdded };
      node.views.forEach((view, index) => {
        const viewPath = `${path}.views[${String(index)}]`;
        const compiled = compileViewForValidation(view, scope, viewPath, problems);
        const reason = refuseViews([compiled], effective, null);
        if (reason !== null) {
          problems.push({ path: viewPath, code: 'views', message: reason });
        }
      });
    }

    (node.children ?? []).forEach((child, index) => {
      visit(child, `${path}.children[${String(index)}]`, node, depth + 1);
    });
  }

  visit(bp.root, 'root', null, 1);
  return stats;
}

/** Architecture 4 check 12: template inputs and initialization rules. */
function checkTemplateInputsAndRules(
  bp: Blueprint,
  effectiveMap: Map<string, StructureProperty[]>,
  problems: Problem[],
): void {
  const inputs = bp.inputs ?? [];
  const inputByKey = new Map<string, (typeof inputs)[number]>();
  inputs.forEach((input, index) => {
    if (inputByKey.has(input.key)) {
      problems.push({
        path: `inputs[${String(index)}].key`,
        code: 'duplicate-input-key',
        message: `Input key '${input.key}' is declared more than once.`,
      });
    }
    inputByKey.set(input.key, input);
  });

  const rules = bp.rules ?? [];
  const seenNodeField = new Set<string>();

  rules.forEach((rule, index) => {
    const rulePath = `rules[${String(index)}]`;
    const targetEffective = effectiveMap.get(rule.node);
    if (targetEffective === undefined) {
      problems.push({
        path: `${rulePath}.node`,
        code: 'unknown-node',
        message: `'${rule.node}' does not name a node in this blueprint.`,
      });
      return;
    }

    const resolution = resolveFieldRef(rule.field, { existing: targetEffective, added: [] });
    if (!resolution.ok) {
      problems.push({
        path: `${rulePath}.field`,
        code: resolution.code,
        message:
          resolution.code === 'unknown'
            ? `'${rule.field}' does not name a field on '${rule.node}'.`
            : `'${rule.field}' could mean ${resolution.candidates.join(' or ')}; say which.`,
      });
      return;
    }

    const dedupeKey = `${rule.node}:${resolution.key}`;
    if (seenNodeField.has(dedupeKey)) {
      problems.push({
        path: rulePath,
        code: 'duplicate-rule',
        message: `'${rule.node}' already has an initialization rule for this field.`,
      });
    }
    seenNodeField.add(dedupeKey);

    if (rule.kind !== 'input' && rule.kind !== 'relativeDate') {
      return;
    }

    const input = rule.input !== undefined ? inputByKey.get(rule.input) : undefined;
    if (input === undefined) {
      problems.push({
        path: `${rulePath}.input`,
        code: 'unknown-input',
        message: `'${rule.input ?? ''}' does not name a template input.`,
      });
      return;
    }

    if (rule.kind === 'relativeDate' && input.type !== 'date') {
      problems.push({
        path: `${rulePath}.input`,
        code: 'relative-date-needs-date-input',
        message: `A relative date rule needs a date input; '${input.key}' is ${input.type}.`,
      });
    }

    if (rule.kind === 'input') {
      // An `input` rule writes the input's answer straight into the field, so the two must agree
      // in shape: a date-shaped field needs a date input, and every other field needs text -
      // architecture 2.3 gives `TemplateInputSpec` only these two types, so "matching type" can
      // only mean this one split.
      const targetField = targetEffective.find((property) => property.key === resolution.key);
      const expectedType =
        targetField !== undefined && isDateShaped(targetField.type) ? 'date' : 'text';
      if (input.type !== expectedType) {
        problems.push({
          path: `${rulePath}.input`,
          code: 'input-type-mismatch',
          message: `'${input.key}' is a ${input.type} input, but '${rule.field}' needs a ${expectedType} input.`,
        });
      }
    }
  });
}

function pushLimitProblem(problems: Problem[], code: string, message: string): void {
  problems.push({ path: 'root', code, message });
}

/**
 * Architecture 4's blueprint entry point, the tree-shaped counterpart to `validateSpec`
 * (task A.1c): one pure function used by the executor before any write, the approval card, and
 * later `validate_blueprint` and nixctl. Composes a `blueprintSchema` parse (problem paths read
 * like a Zod issue's own, matching `validateSpec`'s own convention), the effective-schema merge
 * (`effective.ts`, reusing `mergeProperties`), and the ported rule-parity functions `refuseSchema`
 * and `refuseViews` from A.1c, plus this module's own tree-shaped checks - rollups against
 * children, values, recurrence/habit, samples, template inputs and rules, and the tree-wide
 * limits (architecture 2.4).
 *
 * Formula validation and non-blocking blueprint design warnings are folded into the same report.
 */
export function validateBlueprint(bp: unknown, context: ValidationContext): ValidationReport {
  const parsed = blueprintSchema.safeParse(bp);
  if (!parsed.success) {
    return {
      ok: false,
      problems: zodIssuesToProblems(parsed.error),
      warnings: [],
      stats: { fields: 0, views: 0, entries: 0 },
    };
  }

  const blueprint = parsed.data;
  const problems: Problem[] = [];
  const warnings: Problem[] = [];

  const effectiveMap = effectiveSchemaPerNode(blueprint, context.inheritedFields);
  const stats = walkTree(blueprint, effectiveMap, problems);
  checkTemplateInputsAndRules(blueprint, effectiveMap, problems);
  problems.push(...validateFormulas(blueprint, effectiveMap));
  warnings.push(...collectWarnings(blueprint, effectiveMap));

  if (stats.totalNodes > LIMITS.blueprintNodes) {
    pushLimitProblem(
      problems,
      'too-many-nodes',
      `This design has ${String(stats.totalNodes)} items, more than the ${String(LIMITS.blueprintNodes)} a blueprint may hold.`,
    );
  }
  if (stats.nonSampleNodes > LIMITS.blueprintNonSampleNodes) {
    pushLimitProblem(
      problems,
      'too-many-non-sample-nodes',
      `This design has ${String(stats.nonSampleNodes)} structural items, more than the ${String(LIMITS.blueprintNonSampleNodes)} a blueprint may hold outside of samples.`,
    );
  }
  if (stats.maxDepth > LIMITS.blueprintDepth) {
    pushLimitProblem(
      problems,
      'too-deep',
      `This design nests ${String(stats.maxDepth)} levels deep, more than the ${String(LIMITS.blueprintDepth)} a blueprint may hold.`,
    );
  }
  if (stats.totalFields > LIMITS.fieldsPerBlueprint) {
    pushLimitProblem(
      problems,
      'too-many-fields',
      `This design declares ${String(stats.totalFields)} fields, more than the ${String(LIMITS.fieldsPerBlueprint)} a blueprint may hold.`,
    );
  }
  if (stats.totalViews > LIMITS.viewsPerBlueprint) {
    pushLimitProblem(
      problems,
      'too-many-views',
      `This design declares ${String(stats.totalViews)} views, more than the ${String(LIMITS.viewsPerBlueprint)} a blueprint may hold.`,
    );
  }
  if (stats.sampleNodes > LIMITS.sampleEntries) {
    pushLimitProblem(
      problems,
      'too-many-samples',
      `This design has ${String(stats.sampleNodes)} sample items, more than the ${String(LIMITS.sampleEntries)} a blueprint may hold.`,
    );
  }

  // A plain node with declared fields or inherit:false needs its own schema write. Structured
  // nodes and those plain nodes set their values after schema creation. Count every write before
  // approval, including optional sandbox creation, so the executor's 80-write bound agrees.
  const plannedWrites =
    stats.totalNodes +
    stats.schemaWrites +
    stats.propertyWrites +
    stats.markdownWrites +
    stats.recurrenceWrites +
    stats.habitWrites +
    1;
  if (plannedWrites > LIMITS.plannedWritesPerBuild) {
    pushLimitProblem(
      problems,
      'too-many-writes',
      'The design is too large. Use fewer items and fields.',
    );
  }

  return {
    ok: problems.length === 0,
    problems,
    warnings,
    stats: { fields: stats.totalFields, views: stats.totalViews, entries: stats.sampleNodes },
  };
}
