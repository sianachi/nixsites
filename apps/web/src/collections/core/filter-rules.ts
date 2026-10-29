import {
  addDays,
  dayFromText,
  daysInMonth,
  dayText,
  startOfWeek,
  type CalendarDay,
} from './calendar-dates';
import {
  isFilterGroup,
  type PropertyOwner,
  type ViewFilterCondition,
  type ViewFilterRule,
} from './container-model';

/**
 * A view's stored filter rules, evaluated against the children already loaded.
 *
 * The grammar is the server's (`QueryOperators.All` in FilterRule.cs) and so are the meanings,
 * operator for operator: a query view compiles every one of them to SQL, and a board filtered by
 * the same rule has to show the same items or the two views of one thing disagree. Where this goes
 * further than the SQL - an `equals` against a multi-select matches an item carrying that option
 * among others - the SQL is the one that is narrower, and the server half is the place to widen it.
 *
 * **Rules AND together, with one level of "any of" groups**, as they do on the server. The
 * structural `$` fields (`$type`, `$inside`, ...) are query-only and the server refuses them on a
 * container view, so none reaches this evaluator.
 */

/** What a rule needs besides the item: the reader's day and who "me" is. */
export interface RuleContext {
  /** The reader's own calendar day, `yyyy-MM-dd`, which `today` resolves to. */
  readonly today: string;

  /**
   * The signed-in principal's id, which `me` resolves to, or null when it is unknown.
   *
   * Unknown resolves `me` to nothing at all - not to "anybody". The shared view chrome does not
   * let that be the last word: it waits while the answer is on its way, and when it cannot be had
   * it sets the rules about the reader aside and says so (`useRuleContext`).
   */
  readonly principalId: string | null;
}

export const ME_TOKEN = 'me';

/** Whether an operator takes no value - its meaning is entirely about the property's presence. */
export function operatorTakesValue(operator: string): boolean {
  return operator !== 'is-empty' && operator !== 'is-not-empty';
}

/** Keeps the items every rule admits. Returns the array it was given when there are no rules. */
export function applyRules<TItem extends PropertyOwner>(
  items: readonly TItem[],
  rules: readonly ViewFilterRule[],
  context: RuleContext,
): readonly TItem[] {
  if (rules.length === 0) {
    return items;
  }

  return items.filter((item) =>
    rules.every((rule) =>
      isFilterGroup(rule)
        ? rule.any.some((condition) => evaluateRule(item, condition, context))
        : evaluateRule(item, rule, context),
    ),
  );
}

/** Every condition of a rule set, top level and inside groups, in order. */
export function ruleConditions(rules: readonly ViewFilterRule[]): readonly ViewFilterCondition[] {
  return rules.flatMap((rule) => (isFilterGroup(rule) ? rule.any : [rule]));
}

/**
 * Whether one item satisfies one rule.
 *
 * An operator this build does not know admits everything. A newer build wrote it, the server will
 * have refused it if it were wrong, and hiding items over a word this build cannot read would be a
 * filter nobody can see the reason for.
 */
export function evaluateRule(
  item: PropertyOwner,
  rule: ViewFilterCondition,
  context: RuleContext,
): boolean {
  const value = item.properties[rule.property];

  switch (rule.operator) {
    case 'equals':
      return equals(value, resolveMe(rule.value, context));
    case 'not-equals':
      // Absence counts as "not equal", the server's own rule: Overdue asks for done not-equals
      // true, and an item that never had the property is exactly as not-done as one set false.
      return !equals(value, resolveMe(rule.value, context));
    case 'contains':
      return contains(value, rule.value);
    case 'not-contains':
      return !contains(value, rule.value);
    case 'greater-than':
      return compareNumber(value, rule.value, (a, b) => a > b);
    case 'less-than':
      return compareNumber(value, rule.value, (a, b) => a < b);
    case 'on':
      return compareDay(value, rule.value, context, (a, b) => a === b);
    case 'before':
      return compareDay(value, rule.value, context, (a, b) => a < b);
    case 'on-or-after':
      return compareDay(value, rule.value, context, (a, b) => a >= b);
    case 'within-next':
      return withinWindow(value, rule.value, context, 'next');
    case 'within-last':
      return withinWindow(value, rule.value, context, 'last');
    case 'is-empty':
      return isEmpty(value);
    case 'is-not-empty':
      return !isEmpty(value);
    default:
      return true;
  }
}

function resolveMe(value: string, context: RuleContext): string | null {
  return value === ME_TOKEN ? context.principalId : value;
}

/**
 * Equality as the server's `properties ->> key = value` reads it: the stored value's text against
 * the literal, so a checkbox matches `true` and a number matches its digits.
 */
function equals(value: unknown, expected: string | null): boolean {
  if (expected === null) {
    return false;
  }

  if (Array.isArray(value)) {
    return value.some((entry) => entry === expected);
  }

  if (typeof value === 'string') {
    return value === expected;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value) === expected;
  }

  return false;
}

/**
 * The meaning `QueryOperators.Contains` documents: a case-insensitive substring of stored text, and
 * exact option membership for a multi-select. An option is a declared word, not text to search, so
 * "Urg" does not hold "Urgent" and "urgent" is not that option. Anything else contains nothing.
 */
function contains(value: unknown, needle: string): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => entry === needle);
  }

  if (typeof value === 'string') {
    return value.toLocaleLowerCase().includes(needle.toLocaleLowerCase());
  }

  return false;
}

function compareNumber(
  value: unknown,
  literal: string,
  test: (actual: number, expected: number) => boolean,
): boolean {
  const expected = Number(literal);
  if (literal.trim().length === 0 || !Number.isFinite(expected)) {
    return false;
  }

  const actual =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(actual) && test(actual, expected);
}

/**
 * The day a stored date-shaped value falls on: its first ten characters, which is `left(value, 10)`
 * on the server. A timestamp's first ten are its local day in the zone it was written in, so the
 * two agree on which day a 23:30 meeting belongs to.
 */
function dayOf(value: unknown): string | null {
  if (typeof value !== 'string' || value.length < 10) {
    return null;
  }

  const day = value.slice(0, 10);
  return dayFromText(day) === null ? null : day;
}

function resolveDay(literal: string, context: RuleContext): string | null {
  const today = dayFromText(context.today);
  if (today === null) {
    return null;
  }

  switch (literal) {
    case 'today':
      return context.today;
    case 'start-of-week':
      return dayText(startOfWeek(today));
    case 'start-of-month':
      return dayText({ ...today, day: 1 });
    case 'same-day-last-week':
      return dayText(addDays(today, -7));
    case 'same-day-last-month':
      return dayText(sameDayLastMonth(today));
    default:
      return dayFromText(literal) === null ? null : literal;
  }
}

function compareDay(
  value: unknown,
  literal: string,
  context: RuleContext,
  test: (actual: string, expected: string) => boolean,
): boolean {
  const actual = dayOf(value);
  const expected = resolveDay(literal, context);

  // `yyyy-MM-dd` orders correctly as plain text, which is why the server can compare it as text and
  // why this can too.
  return actual !== null && expected !== null && test(actual, expected);
}

/** The same day of the previous month, clamped to its last day, as `DateOnly.AddMonths(-1)` does. */
function sameDayLastMonth(today: CalendarDay): CalendarDay {
  // Months are counted from zero here, so January's previous month is December of the year before.
  const year = today.month === 0 ? today.year - 1 : today.year;
  const month = today.month === 0 ? 11 : today.month - 1;
  return { year, month, day: Math.min(today.day, daysInMonth({ year, month })) };
}

function withinWindow(
  value: unknown,
  literal: string,
  context: RuleContext,
  direction: 'next' | 'last',
): boolean {
  const actual = dayOf(value);
  const days = Number(literal);
  const today = dayFromText(context.today);

  if (actual === null || today === null || !Number.isInteger(days) || days < 1) {
    return false;
  }

  // BETWEEN the two ends, inclusive at both, as the server compiles it: forward from today for
  // within-next, back to today for within-last.
  return direction === 'next'
    ? actual >= context.today && actual <= dayText(addDays(today, days))
    : actual >= dayText(addDays(today, -days)) && actual <= context.today;
}

function isEmpty(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    value === '' ||
    (Array.isArray(value) && value.length === 0)
  );
}
