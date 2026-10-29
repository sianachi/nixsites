import { LIMITS } from '../catalog/tables.js';
import type {
  StructureFilter,
  StructureFilterEntry,
  StructureForm,
  StructureFormCondition,
  StructureHabitWidget,
  StructureProperty,
  StructureView,
} from '../types.js';
import {
  canChartBy,
  canSplitBy,
  canGroupBy,
  canSectionBy,
  isComputedType,
  isDateShaped,
  TYPE_GROUP_KEY,
  valueShapeOf,
} from '../vocabulary/property-types.js';
import { isRealCalendarDay } from './values.js';

/** `ViewDefinitionsJson.MaximumViews` (`backend/src/Nix.Api/Domain/Views/ViewDefinitionsJson.cs:79`). */
const MAXIMUM_VIEWS = LIMITS.viewsPerContainer;
/** `ViewDefinitionsJson.DocumentView` - reserved for an item's own body, never a stored view. */
const RESERVED_VIEW_ID = 'document';
const CARD_SIZES: ReadonlySet<string> = new Set(['small', 'medium', 'large']);
const LAYOUTS: ReadonlySet<string> = new Set(['list', 'grid']);
/** `ViewOpenModes.All` (`backend/src/Nix.Api/Domain/Views/ViewDefinition.cs`); the message lists them in this order. */
const OPEN_MODES: readonly string[] = ['page', 'dialog', 'beside', 'tab', 'none'];
const HABIT_WIDGET_KINDS: ReadonlySet<string> = new Set(['completion', 'quantity', 'heatmap']);
const MAXIMUM_HABIT_WIDGETS = 12;
const MAXIMUM_HABIT_RANGE_DAYS = 366;
const MILLISECONDS_PER_DAY = 86_400_000;

/** `QueryOperators.All` (`backend/src/Nix.Api/Domain/Views/FilterRule.cs`). */
const KNOWN_FILTER_OPERATORS: ReadonlySet<string> = new Set([
  'equals',
  'not-equals',
  'on',
  'before',
  'on-or-after',
  'within-next',
  'within-last',
  'contains',
  'not-contains',
  'greater-than',
  'less-than',
  'is-empty',
  'is-not-empty',
]);
const DAY_FILTER_OPERATORS: ReadonlySet<string> = new Set(['on', 'before', 'on-or-after']);
const DAY_COUNT_FILTER_OPERATORS: ReadonlySet<string> = new Set(['within-next', 'within-last']);
const NUMBER_FILTER_OPERATORS: ReadonlySet<string> = new Set(['greater-than', 'less-than']);
const VALUELESS_FILTER_OPERATORS: ReadonlySet<string> = new Set(['is-empty', 'is-not-empty']);
const EQUALITY_FILTER_OPERATORS: ReadonlySet<string> = new Set(['equals', 'not-equals']);
/** `QueryOperators.DayTokens`: resolved from the reader's today when the query runs. */
const DAY_TOKENS: ReadonlySet<string> = new Set([
  'today',
  'start-of-week',
  'start-of-month',
  'same-day-last-week',
  'same-day-last-month',
]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMBER_PATTERN = /^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/;
const KNOWN_CONDITION_OPERATORS: ReadonlySet<string> = new Set([
  'equals',
  'not_equals',
  'contains',
  'checked',
  'not_checked',
]);
const VALUE_REQUIRED_CONDITION_OPERATORS: ReadonlySet<string> = new Set([
  'equals',
  'not_equals',
  'contains',
]);
const VALUE_FORBIDDEN_CONDITION_OPERATORS: ReadonlySet<string> = new Set([
  'checked',
  'not_checked',
]);

const WITHIN_NEXT_MAXIMUM_DAYS = 365;
const MAXIMUM_FILTERS = 8;

function findByKey(
  effective: readonly StructureProperty[],
  key: string | null,
): StructureProperty | undefined {
  if (key === null) {
    return undefined;
  }
  return effective.find((property) => property.key === key);
}

/**
 * A board needs a property it can group by (`canGroupBy`) and a chart one it can bucket by
 * (`canChartBy`) - both a single select for now - and a calendar or timeline needs a
 * date-shaped one to place items by - the same requirement `ViewKinds.All`
 * (`backend/src/Nix.Api/Domain/Views/ViewDefinition.cs:182-252`) declares per kind. Stricter than
 * `ViewDefinitionRules.Refuse` actually enforces on write, though: that check only asks whether
 * the field is present (`ViewDefinitionRules.cs:43-47`), because `SetContainerViewsHandler.Validate`
 * is given no schema to check a key's type against. The type check exists only on the read path,
 * in `ViewDefinition.CanRender`. This function applies `CanRender`'s stricter rule at write time,
 * on purpose, so a pet is told before a view renders empty rather than after - the fixture cases
 * this reaches beyond Core's own `Refuse` are marked `"viewsScope": "client-only"` in
 * `fixtures/rule-parity.json` for exactly this reason.
 */
function refuseKindRequirement(
  view: StructureView,
  effective: readonly StructureProperty[],
): string | null {
  if (view.kind === 'chat') {
    const role = findByKey(effective, 'chat_role');
    if (
      role?.type !== 'select' ||
      role.choiceSource != null ||
      !['user', 'assistant', 'system'].every((option) => role.options.includes(option)) ||
      findByKey(effective, 'chat_text')?.type !== 'text' ||
      findByKey(effective, 'chat_created_at')?.type !== 'date' ||
      findByKey(effective, 'chat_author')?.type !== 'text'
    ) {
      return `'${view.name}': a chat needs chat_role (select: user, assistant, system), chat_text (text), chat_created_at (date), and chat_author (text) fields.`;
    }
  }

  if (view.kind === 'board') {
    const property = findByKey(effective, view.groupBy);
    if (property === undefined || !canGroupBy(property.type)) {
      return `'${view.name}': a board needs a property to group by.`;
    }
  }

  // A list's sections are optional, so only a grouping it was given is checked: it must be the
  // reserved body-kind key or a property with a closed set of values (`canSectionBy`). Core's own
  // list has no requirement and stores any key; this is the same client-only strictness as above,
  // so a pet hears before the list draws one heading per distinct free-text value.
  if (view.kind === 'list' && view.groupBy !== null && view.groupBy !== TYPE_GROUP_KEY) {
    const property = findByKey(effective, view.groupBy);
    if (property === undefined || !canSectionBy(property.type)) {
      return `'${view.name}': a list makes sections only from a select, a checkbox or $type.`;
    }
  }

  if (view.kind === 'matrix') {
    const columns = findByKey(effective, view.groupBy);
    if (columns === undefined || !canSectionBy(columns.type)) {
      return `'${view.name}': a matrix needs a select or checkbox for its columns.`;
    }
    const rows = findByKey(effective, view.rowBy ?? null);
    if (rows === undefined || !canSectionBy(rows.type)) {
      return `'${view.name}': a matrix needs a select or checkbox for its rows.`;
    }
    if (rows.key === columns.key) {
      return `'${view.name}': a matrix's rows and columns must be different properties.`;
    }
  }

  if (view.kind === 'checklist') {
    const reason = refuseChecklist(view, effective);
    if (reason !== null) {
      return reason;
    }
  }

  if (view.kind === 'chart') {
    const property = findByKey(effective, view.groupBy);
    if (property === undefined || !canChartBy(property.type)) {
      return `'${view.name}': a chart needs a property to group by.`;
    }
  }

  if (view.kind === 'calendar') {
    const property = findByKey(effective, view.dateProperty);
    if (property === undefined || !isDateShaped(property.type)) {
      return `'${view.name}': a calendar needs a date property.`;
    }
  }

  if (view.kind === 'timeline') {
    const property = findByKey(effective, view.dateProperty);
    if (property === undefined || !isDateShaped(property.type)) {
      return `'${view.name}': a timeline needs a date to start from.`;
    }
  }

  return null;
}

/**
 * A checklist needs something to tick: the checkbox it names, or - named nothing - a checkbox keyed
 * `done` or the schema's task completion, which is the renderer's own fallback order
 * (`packages/web-views/src/checklist/checklist-view.tsx`). Core's checklist has no requirement and
 * stores any key; this is the same client-only strictness as the board's, so a pet hears before
 * the checklist draws titles with no boxes.
 */
function refuseChecklist(
  view: StructureView,
  effective: readonly StructureProperty[],
): string | null {
  const named = view.doneProperty ?? null;
  if (named !== null) {
    const property = findByKey(effective, named);
    return property !== undefined && valueShapeOf(property.type) === 'checkbox'
      ? null
      : `'${view.name}': a checklist ticks a checkbox or completion property.`;
  }
  const fallback =
    effective.find(
      (property) => property.key === 'done' && valueShapeOf(property.type) === 'checkbox',
    ) ?? effective.find((property) => property.type === 'completion');
  return fallback === undefined
    ? `'${view.name}': a checklist needs a checkbox to tick; add a "done" checkbox or name one.`
    : null;
}

/**
 * The measure-validity check is real Core parity (`ViewDefinitionRules.cs:49-53` checks
 * `Measure` on every kind, and the "needs a property to total" check is chart-specific there too,
 * `:55-61`). The other two checks here are architecture 4 item 5's client-only additions: a
 * gallery cover must resolve to a picture property, and a chart's measure property must resolve
 * to a number. Core does not check either at the type level (a gallery with no cover, or one
 * pointed at the wrong type, still stores) - these exist so a pet is told before the card or the
 * bar draws nothing useful, not because Core will refuse them.
 */
function refuseMeasureAndCover(
  view: StructureView,
  effective: readonly StructureProperty[],
): string | null {
  if (view.kind === 'gallery' && view.coverProperty !== null) {
    const property = findByKey(effective, view.coverProperty);
    if (property?.type !== 'image') {
      return `'${view.name}': a gallery cover must be a picture property.`;
    }
  }

  // Core checks a view's `Measure` for every kind, not only `chart` (`ViewDefinitionRules.cs:49-53`)
  // - a stray `measure` on an unrelated view kind is still refused if it names something that
  // isn't `count` or `sum`.
  const measure = view.measure ?? null;
  if (measure !== null && measure !== 'count' && measure !== 'sum') {
    return `'${view.name}': '${measure}' is not a measure a chart can draw; use 'count' or 'sum'.`;
  }

  if (view.kind === 'chart' && view.measure === 'sum') {
    if (view.measureProperty === null || view.measureProperty === undefined) {
      return `'${view.name}' totals a property, so it needs one to total.`;
    }
    const property = findByKey(effective, view.measureProperty);
    if (property === undefined || valueShapeOf(property.type) !== 'number') {
      return `'${view.name}': a chart that totals needs a number property.`;
    }
  }

  return null;
}

const CHART_KINDS: ReadonlySet<string> = new Set(['bar', 'column', 'pie', 'line', 'area', 'year']);
const TIME_AXIS_CHART_KINDS: ReadonlySet<string> = new Set(['line', 'area', 'year']);
const CHART_PERIODS: ReadonlySet<string> = new Set(['day', 'week', 'month', 'quarter', 'year']);
/** `ChartOptions.MaximumPeriods`: 53 weeks of days, one year grid. */
const MAXIMUM_CHART_PERIODS = 371;

/**
 * Ports `ChartOptions.Refuse` (`backend/src/Nix.Api/Domain/Views/ChartOptions.cs`) - type and
 * period vocabulary, the time-axis types needing a period, the year grid counting by day, and the
 * window's shape - and adds two schema checks: a period needs the chart to group by a date
 * (client-only), and a split must be a choice type (`canSplitBy`, which Core also refuses on write
 * when the property exists), because a series per distinct free-text value is a legend nobody can
 * read.
 */
function refuseChartOptions(
  view: StructureView,
  effective: readonly StructureProperty[],
): string | null {
  const chart = view.chart ?? null;
  if (chart === null) {
    return null;
  }

  const kind = chart.kind ?? null;
  const period = chart.period ?? null;
  if (kind !== null && !CHART_KINDS.has(kind)) {
    return `'${view.name}': '${kind}' is not a chart type; use one of bar, column, pie, line, area, year.`;
  }
  if (period !== null && !CHART_PERIODS.has(period)) {
    return `'${view.name}': '${period}' is not a period; use one of day, week, month, quarter, year.`;
  }
  if (kind !== null && TIME_AXIS_CHART_KINDS.has(kind) && period === null) {
    return `'${view.name}': a ${kind} chart runs along dates, so it needs a date to group by and a period.`;
  }
  if (kind === 'year' && period !== 'day') {
    return `'${view.name}': a year grid counts by day; set its period to day.`;
  }

  const last = chart.lastPeriods ?? null;
  const from = chart.from ?? null;
  const to = chart.to ?? null;
  if ((last !== null || from !== null || to !== null) && period === null) {
    return `'${view.name}': a window of periods needs a period to count in.`;
  }
  if (last !== null && (from !== null || to !== null)) {
    return `'${view.name}': a window is either the last few periods or a range of dates, not both.`;
  }
  if (last !== null && (!Number.isInteger(last) || last < 1 || last > MAXIMUM_CHART_PERIODS)) {
    return `'${view.name}': a window may hold from 1 to ${String(MAXIMUM_CHART_PERIODS)} periods.`;
  }
  if (from !== null && to !== null && to < from) {
    return `'${view.name}': a window must end on or after the day it starts.`;
  }

  if (view.kind === 'chart' && period !== null) {
    const grouping = findByKey(effective, view.groupBy);
    if (grouping === undefined || !isDateShaped(grouping.type)) {
      return `'${view.name}': a chart with a period groups by a date property.`;
    }
  }

  const splitBy = chart.splitBy ?? null;
  if (view.kind === 'chart' && splitBy !== null) {
    const split = findByKey(effective, splitBy);
    if (split === undefined || !canSplitBy(split.type)) {
      return `'${view.name}': a chart splits into series by a select, checkbox or person property.`;
    }
  }

  return null;
}

/**
 * Ports `QueryOperators.Refuse` and `QueryFields.Refuse`
 * (`backend/src/Nix.Api/Domain/Views/FilterRule.cs`, `QueryFields.cs`): grammar only. Whether
 * `filter.property` names a real property is deliberately not asked here, for the same reason Core
 * does not ask it - a query view spans containers and a rule naming a property nothing declares
 * simply matches nothing.
 */
function refuseFilter(filter: StructureFilter): string | null {
  if (filter.property.length === 0) {
    return 'a filter needs a property to test';
  }
  if (filter.property.length > 128) {
    return "a filter's property key may be at most 128 characters";
  }
  if (!KNOWN_FILTER_OPERATORS.has(filter.operator)) {
    return `'${filter.operator}' is not a filter operator`;
  }
  if (VALUELESS_FILTER_OPERATORS.has(filter.operator)) {
    return filter.value.length === 0 ? null : `'${filter.operator}' takes no value`;
  }
  if (filter.value.length === 0) {
    return 'a filter needs a value to compare against';
  }
  if (filter.value.length > 512) {
    return "a filter's value may be at most 512 characters";
  }
  if (
    DAY_FILTER_OPERATORS.has(filter.operator) &&
    !DAY_TOKENS.has(filter.value) &&
    !isRealCalendarDay(filter.value)
  ) {
    return `'${filter.operator}' reads a day: 'today', 'start-of-week', 'start-of-month', 'same-day-last-week', 'same-day-last-month' or a date written yyyy-MM-dd`;
  }
  if (NUMBER_FILTER_OPERATORS.has(filter.operator) && !NUMBER_PATTERN.test(filter.value.trim())) {
    return `'${filter.operator}' reads a number, written like 12 or -3.5`;
  }
  if (DAY_COUNT_FILTER_OPERATORS.has(filter.operator)) {
    const days = Number(filter.value);
    if (!/^\d+$/.test(filter.value) || days < 1 || days > WITHIN_NEXT_MAXIMUM_DAYS) {
      return `'${filter.operator}' reads a number of days from 1 to ${String(WITHIN_NEXT_MAXIMUM_DAYS)}`;
    }
  }
  return filter.property.startsWith('$') ? refuseStructuralFilter(filter) : null;
}

/** Ports `QueryFields.Refuse`: which operators and values each structural field takes. */
function refuseStructuralFilter(filter: StructureFilter): string | null {
  switch (filter.property) {
    case '$type':
      return EQUALITY_FILTER_OPERATORS.has(filter.operator)
        ? null
        : "'$type' compares with 'equals' or 'not-equals'";
    case '$inside':
      if (!EQUALITY_FILTER_OPERATORS.has(filter.operator)) {
        return "'$inside' compares with 'equals' or 'not-equals'";
      }
      return UUID_PATTERN.test(filter.value) ? null : "'$inside' reads an item id";
    case '$created':
    case '$modified':
      return DAY_FILTER_OPERATORS.has(filter.operator) ||
        DAY_COUNT_FILTER_OPERATORS.has(filter.operator)
        ? null
        : `'${filter.property}' is a day, so it compares with the day operators`;
    case '$done':
      if (!EQUALITY_FILTER_OPERATORS.has(filter.operator)) {
        return "'$done' compares with 'equals' or 'not-equals'";
      }
      return filter.value === 'true' || filter.value === 'false'
        ? null
        : "'$done' reads true or false";
    case '$tag':
      return "'$tag' is reserved and cannot be filtered on yet";
    default:
      return `'${filter.property}' is not a field a query can test; names starting with '$' are reserved for $type, $inside, $created, $modified, $done`;
  }
}

/**
 * Ports `QueryRules.Refuse` (`backend/src/Nix.Api/Domain/Views/QueryRules.cs`): the ceiling across
 * groups, one level of "any of", each condition's grammar, and structural fields on queries only.
 */
function refuseFilters(filters: readonly StructureFilterEntry[], query: boolean): string | null {
  const count = filters.reduce(
    (total, entry) => total + ('any' in entry ? entry.any.length : 1),
    0,
  );
  if (count > MAXIMUM_FILTERS) {
    return `a view may carry at most ${String(MAXIMUM_FILTERS)} filters, counting those inside "any of" groups`;
  }
  for (const entry of filters) {
    const conditions = 'any' in entry ? entry.any : [entry];
    if ('any' in entry && entry.any.length === 0) {
      return 'an "any of" group needs at least one filter';
    }
    for (const condition of conditions) {
      if ('any' in condition) {
        return '"any of" groups do not nest; a group holds plain filters';
      }
      const reason = refuseFilter(condition);
      if (reason !== null) {
        return reason;
      }
      if (!query && condition.property.startsWith('$')) {
        return `only a query can filter by '${condition.property}'; a view filters its own children by their properties`;
      }
    }
  }
  return null;
}

/**
 * A form condition's operator and value must pair the way `condSchema` cannot enforce on its own
 * (per this task's card, "form condition op/value pairing"): the equality and `contains`
 * operators need a value to compare against, and the two checkbox operators - `checked`,
 * `not_checked` - ask a yes-or-no question that a value would only contradict.
 */
function refuseConditionValue(condition: StructureFormCondition): string | null {
  const hasValue = condition.value !== null && condition.value.length > 0;
  if (VALUE_REQUIRED_CONDITION_OPERATORS.has(condition.operator) && !hasValue) {
    return `has an '${condition.operator}' condition with no value to compare against`;
  }
  if (VALUE_FORBIDDEN_CONDITION_OPERATORS.has(condition.operator) && hasValue) {
    return `has a '${condition.operator}' condition that carries a value it does not use`;
  }
  return null;
}

function refuseCondition(
  conditions: readonly StructureFormCondition[],
  earlierFields: ReadonlySet<string>,
): string | null {
  for (const condition of conditions) {
    if (!earlierFields.has(condition.fieldBlockId)) {
      return 'has a condition that does not reference an earlier field';
    }
    if (!KNOWN_CONDITION_OPERATORS.has(condition.operator)) {
      return `uses unknown condition operator '${condition.operator}'`;
    }
    const valueProblem = refuseConditionValue(condition);
    if (valueProblem !== null) {
      return valueProblem;
    }
  }
  return null;
}

/**
 * Ports the form half of `ViewDefinitionRules.Refuse`
 * (`backend/src/Nix.Api/Domain/Views/ViewDefinitionRules.cs:152-260`), plus one addition the
 * server does not need: a field block may not name a computed property, because nothing a
 * respondent fills in can be written back to a formula or a rollup.
 */
function refuseForm(
  form: StructureForm | null | undefined,
  effective: readonly StructureProperty[],
): string | null {
  if (form === null || form === undefined || form.pages.length === 0) {
    return 'an interactive form needs at least one page';
  }
  if (form.titleMode !== 'generated' && form.titleMode !== 'field') {
    return 'the response title must be generated or taken from a field';
  }

  const byKey = new Map(effective.map((property) => [property.key, property]));
  const blockIds = new Set<string>();
  const fieldIds = new Set<string>();
  const earlierFields = new Set<string>();
  const pageIds = new Set<string>();
  const identityRoles = new Set<string>();

  for (const page of form.pages) {
    if (page.id.length === 0 || pageIds.has(page.id) || page.blocks.length === 0) {
      return 'every page needs a unique identifier and at least one block';
    }
    pageIds.add(page.id);

    const pageCondition = refuseCondition(page.visibleWhen, earlierFields);
    if (pageCondition !== null) {
      return `page '${page.id}' ${pageCondition}`;
    }

    for (const block of page.blocks) {
      if (block.id.length === 0 || blockIds.has(block.id)) {
        return 'every form block needs a unique identifier';
      }
      blockIds.add(block.id);

      if (
        block.kind === 'field' &&
        (block.propertyKey === null || block.propertyKey.trim().length === 0)
      ) {
        return `field '${block.id}' needs a property`;
      }

      if (block.kind !== 'field' && block.kind !== 'heading' && block.kind !== 'paragraph') {
        return `'${block.kind}' is not a form block kind`;
      }

      const blockCondition = refuseCondition(block.visibleWhen, earlierFields);
      if (blockCondition !== null) {
        return `block '${block.id}' ${blockCondition}`;
      }

      if (block.identityRole !== null) {
        if (
          block.kind !== 'field' ||
          (block.identityRole !== 'name' && block.identityRole !== 'email')
        ) {
          return `block '${block.id}' has an invalid respondent identity role`;
        }
        if (identityRoles.has(block.identityRole)) {
          return `respondent ${block.identityRole} may be assigned to only one field`;
        }
        identityRoles.add(block.identityRole);
      }

      if (block.kind === 'field') {
        const property = block.propertyKey !== null ? byKey.get(block.propertyKey) : undefined;
        if (property !== undefined && isComputedType(property.type)) {
          return `field '${block.id}' cannot use '${property.label}', which is computed`;
        }
        fieldIds.add(block.id);
        earlierFields.add(block.id);
      }
    }
  }

  if (
    form.titleMode === 'field' &&
    (form.titleFieldBlockId === null || !fieldIds.has(form.titleFieldBlockId))
  ) {
    return 'the response-title field must name a field block';
  }

  return null;
}

/**
 * Ports `ViewDefinitionRules.Refuse`'s habit-chart shape check
 * (`backend/src/Nix.Api/Domain/Views/ViewDefinitionRules.cs:75-91`): unique, bounded identifiers, a
 * supported chart kind, a habit, and an ordered range of at most 366 days. Dates are compared as
 * whole days, matching `DayNumber` subtraction there.
 */
function refuseHabitWidgets(view: StructureView): string | null {
  const widgets = view.habitWidgets ?? [];
  if (widgets.length === 0) {
    return null;
  }
  if (widgets.length > MAXIMUM_HABIT_WIDGETS) {
    return `A view may contain at most ${String(MAXIMUM_HABIT_WIDGETS)} habit charts.`;
  }

  const widgetIds = new Set<string>();
  for (const widget of widgets) {
    if (isWellFormedHabitWidget(widget, widgetIds)) {
      widgetIds.add(widget.id);
      continue;
    }
    return 'Habit charts need unique identifiers, a supported chart type, a habit, and an ordered range of at most 366 days.';
  }
  return null;
}

function isWellFormedHabitWidget(
  widget: StructureHabitWidget,
  seenIds: ReadonlySet<string>,
): boolean {
  if (
    widget.id.length === 0 ||
    widget.id.length > 128 ||
    seenIds.has(widget.id) ||
    !HABIT_WIDGET_KINDS.has(widget.kind) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(widget.habitId) ||
    !isCalendarDay(widget.from) ||
    !isCalendarDay(widget.to)
  ) {
    return false;
  }
  const rangeDays = daysBetween(widget.from, widget.to);
  return rangeDays >= 0 && rangeDays < MAXIMUM_HABIT_RANGE_DAYS;
}

function isCalendarDay(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && isRealCalendarDay(value);
}

function daysBetween(from: string, to: string): number {
  const fromDate = new Date(`${from}T00:00:00Z`).getTime();
  const toDate = new Date(`${to}T00:00:00Z`).getTime();
  return Math.round((toDate - fromDate) / MILLISECONDS_PER_DAY);
}

/**
 * Ports `ViewDefinitionRules.Refuse`'s companion-view checks
 * (`backend/src/Nix.Api/Domain/Views/ViewDefinitionRules.cs:110-133`): a companion must name
 * another view in the same set, must say where it sits, and a companion cannot itself carry a
 * companion (no nesting).
 */
function refuseCompanion(
  view: StructureView,
  views: readonly StructureView[],
  ids: ReadonlySet<string>,
): string | null {
  const companion = view.companionViewId ?? null;
  if (companion === null) {
    return view.companionPlacement != null
      ? `'${view.name}': companion placement needs a companion view.`
      : null;
  }

  if (!ids.has(companion) || companion === view.id) {
    return `'${view.name}': its companion must name another view in this item.`;
  }
  if (view.companionPlacement !== 'below' && view.companionPlacement !== 'beside') {
    return `'${view.name}': a companion must be placed 'below' or 'beside'.`;
  }
  const target = views.find((candidate) => candidate.id === companion);
  if (target?.companionViewId != null) {
    return `'${view.name}': companion views cannot contain another companion.`;
  }
  return null;
}

/**
 * Ports the view-writing rules a pet's compiled views must satisfy: the whole-set rules of
 * `ViewDefinitionRules.Refuse` (view count, identifiers, `cardSize`/`layout` vocabulary, habit
 * chart shape, companion placement, default-view membership - all "now reachable with real ids"
 * once the compiler, not a synthetic per-view id, produces every `StructureView.id`), the kind
 * requirements of `ViewKinds.All`, the filter grammar of `QueryOperators.Refuse`, and the form
 * rules of `ViewDefinitionRules.RefuseForm` - plus the two client-only additions architecture 4
 * item 5 calls for (gallery cover, chart measure) and the computed-field-in-a-form rule item 7
 * adds. Returns the first reason any view cannot be stored, or `null`, exactly as Core's own
 * `Refuse` does for one call over the whole set.
 */
export function refuseViews(
  views: readonly StructureView[],
  effective: readonly StructureProperty[],
  defaultId: string | null,
): string | null {
  if (views.length > MAXIMUM_VIEWS) {
    return `A container may offer at most ${String(MAXIMUM_VIEWS)} views.`;
  }

  const ids = new Set<string>();

  for (const view of views) {
    if (view.id.length === 0) {
      return 'Every view needs an identifier.';
    }
    if (ids.has(view.id)) {
      return `'${view.id}' is used by more than one view; a shared link names one view.`;
    }
    ids.add(view.id);

    if (view.name.length === 0) {
      return 'Every view needs a name.';
    }

    if (view.id === RESERVED_VIEW_ID) {
      return `'${RESERVED_VIEW_ID}' is reserved for the item's own body; give this view another name.`;
    }

    const kindProblem = refuseKindRequirement(view, effective);
    if (kindProblem !== null) {
      return kindProblem;
    }

    const measureProblem = refuseMeasureAndCover(view, effective);
    if (measureProblem !== null) {
      return measureProblem;
    }

    const chartProblem = refuseChartOptions(view, effective);
    if (chartProblem !== null) {
      return chartProblem;
    }

    if (view.cardSize !== null && !CARD_SIZES.has(view.cardSize)) {
      return `'${view.name}': '${view.cardSize}' is not a card size; use 'small', 'medium' or 'large'.`;
    }
    // `open` is optional on the wire; absent or null means the client's own default, as in Core.
    if (view.open != null && !OPEN_MODES.includes(view.open)) {
      return `'${view.name}': '${view.open}' is not an open mode; use one of ${OPEN_MODES.map((mode) => `'${mode}'`).join(', ')}.`;
    }
    if (view.layout !== null && !LAYOUTS.has(view.layout)) {
      return `'${view.name}': '${view.layout}' is not a layout; use 'list' or 'grid'.`;
    }

    const habitProblem = refuseHabitWidgets(view);
    if (habitProblem !== null) {
      return habitProblem;
    }

    if (view.filters.length > 0) {
      const reason = refuseFilters(view.filters, view.kind === 'query');
      if (reason !== null) {
        return `'${view.name}': ${reason}.`;
      }
    }

    if (view.kind === 'interactive_form') {
      const reason = refuseForm(view.interactiveForm, effective);
      if (reason !== null) {
        return `'${view.name}': ${reason}.`;
      }
    }
  }

  for (const view of views) {
    const companionProblem = refuseCompanion(view, views, ids);
    if (companionProblem !== null) {
      return companionProblem;
    }
  }

  if (
    defaultId !== null &&
    defaultId.length > 0 &&
    defaultId !== RESERVED_VIEW_ID &&
    !ids.has(defaultId)
  ) {
    return `'${defaultId}' is not one of these views, so it cannot be the one that opens.`;
  }

  return null;
}
