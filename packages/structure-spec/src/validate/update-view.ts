import { updateViewSpecSchema, type UpdateViewPatch } from '../spec/update-view.js';
import { applyViewPatch } from '../compile/view-patch.js';
import { mergeProperties } from '../vocabulary/merge-properties.js';
import { isDateShaped, TYPE_GROUP_KEY } from '../vocabulary/property-types.js';
import type { StructureProperty } from '../types.js';
import type { Problem, ValidationContext, ValidationReport } from './report.js';
import { refuseViews } from './view-rules.js';
import { isRealCalendarDay } from './values.js';

const common = ['name'];
// Mirrors the web registry's saved row rules. Tree, intake and independently queried views do
// not apply those rules, so storing a requested filter or sort there would imply a false fix.
const appliesRowRules = new Set([
  'list',
  'board',
  'calendar',
  'timeline',
  'gallery',
  'sheet',
  'query',
  'checklist',
  'matrix',
]);
const perKind: Readonly<Record<string, readonly string[]>> = {
  list: ['columns', 'groupBy', 'groupOrder'],
  board: ['groupBy', 'groupOrder'],
  calendar: ['dateProperty', 'endDateProperty', 'mode'],
  timeline: ['dateProperty', 'endDateProperty', 'mode'],
  gallery: ['columns', 'coverProperty', 'cardSize'],
  sheet: ['columns'],
  form: ['columns', 'mode'],
  interactive_form: ['mode'],
  query: [],
  chart: ['groupBy', 'groupOrder', 'measure', 'measureProperty', 'chart'],
  habit_tracker: [],
  checklist: ['columns', 'doneProperty'],
  matrix: ['columns', 'groupBy', 'groupOrder', 'rowBy'],
  outline: [],
  chat: [],
  custom: ['program'],
  drive: ['layout'],
};

function report(problems: Problem[], warnings: Problem[] = []): ValidationReport {
  return {
    ok: problems.length === 0,
    problems,
    warnings,
    stats: { fields: 0, views: 1, entries: 0 },
  };
}

function checkReferences(
  patch: UpdateViewPatch,
  effective: readonly StructureProperty[],
  problems: Problem[],
): void {
  const keys = new Set(effective.map((property) => property.key));
  const reference = (
    key: string | null | undefined,
    path: string,
    special: readonly string[] = [],
  ) => {
    if (key != null && !keys.has(key) && !special.includes(key)) {
      problems.push({
        path,
        code: 'unknown-field',
        message: `'${key}' is not an exact effective field key on this item.`,
      });
    }
  };
  for (const field of [
    'groupBy',
    'dateProperty',
    'endDateProperty',
    'sortBy',
    'coverProperty',
    'measureProperty',
    'doneProperty',
    'rowBy',
  ] as const) {
    reference(
      patch[field],
      `patch.${field}`,
      field === 'groupBy' ? [TYPE_GROUP_KEY] : field === 'sortBy' ? ['title'] : [],
    );
  }
  patch.columns?.forEach((key, index) => {
    reference(key, `patch.columns[${String(index)}]`, ['title']);
  });
  reference(patch.chart?.splitBy, 'patch.chart.splitBy');
  patch.filters?.forEach((entry, index) => {
    const conditions = 'any' in entry ? entry.any : [entry];
    conditions.forEach((condition, conditionIndex) => {
      if (!condition.property.startsWith('$'))
        reference(
          condition.property,
          `patch.filters[${String(index)}]${'any' in entry ? `.any[${String(conditionIndex)}]` : ''}.property`,
        );
    });
  });
  for (const field of ['dateProperty', 'endDateProperty'] as const) {
    const key = patch[field];
    const property = effective.find((candidate) => candidate.key === key);
    if (property !== undefined && !isDateShaped(property.type)) {
      problems.push({
        path: `patch.${field}`,
        code: 'field-type',
        message: `'${key ?? ''}' must be a date property.`,
      });
    }
  }
}

/** Validates against the full current view set, including retained companion and form settings. */
export function validateUpdateView(raw: unknown, context: ValidationContext): ValidationReport {
  const parsed = updateViewSpecSchema.safeParse(raw);
  if (!parsed.success) {
    return report(
      parsed.error.issues.map((issue) => ({
        path: issue.path.map(String).join('.'),
        code: issue.code,
        message: issue.message,
      })),
    );
  }
  const spec = parsed.data;
  const views = context.existing?.views ?? [];
  const target = views.find((view) => view.id === spec.viewId);
  if (target === undefined)
    return report([
      {
        path: 'viewId',
        code: 'unknown-view',
        message: `View '${spec.viewId}' does not exist on this item.`,
      },
    ]);
  const problems: Problem[] = [];
  const warnings: Problem[] = [];
  if (target.kind === 'chart') {
    if (spec.patch.filters !== undefined) {
      problems.push({
        path: 'patch.filters',
        code: 'unsupported-setting',
        message:
          'Chart filters cannot be changed here because the current chart does not apply saved filters.',
      });
    } else if (target.filters.length > 0) {
      warnings.push({
        path: 'patch.filters',
        code: 'filters-not-applied',
        message:
          'This chart keeps saved filters that its totals do not apply. The resulting chart totals must not be described as filtered.',
      });
    }
  }
  const allowed = new Set([
    ...common,
    ...(appliesRowRules.has(target.kind) ? ['filters', 'sortBy', 'sortDescending'] : []),
    ...(perKind[target.kind] ?? []),
  ]);
  if (perKind[target.kind] === undefined)
    problems.push({
      path: 'viewId',
      code: 'unsupported-view',
      message: `A '${target.kind}' view cannot be refined with this tool.`,
    });
  for (const key of Object.keys(spec.patch)) {
    if (!allowed.has(key))
      problems.push({
        path: `patch.${key}`,
        code: 'view-kind',
        message: `${key} is not valid on a ${target.kind} view.`,
      });
  }
  const effective = mergeProperties(context.inheritedFields, context.existing?.declared ?? []);
  checkReferences(spec.patch, effective, problems);
  if (
    spec.patch.columns !== undefined &&
    new Set(spec.patch.columns).size !== spec.patch.columns.length
  )
    problems.push({
      path: 'patch.columns',
      code: 'duplicate',
      message: 'Columns must not contain duplicates.',
    });
  if (
    spec.patch.groupOrder !== undefined &&
    new Set(spec.patch.groupOrder).size !== spec.patch.groupOrder.length
  )
    problems.push({
      path: 'patch.groupOrder',
      code: 'duplicate',
      message: 'Group order must not contain duplicates.',
    });
  const mode = spec.patch.mode;
  if (
    mode !== undefined &&
    mode !== null &&
    ((target.kind === 'calendar' && !['day', 'week', 'month'].includes(mode)) ||
      (target.kind === 'timeline' && !['week', 'month', 'quarter'].includes(mode)) ||
      (['form', 'interactive_form'].includes(target.kind) &&
        !['saved', 'temporary'].includes(mode)))
  )
    problems.push({
      path: 'patch.mode',
      code: 'view-mode',
      message: `The mode '${mode}' is not valid on a ${target.kind} view.`,
    });
  for (const field of ['from', 'to'] as const) {
    const value = spec.patch.chart?.[field];
    if (value != null && !isRealCalendarDay(value))
      problems.push({
        path: `patch.chart.${field}`,
        code: 'date',
        message: `'${value}' is not a real calendar day.`,
      });
  }
  const updated = applyViewPatch(target, spec);
  const reason = refuseViews(
    views.map((view) => (view.id === spec.viewId ? updated : view)),
    effective,
    context.existing?.defaultViewId ?? null,
  );
  if (reason !== null) problems.push({ path: 'patch', code: 'views', message: reason });
  return report(problems, warnings);
}
