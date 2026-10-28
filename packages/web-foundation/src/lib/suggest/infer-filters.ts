/**
 * Filter rules that describe a handful of examples, found by looking at what they have in common.
 *
 * Query by example: somebody marks the items they mean - "these three are what I want this list to
 * be" - and this proposes rules that are true of every one of them and as rare as possible among
 * everything else on offer. The proposal is a starting point for a person to read, edit and save
 * through the ordinary filter editor; nothing here runs a query or stores a rule.
 *
 * **Only rules the server can run.** A query view's rules are compiled by Core from a closed
 * operator set (`QueryOperators` in `FilterRule.cs`), so the predicates considered here are exactly
 * the ones that set can express, matched with the same semantics the compiler gives them:
 *
 * - `equals` - the stored value, read as text (`properties ->> key`), equals a literal. Only scalar
 *   values qualify: a multi-select is stored as an array, whose text form is not something an
 *   equality on one option can match.
 * - `not-equals` - `IS DISTINCT FROM` a literal, so an item without the property counts as "not
 *   equal". That is what makes "done is not true" match items never ticked.
 * - `on`, `before`, `on-or-after` - on the first ten characters of the stored value, which is the
 *   calendar day for both a `date` and a `timestamp`. An item without the property fails all three.
 *
 * Contains, is-set and numeric ranges are what one would reach for next, and the server has no
 * operator for any of them - so they are not proposed, rather than proposed and refused on save.
 *
 * **Greedy, up to three rules.** Each round takes the predicate, true of every example, that rules
 * out the most of the remaining non-examples; it stops when nothing rules anything further out.
 * Greedy set cover is not optimal, but it is predictable, and three rules is about as many as a
 * person will read before deciding whether the proposal means what they meant.
 *
 * Pure: records come in, rules go out.
 */

/** An item as this module reads it: an identity and its property bag. */
export interface ExampleRecord {
  readonly id: string;
  readonly properties: Readonly<Record<string, unknown>>;
}

/** A proposed rule, in the shape a query view stores, with how much it narrows. */
export interface InferredRule {
  readonly property: string;
  readonly operator: 'equals' | 'not-equals' | 'on' | 'before' | 'on-or-after';
  readonly value: string;

  /** Candidates still matching once this rule and every rule before it is applied. */
  readonly remaining: number;
}

export interface InferredFilters {
  readonly rules: readonly InferredRule[];

  /** Candidates (examples included) matching every proposed rule. */
  readonly matching: number;

  /** Candidates considered, examples included. */
  readonly considered: number;
}

/** The most rules one proposal carries. */
export const MAXIMUM_INFERRED_RULES = 3;

/** Keys never proposed: the title is a name, not a category, and equality on it finds one item. */
const IGNORED_KEYS: ReadonlySet<string> = new Set(['title']);

const DAY_PREFIX = /^\d{4}-\d{2}-\d{2}/;

interface Predicate {
  readonly property: string;
  readonly operator: InferredRule['operator'];
  readonly value: string;
  readonly test: (record: ExampleRecord) => boolean;
}

/** The text Postgres' `->>` gives a scalar JSON value, or null for absent, null, arrays and objects. */
function scalarText(value: unknown): string | null {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  return null;
}

/** The calendar day a value starts with, the way the compiler's `left(value, 10)` reads it. */
function dayOf(value: unknown): string | null {
  return typeof value === 'string' && DAY_PREFIX.test(value) ? value.slice(0, 10) : null;
}

function nextDay(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function predicatesFor(
  examples: readonly ExampleRecord[],
  pool: readonly ExampleRecord[],
): Predicate[] {
  const keys = new Set<string>();
  for (const example of examples) {
    for (const key of Object.keys(example.properties)) {
      if (!IGNORED_KEYS.has(key)) {
        keys.add(key);
      }
    }
  }
  // `not-equals` can be true of examples that lack a key entirely, so keys only the pool carries
  // are candidates for it too.
  const poolKeys = new Set<string>();
  for (const record of pool) {
    for (const key of Object.keys(record.properties)) {
      if (!IGNORED_KEYS.has(key)) {
        poolKeys.add(key);
      }
    }
  }

  const predicates: Predicate[] = [];

  for (const key of keys) {
    const texts = examples.map((example) => scalarText(example.properties[key]));
    const first = texts[0];
    if (
      first !== undefined &&
      first !== null &&
      first.length > 0 &&
      texts.every((text) => text === first)
    ) {
      predicates.push({
        property: key,
        operator: 'equals',
        value: first,
        test: (record) => scalarText(record.properties[key]) === first,
      });
    }

    const days = examples.map((example) => dayOf(example.properties[key]));
    if (days.every((day): day is string => day !== null)) {
      const sorted = [...days].sort();
      const earliest = sorted[0] ?? '';
      const latest = sorted[sorted.length - 1] ?? '';
      if (earliest === latest) {
        predicates.push({
          property: key,
          operator: 'on',
          value: earliest,
          test: (record) => dayOf(record.properties[key]) === earliest,
        });
      } else {
        predicates.push({
          property: key,
          operator: 'on-or-after',
          value: earliest,
          test: (record) => {
            const day = dayOf(record.properties[key]);
            return day !== null && day >= earliest;
          },
        });
        const bound = nextDay(latest);
        predicates.push({
          property: key,
          operator: 'before',
          value: bound,
          test: (record) => {
            const day = dayOf(record.properties[key]);
            return day !== null && day < bound;
          },
        });
      }
    }
  }

  for (const key of poolKeys) {
    const held = new Set(examples.map((example) => scalarText(example.properties[key])));
    const others = new Set<string>();
    for (const record of pool) {
      const text = scalarText(record.properties[key]);
      if (text !== null && text.length > 0 && !held.has(text)) {
        others.add(text);
      }
    }
    for (const value of others) {
      predicates.push({
        property: key,
        operator: 'not-equals',
        value,
        test: (record) => scalarText(record.properties[key]) !== value,
      });
    }
  }

  return predicates;
}

/**
 * Proposes up to {@link MAXIMUM_INFERRED_RULES} rules true of every example and as selective as
 * possible over `candidates`.
 *
 * Examples missing from `candidates` are considered anyway - an example is by definition something
 * the list should hold. Fewer than one example proposes nothing.
 */
export function inferFilters(
  examples: readonly ExampleRecord[],
  candidates: readonly ExampleRecord[],
  maximumRules: number = MAXIMUM_INFERRED_RULES,
): InferredFilters {
  const exampleIds = new Set(examples.map((example) => example.id));
  const pool = [...examples, ...candidates.filter((candidate) => !exampleIds.has(candidate.id))];

  if (examples.length === 0) {
    return { rules: [], matching: pool.length, considered: pool.length };
  }

  const predicates = predicatesFor(examples, pool);
  const rules: InferredRule[] = [];
  let remaining = pool;

  while (rules.length < maximumRules) {
    let best: { predicate: Predicate; kept: ExampleRecord[] } | null = null;
    for (const predicate of predicates) {
      if (
        rules.some(
          (rule) => rule.property === predicate.property && rule.operator === predicate.operator,
        )
      ) {
        continue;
      }
      const kept = remaining.filter(predicate.test);
      if (kept.length === remaining.length) {
        continue;
      }
      // Fewer survivors is better; on a tie, an equality reads more plainly than an exclusion.
      if (
        best === null ||
        kept.length < best.kept.length ||
        (kept.length === best.kept.length &&
          best.predicate.operator === 'not-equals' &&
          predicate.operator !== 'not-equals')
      ) {
        best = { predicate, kept };
      }
    }
    if (best === null) {
      break;
    }
    remaining = best.kept;
    rules.push({
      property: best.predicate.property,
      operator: best.predicate.operator,
      value: best.predicate.value,
      remaining: remaining.length,
    });
  }

  return { rules, matching: remaining.length, considered: pool.length };
}
