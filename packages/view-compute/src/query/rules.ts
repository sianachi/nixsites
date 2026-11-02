/* eslint-disable @typescript-eslint/no-non-null-assertion, @typescript-eslint/restrict-template-expressions -- ported refusal text interpolates Core's numeric limits; request-shape checks are narrowed by hand */
/**
 * The rule grammar and its refusals: port of `QueryOperators`, `QueryFields`, `QueryRules`,
 * `QueryEvaluation` and the request-shape checks of `FilterRuleContracts`. Messages are Core's,
 * word for word, because a client shows them.
 */

import {
  formatDay,
  parseDay,
  parseFiniteNumber,
  sameDayLastMonth,
  startOfMonth,
  startOfWeek,
} from './text';

export interface Rule {
  readonly property: string;
  readonly operator: string;
  readonly value: string;
  /** Set on an "any of" group only. */
  readonly any?: readonly Rule[];
}

export const isGroup = (rule: Rule): boolean => rule.any !== undefined && rule.any.length > 0;

export const OPERATORS = [
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
] as const;

const DAY_TOKENS = [
  'today',
  'start-of-week',
  'start-of-month',
  'same-day-last-week',
  'same-day-last-month',
];
const READS_DAY = ['on', 'before', 'on-or-after'];
const READS_DAY_COUNT = ['within-next', 'within-last'];
const MAXIMUM_RULES = 8;
const MAXIMUM_VALUE_LENGTH = 512;
export const MAXIMUM_PROPERTY_LENGTH = 128;
const MAXIMUM_WITHIN_DAYS = 365;
const MAXIMUM_TYPE_LENGTH = 64;

export const FILTERABLE = ['$type', '$inside', '$created', '$modified', '$done'];
export const SORTABLE = ['$type', '$created', '$modified'];
export const GROUPABLE = ['$type'];

export const isReserved = (name: string): boolean => name.startsWith('$');
export const isDayField = (field: string): boolean => field === '$created' || field === '$modified';
export const isDateShaped = (operator: string): boolean =>
  READS_DAY.includes(operator) || READS_DAY_COUNT.includes(operator);

/** The day a day operator's value names, resolved against the caller's today (epoch days). */
export function resolveDay(value: string, today: number): number | null {
  switch (value) {
    case 'today':
      return today;
    case 'start-of-week':
      return startOfWeek(today);
    case 'start-of-month':
      return startOfMonth(today);
    case 'same-day-last-week':
      return today - 7;
    case 'same-day-last-month':
      return sameDayLastMonth(today);
    default:
      return parseDay(value);
  }
}

/** Whether a rule can only be compiled once the caller's today is known. */
export const needsToday = (rule: Rule): boolean =>
  READS_DAY_COUNT.includes(rule.operator) ||
  (READS_DAY.includes(rule.operator) && DAY_TOKENS.includes(rule.value));

export function leaves(rules: readonly Rule[]): Rule[] {
  return rules.flatMap((rule) => (isGroup(rule) ? [...(rule.any ?? [])] : [rule]));
}

function refuseStructural(rule: Rule): string | null {
  const equality = rule.operator === 'equals' || rule.operator === 'not-equals';
  switch (rule.property) {
    case '$type':
      if (!equality) return "'$type' compares with 'equals' or 'not-equals'";
      return rule.value.length > MAXIMUM_TYPE_LENGTH
        ? `a '$type' value may be at most ${MAXIMUM_TYPE_LENGTH} characters`
        : null;
    case '$inside':
      if (!equality) return "'$inside' compares with 'equals' or 'not-equals'";
      return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
        rule.value,
      )
        ? null
        : "'$inside' reads an item id";
    case '$created':
    case '$modified':
      return isDateShaped(rule.operator)
        ? null
        : `'${rule.property}' is a day, so it compares with the day operators`;
    case '$done':
      if (!equality) return "'$done' compares with 'equals' or 'not-equals'";
      return rule.value === 'true' || rule.value === 'false' ? null : "'$done' reads true or false";
    case '$tag':
      return "'$tag' is reserved and cannot be filtered on yet";
    default:
      return `'${rule.property}' is not a field a query can test; names starting with '$' are reserved for ${FILTERABLE.join(', ')}`;
  }
}

/** `QueryOperators.Refuse`: the sentence refusing one leaf rule, or null. */
function refuseLeaf(rule: Rule): string | null {
  if (rule.property.length === 0) return 'a filter needs a property to test';
  if (rule.property.length > MAXIMUM_PROPERTY_LENGTH)
    return `a filter's property key may be at most ${MAXIMUM_PROPERTY_LENGTH} characters`;
  if (!(OPERATORS as readonly string[]).includes(rule.operator))
    return `'${rule.operator}' is not a filter operator`;
  if (rule.operator === 'is-empty' || rule.operator === 'is-not-empty')
    return rule.value.length === 0 ? null : `'${rule.operator}' takes no value`;
  if (rule.value.length === 0) return 'a filter needs a value to compare against';
  if (rule.value.length > MAXIMUM_VALUE_LENGTH)
    return `a filter's value may be at most ${MAXIMUM_VALUE_LENGTH} characters`;
  if (
    READS_DAY.includes(rule.operator) &&
    !DAY_TOKENS.includes(rule.value) &&
    parseDay(rule.value) === null
  )
    return `'${rule.operator}' reads a day: 'today', 'start-of-week', 'start-of-month', 'same-day-last-week', 'same-day-last-month' or a date written yyyy-MM-dd`;
  if (
    (rule.operator === 'greater-than' || rule.operator === 'less-than') &&
    parseFiniteNumber(rule.value) === null
  )
    return `'${rule.operator}' reads a number, written like 12 or -3.5`;
  if (READS_DAY_COUNT.includes(rule.operator)) {
    const days = /^\d+$/.test(rule.value) ? Number(rule.value) : NaN;
    if (!(days >= 1 && days <= MAXIMUM_WITHIN_DAYS))
      return `'${rule.operator}' reads a number of days from 1 to ${MAXIMUM_WITHIN_DAYS}`;
  }
  return isReserved(rule.property) ? refuseStructural(rule) : null;
}

/** `QueryRules.Refuse(rules, query: true)`: the sentence refusing a rule set, or null. */
export function refuseRules(rules: readonly Rule[]): string | null {
  if (rules.length === 0) return null;
  const count = rules.reduce((sum, rule) => sum + (isGroup(rule) ? (rule.any?.length ?? 0) : 1), 0);
  if (count > MAXIMUM_RULES)
    return `a view may carry at most ${MAXIMUM_RULES} filters, counting those inside "any of" groups`;
  for (const rule of rules) {
    if (!isGroup(rule)) {
      const reason = refuseLeaf(rule);
      if (reason !== null) return reason;
      continue;
    }
    if (rule.property.length !== 0 || rule.operator.length !== 0 || rule.value.length !== 0)
      return 'an "any of" group holds only its rules, with no property, operator or value of its own';
    for (const inner of rule.any ?? []) {
      if (isGroup(inner)) return '"any of" groups do not nest; a group holds plain filters';
      const reason = refuseLeaf(inner);
      if (reason !== null) return reason;
    }
  }
  return null;
}

/** `QueryEvaluation.ResolveCaller`: `me` becomes the caller on equalities only. */
export function resolveCaller(rules: readonly Rule[], callerId: string): Rule[] {
  const resolve = (rule: Rule): Rule =>
    rule.any !== undefined && rule.any.length > 0
      ? { ...rule, any: rule.any.map(resolve) }
      : (rule.operator === 'equals' || rule.operator === 'not-equals') && rule.value === 'me'
        ? { ...rule, value: callerId }
        : rule;
  return rules.map(resolve);
}

export const usesMe = (rules: readonly Rule[]): boolean =>
  leaves(rules).some(
    (rule) => (rule.operator === 'equals' || rule.operator === 'not-equals') && rule.value === 'me',
  );

export const PRESETS: Readonly<Record<string, readonly Rule[]>> = {
  today: [{ property: 'due_date', operator: 'on', value: 'today' }],
  'next-seven-days': [{ property: 'due_date', operator: 'within-next', value: '7' }],
  overdue: [
    { property: 'due_date', operator: 'before', value: 'today' },
    { property: 'completion', operator: 'not-equals', value: 'true' },
  ],
  'assigned-to-me': [{ property: 'assignee', operator: 'equals', value: 'me' }],
};

export interface Order {
  /** null is recency: most recently modified first. */
  readonly key: string | null;
  readonly isDay: boolean;
  readonly descending: boolean;
}

export const RECENCY: Order = { key: null, isDay: false, descending: false };

/** `QueryEvaluation.ResolveOrder`. */
export function resolveOrder(
  rules: readonly Rule[],
  explicit: Order | null,
  fallback: Order | null,
): Order {
  if (explicit !== null) return explicit;
  for (const rule of rules)
    if (!isGroup(rule) && isDateShaped(rule.operator))
      return { key: rule.property, isDay: true, descending: false };
  return fallback ?? RECENCY;
}

/** `QueryEvaluation.TryParseToday`: exact yyyy-MM-dd between 1900-01-01 and 9000-12-31. */
export function parseToday(text: string | null | undefined): number | null {
  if (text === null || text === undefined) return null;
  const day = parseDay(text);
  return day !== null && day >= parseDay('1900-01-01')! && day <= parseDay('9000-12-31')!
    ? day
    : null;
}

export const todayRefusal = (text: string | null | undefined): string =>
  `'${text ?? ''}' is not a day between 1900-01-01 and 9000-12-31; send today as yyyy-MM-dd.`;

export { formatDay };
