import { propertyFormulaProblem } from '@nix/sheet';

import { LIMITS } from '../catalog/tables.js';

import type { StructureProperty, StructureView } from '../types.js';
import type { FieldSpec } from '../spec/field.js';
import { fieldsSpecSchema, formEditSpecSchema, recurrenceSpecSchema } from '../spec/edits.js';
import {
  type EntriesSpec,
  applySpecSchema,
  entriesSpecSchema,
  structuredSpecSchema,
  viewSetupSpecSchema,
} from '../spec/operations.js';
import { isTitleColumnReference, type ViewSpec } from '../spec/view.js';
import { mergeProperties } from '../vocabulary/merge-properties.js';
import { TYPE_GROUP_KEY } from '../vocabulary/property-types.js';
import { compileFields } from '../compile/fields.js';
import { compileView, isStructuralField } from '../compile/views.js';
import { tryResolveKey } from '../compile/resolve.js';
import { refuseSchema } from './schema-rules.js';
import { refuseViews } from './view-rules.js';
import { validateValue } from './values.js';
import {
  refFailureMessage,
  zodIssuesToProblems,
  type Problem,
  type ValidationContext,
  type ValidationReport,
} from './report.js';
import { validateUpdateView } from './update-view.js';

export type SpecOperation =
  | 'create_structured'
  | 'add_view'
  | 'update_view'
  | 'create_entries'
  | 'apply_template'
  | 'add_fields'
  | 'edit_fields'
  | 'edit_form'
  | 'set_recurrence';

interface RefScope {
  existing: readonly StructureProperty[];
  added: readonly StructureProperty[];
}

function statsFromRaw(raw: unknown): ValidationReport['stats'] {
  const record = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  return {
    fields: Array.isArray(record.fields) ? record.fields.length : 0,
    views: Array.isArray(record.views) ? record.views.length : 0,
    entries: Array.isArray(record.entries) ? record.entries.length : 0,
  };
}

/**
 * Resolves one `FieldRef`, pushing a problem when it does not resolve. `undefined` is a ref this
 * operation never supplied, which is not itself a problem - the caller's own presence check (a
 * kind requirement, for example) is where that gets refused.
 */
function resolveRef(
  ref: string | undefined,
  scope: RefScope,
  path: string,
  problems: Problem[],
): string | null {
  if (ref === undefined) {
    return null;
  }
  const resolution = tryResolveKey(
    ref,
    [...scope.existing, ...scope.added],
    new Set(scope.added.map((field) => field.key)),
  );
  if (!resolution.ok) {
    problems.push({ path, code: resolution.code, message: refFailureMessage(ref, resolution) });
    return null;
  }
  return resolution.key;
}

function compileFieldSpecs(
  specs: readonly FieldSpec[],
  existing: readonly StructureProperty[],
  path: string,
  problems: Problem[],
): StructureProperty[] {
  const prior: StructureProperty[] = [];
  const safeSpecs: FieldSpec[] = [];
  for (const [index, field] of specs.entries()) {
    let safeField = field;
    if (field.type === 'rollup' && field.rollup?.source !== undefined) {
      const resolution = tryResolveKey(
        field.rollup.source,
        [...existing, ...prior],
        new Set(prior.map((item) => item.key)),
      );
      if (!resolution.ok) {
        problems.push({
          path: `${path}[${String(index)}].rollup.source`,
          code: resolution.code,
          message: refFailureMessage(field.rollup.source, resolution),
        });
        safeField = { ...field, rollup: { ...field.rollup, source: undefined } };
      }
    }
    safeSpecs.push(safeField);
    prior.splice(0, prior.length, ...compileFields(safeSpecs, { existing }).properties);
  }
  // Compile the full list through the same implementation used by execution. Per-field compilation
  // above only supplies context for rollup FieldRefs and protects reporting from compiler throws.
  return compileFields(safeSpecs, { existing }).properties;
}

function inspectFormRefs(
  view: ViewSpec,
  index: number,
  scope: RefScope,
  problems: Problem[],
): boolean {
  if (view.kind !== 'interactive_form' || view.form === undefined) return true;
  const form = view.form;
  const base = `views[${String(index)}].form`;
  const earlier = new Set<string>();
  let valid = true;
  const inspect = (ref: string, path: string, requireEarlier = false): string | null => {
    const key = resolveRef(ref, scope, path, problems);
    if (key === null) valid = false;
    else if (requireEarlier && !earlier.has(key)) {
      problems.push({
        path,
        code: 'form-order',
        message: `Field '${ref}' must have an earlier field block.`,
      });
      valid = false;
    }
    return key;
  };
  form.pages.forEach((page, pageIndex) => {
    page.showWhen?.forEach((condition, conditionIndex) => {
      inspect(
        condition.field,
        `${base}.pages[${String(pageIndex)}].showWhen[${String(conditionIndex)}].field`,
        true,
      );
    });
    page.blocks.forEach((block, blockIndex) => {
      if (!('field' in block)) return;
      const key = inspect(
        block.field,
        `${base}.pages[${String(pageIndex)}].blocks[${String(blockIndex)}].field`,
      );
      block.showWhen?.forEach((condition, conditionIndex) => {
        inspect(
          condition.field,
          `${base}.pages[${String(pageIndex)}].blocks[${String(blockIndex)}].showWhen[${String(conditionIndex)}].field`,
          true,
        );
      });
      if (key !== null) earlier.add(key);
    });
  });
  if (form.title?.from === 'field') {
    const key = inspect(form.title.field, `${base}.title.field`, true);
    if (key !== null && !earlier.has(key)) {
      problems.push({
        path: `${base}.title.field`,
        code: 'form-order',
        message: `Field '${form.title.field}' needs a field block in the form.`,
      });
      valid = false;
    }
  }
  return valid;
}

function compileViews(
  specs: readonly ViewSpec[],
  effective: readonly StructureProperty[],
  addedKeys: ReadonlySet<string>,
  problems: Problem[],
): StructureView[] {
  const usedIds = new Set<string>();
  const views: StructureView[] = [];
  specs.forEach((spec, index) => {
    const path = `views[${String(index)}]`;
    const scope = {
      existing: effective.filter((field) => !addedKeys.has(field.key)),
      added: effective.filter((field) => addedKeys.has(field.key)),
    };
    let valid = true;
    const check = (ref: string | undefined, suffix: string) => {
      if (ref !== undefined && resolveRef(ref, scope, `${path}.${suffix}`, problems) === null)
        valid = false;
    };
    // `$type` sections a list by body kind and names no property, so it has nothing to resolve.
    if (spec.groupBy !== TYPE_GROUP_KEY) check(spec.groupBy, 'groupBy');
    check(spec.date, 'date');
    check(spec.endDate, 'endDate');
    check(spec.cover, 'cover');
    check(spec.measureField, 'measureField');
    check(spec.doneProperty, 'doneProperty');
    check(spec.rowBy, 'rowBy');
    check(spec.columnBy, 'columnBy');
    check(spec.splitBy, 'splitBy');
    check(spec.sortBy, 'sortBy');
    spec.columns?.forEach((ref, columnIndex) => {
      if (!isTitleColumnReference(spec.kind, ref)) check(ref, `columns[${String(columnIndex)}]`);
    });
    spec.filters?.forEach((filter, filterIndex) => {
      // Structural fields ($type, ...) are not field references; view-rules polices them.
      if (!isStructuralField(filter.field)) {
        check(filter.field, `filters[${String(filterIndex)}].field`);
      }
    });
    valid = inspectFormRefs(spec, index, scope, problems) && valid;
    if (valid) views.push(compileView(spec, effective, usedIds, addedKeys));
  });
  return views;
}

/**
 * The additive-collision rule `StructuredItemSetup.HandleAsync`
 * (`backend/src/Nix.Api/Features/Views/StructuredItemSetup.cs`, around line 226) applies before
 * `PropertySchemaRules.Refuse` ever runs: an append refuses a key the effective schema already
 * has rather than silently overriding it, because `mergeProperties`'s nearest-wins rule is for
 * inheritance, not for two edits both claiming to be new.
 */
function refuseAdditiveCollisions(
  prior: readonly StructureProperty[],
  declared: readonly StructureProperty[],
): Problem[] {
  const existingKeys = new Set(prior.map((property) => property.key));
  const seen = new Set<string>();
  const problems: Problem[] = [];

  declared.forEach((property, index) => {
    if (existingKeys.has(property.key) || seen.has(property.key)) {
      problems.push({
        path: `fields[${String(index)}].key`,
        code: 'collision',
        message: `A field already uses '${property.key}'. Choose a different key for this field.`,
      });
    }
    seen.add(property.key);
  });

  return problems;
}

/**
 * Runs `refuseViews` once per view, with a precise `views[i]` path, rather than once over the
 * whole array with the bare path `views`. `refuseViews` itself still stops at the first reason
 * within one call - it mirrors Core's own `Refuse`, which does the same - so calling it once for
 * the whole array would let a second bad view go unreported whenever an earlier one already
 * failed. One call per view is what keeps the "every view gets its own chance to fail" promise
 * `validateSpec` makes.
 */
function pushViewProblems(
  views: readonly StructureView[],
  effective: readonly StructureProperty[],
  problems: Problem[],
): void {
  const localReasons = new Set<string>();
  views.forEach((view, index) => {
    const reason = refuseViews([view], effective, null);
    if (reason !== null) {
      localReasons.add(reason);
      problems.push({ path: `views[${String(index)}]`, code: 'views', message: reason });
    }
  });
  const setReason = refuseViews(views, effective, null);
  if (setReason !== null && !localReasons.has(setReason)) {
    problems.push({ path: 'views', code: 'views', message: setReason });
  }
}

function report(problems: Problem[], stats: ValidationReport['stats']): ValidationReport {
  return { ok: problems.length === 0, problems, warnings: [], stats };
}

function pushFormulaProblems(
  declared: readonly StructureProperty[],
  effective: readonly StructureProperty[],
  problems: Problem[],
): void {
  const keys = new Set(effective.map((field) => field.key));
  declared.forEach((field, index) => {
    if (field.type !== 'formula' || field.expression === null || field.expression === undefined)
      return;
    const reason = propertyFormulaProblem(field.expression, keys);
    if (reason !== null)
      problems.push({
        path: `fields[${String(index)}].formula`,
        code: 'formula.invalid_expression',
        message: `Formula '${field.key}': ${reason}`,
      });
  });
}

function validateCreateStructured(raw: unknown, context: ValidationContext): ValidationReport {
  const stats = statsFromRaw(raw);
  const parsed = structuredSpecSchema.safeParse(raw);
  if (!parsed.success) {
    return report(zodIssuesToProblems(parsed.error), stats);
  }
  const spec = parsed.data;
  const problems: Problem[] = [];

  const priorFields = spec.inherit ? context.inheritedFields : [];
  const declared = compileFieldSpecs(spec.fields, priorFields, 'fields', problems);
  const effective = mergeProperties(priorFields, declared);
  pushFormulaProblems(declared, effective, problems);

  // Core refuses a child's schema when inherited properties are present too; keep that deliberate
  // stricter check across ancestors, matching the effective schema the operation will compile.
  const schemaProblem = refuseSchema({ properties: effective, inherit: spec.inherit });
  if (schemaProblem !== null) {
    problems.push({ path: 'fields', code: 'schema', message: schemaProblem });
  }

  const addedKeys = new Set(declared.map((property) => property.key));
  const views = compileViews(spec.views ?? [], effective, addedKeys, problems);
  pushViewProblems(views, effective, problems);

  return report(problems, { ...stats, fields: spec.fields.length, views: views.length });
}

function validateAddView(raw: unknown, context: ValidationContext): ValidationReport {
  const stats = statsFromRaw(raw);
  const parsed = viewSetupSpecSchema.safeParse(raw);
  if (!parsed.success) {
    return report(zodIssuesToProblems(parsed.error), stats);
  }
  const spec = parsed.data;
  const problems: Problem[] = [];
  const existingViewCount = context.existing?.views.length ?? 0;
  const remainingViews = Math.max(0, LIMITS.viewsPerContainer - existingViewCount);
  if (spec.views.length > remainingViews) {
    problems.push({
      path: 'views',
      code: 'view-capacity',
      message: `This item has ${String(existingViewCount)} views and room for ${String(remainingViews)} more (${String(LIMITS.viewsPerContainer)} total). Adding ${String(spec.views.length)} would create ${String(existingViewCount + spec.views.length)}; request at most ${String(remainingViews)}.`,
    });
  }

  const priorDeclared = context.existing?.declared ?? [];
  const priorEffective = mergeProperties(context.inheritedFields, priorDeclared);
  const declared = compileFieldSpecs(spec.fields ?? [], priorEffective, 'fields', problems);
  problems.push(...refuseAdditiveCollisions(priorEffective, declared));

  const effective = mergeProperties(priorEffective, declared);
  pushFormulaProblems(declared, effective, problems);
  const schemaProblem = refuseSchema({ properties: effective, inherit: true });
  if (schemaProblem !== null) {
    problems.push({ path: 'fields', code: 'schema', message: schemaProblem });
  }

  const addedKeys = new Set(declared.map((property) => property.key));
  const views = compileViews(spec.views, effective, addedKeys, problems);
  pushViewProblems(views, effective, problems);

  return report(problems, { ...stats, fields: (spec.fields ?? []).length, views: views.length });
}

function validateCreateEntries(raw: unknown, context: ValidationContext): ValidationReport {
  const stats = statsFromRaw(raw);
  const parsed = entriesSpecSchema.safeParse(raw);
  if (!parsed.success) {
    return report(zodIssuesToProblems(parsed.error), stats);
  }
  const spec: EntriesSpec = parsed.data;
  const problems: Problem[] = [];

  const effective = mergeProperties(context.inheritedFields, context.existing?.declared ?? []);
  const scope: RefScope = { existing: effective, added: [] };

  spec.entries.forEach((entry, entryIndex) => {
    if (entry.values === undefined) {
      return;
    }
    for (const [ref, value] of Object.entries(entry.values)) {
      const path = `entries[${String(entryIndex)}].values.${ref}`;
      const key = resolveRef(ref, scope, path, problems);
      if (key === null) {
        continue;
      }
      const property = effective.find((candidate) => candidate.key === key);
      if (property === undefined) {
        continue;
      }
      const valueProblem = validateValue(property, value);
      if (valueProblem !== null) {
        problems.push({ path, code: 'value', message: valueProblem });
      }
    }
  });

  return report(problems, { ...stats, entries: spec.entries.length });
}

function validateApplyTemplate(raw: unknown): ValidationReport {
  const stats = statsFromRaw(raw);
  const parsed = applySpecSchema.safeParse(raw);
  if (!parsed.success) {
    return report(zodIssuesToProblems(parsed.error), stats);
  }
  return report([], stats);
}

function validateAddFields(raw: unknown, context: ValidationContext): ValidationReport {
  const stats = statsFromRaw(raw);
  const parsed = fieldsSpecSchema.safeParse(raw);
  if (!parsed.success) return report(zodIssuesToProblems(parsed.error), stats);

  const problems: Problem[] = [];
  const priorEffective = mergeProperties(context.inheritedFields, context.existing?.declared ?? []);
  const declared = compileFieldSpecs(parsed.data.fields, priorEffective, 'fields', problems);
  problems.push(...refuseAdditiveCollisions(priorEffective, declared));

  const effective = mergeProperties(priorEffective, declared);
  pushFormulaProblems(declared, effective, problems);
  const schemaProblem = refuseSchema({
    properties: effective,
    inherit: context.existing?.inherit ?? true,
  });
  if (schemaProblem !== null)
    problems.push({ path: 'fields', code: 'schema', message: schemaProblem });

  return report(problems, { fields: declared.length, views: 0, entries: 0 });
}

function validateEditForm(raw: unknown, context: ValidationContext): ValidationReport {
  const stats = statsFromRaw(raw);
  const parsed = formEditSpecSchema.safeParse(raw);
  if (!parsed.success) return report(zodIssuesToProblems(parsed.error), stats);

  const spec = parsed.data;
  const problems: Problem[] = [];
  const targetView = context.existing?.views.find((view) => view.id === spec.viewId);
  if (targetView === undefined) {
    problems.push({
      path: 'viewId',
      code: 'unknown-view',
      message: `View '${spec.viewId}' does not exist on this item.`,
    });
  } else if (targetView.kind !== 'interactive_form') {
    problems.push({
      path: 'viewId',
      code: 'not-interactive-form',
      message: `View '${spec.viewId}' is not an interactive form.`,
    });
  }

  const priorEffective = mergeProperties(context.inheritedFields, context.existing?.declared ?? []);
  const newFields = compileFieldSpecs(spec.fields ?? [], priorEffective, 'fields', problems);
  problems.push(...refuseAdditiveCollisions(priorEffective, newFields));
  const effective = mergeProperties(priorEffective, newFields);
  pushFormulaProblems(newFields, effective, problems);
  const schemaProblem = refuseSchema({
    properties: effective,
    inherit: context.existing?.inherit ?? true,
  });
  if (schemaProblem !== null)
    problems.push({ path: 'fields', code: 'schema', message: schemaProblem });

  const addedKeys = new Set(newFields.map((field) => field.key));
  const formView: ViewSpec = { kind: 'interactive_form', form: spec.form };
  const compiled = compileViews([formView], effective, addedKeys, problems);
  pushViewProblems(compiled, effective, problems);

  return report(problems, { fields: newFields.length, views: 1, entries: 0 });
}

function validateSetRecurrence(raw: unknown, context: ValidationContext): ValidationReport {
  const parsed = recurrenceSpecSchema.safeParse(raw);
  if (!parsed.success)
    return report(zodIssuesToProblems(parsed.error), { fields: 0, views: 0, entries: 0 });

  const problems: Problem[] = [];
  const effective = mergeProperties(context.inheritedFields, context.existing?.declared ?? []);
  const dueDate = effective.find((property) => property.type === 'due_date');
  if (dueDate === undefined) {
    problems.push({
      path: 'recurrence',
      code: 'recurrence-needs-due-date',
      message: 'Recurrence needs a due_date field in the item’s effective schema.',
    });
  } else {
    const value = context.itemValues?.[dueDate.key];
    const valueProblem = validateValue(dueDate, value);
    if (value === undefined || value === null || valueProblem !== null) {
      problems.push({
        path: 'recurrence',
        code: 'recurrence-needs-due-date-value',
        message: 'Recurrence needs a valid due_date value on this item.',
      });
    }
  }

  return report(problems, { fields: 0, views: 0, entries: 0 });
}

/**
 * The one entry point every caller uses to check a pet's proposed spec before any write:
 * `runWorkspaceTool` (`packages/companion`, once A.1d wires it in), the approval card, and
 * `nixctl`. Composes a Zod parse (problem paths read like a Zod issue's own), the field compiler,
 * the effective-schema merge (`mergeProperties`), the two ported rule-parity functions
 * (`refuseSchema`, `refuseViews`), and - for entries - `validateValue` against every value a pet
 * proposed.
 *
 * The problem list is exhaustive at the level this function controls: every field-ref resolution,
 * every view, and every entry value gets its own chance to fail, rather than stopping at the
 * first one - a pet correcting one mistake at a time against a request that hides the rest is a
 * worse conversation than one told everything at once. `refuseViews` is called once per compiled
 * view for exactly this reason: it stops at Core's own first reason within one call, so calling it
 * once per view is what keeps a second bad view from going unreported because an earlier one
 * already failed. `refuseSchema`, by contrast, is still one call over the whole schema - Core's
 * own rule is schema-wide (a duplicate key, a cycle) in a way that does not decompose per field -
 * so it still returns only its first reason.
 */
export function validateSpec(
  op: SpecOperation,
  spec: unknown,
  context: ValidationContext,
): ValidationReport {
  switch (op) {
    case 'create_structured':
      return validateCreateStructured(spec, context);
    case 'add_view':
      return validateAddView(spec, context);
    case 'update_view':
      return validateUpdateView(spec, context);
    case 'create_entries':
      return validateCreateEntries(spec, context);
    case 'apply_template':
      return validateApplyTemplate(spec);
    case 'edit_fields':
      return validateEditFields(spec, context);
    case 'add_fields':
      return validateAddFields(spec, context);
    case 'edit_form':
      return validateEditForm(spec, context);
    case 'set_recurrence':
      return validateSetRecurrence(spec, context);
  }
}

function validateEditFields(raw: unknown, context: ValidationContext): ValidationReport {
  const stats = statsFromRaw(raw);
  const parsed = fieldsSpecSchema.safeParse(raw);
  if (!parsed.success) return report(zodIssuesToProblems(parsed.error), stats);
  const problems: Problem[] = [];
  const declared = context.existing?.declared ?? [];
  for (const [index, field] of parsed.data.fields.entries()) {
    if (!field.key || !declared.some((property) => property.key === field.key)) {
      problems.push({
        path: `fields[${String(index)}].key`,
        code: 'unknown',
        message:
          'Use the exact key of a field declared on this item. Inherited fields must be edited at their source.',
      });
    }
  }
  const changes = compileFieldSpecs(
    parsed.data.fields,
    mergeProperties(context.inheritedFields, context.existing?.declared ?? []),
    'fields',
    problems,
  );
  if (new Set(changes.map((field) => field.key)).size !== changes.length)
    problems.push({
      path: 'fields',
      code: 'duplicate',
      message: 'Each field may be edited only once.',
    });
  const effective = mergeProperties(
    mergeProperties(context.inheritedFields, context.existing?.declared ?? []),
    changes,
  );
  const refusal = refuseSchema({
    properties: effective,
    inherit: context.existing?.inherit ?? true,
  });
  if (refusal) problems.push({ path: 'fields', code: 'schema', message: refusal });
  pushFormulaProblems(changes, effective, problems);
  pushViewProblems(context.existing?.views ?? [], effective, problems);
  return report(problems, stats);
}
