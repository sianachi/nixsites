import type { PropertyDefinition, PropertyOwner } from './container-model';
import { isComputedType, valueShapeOf } from './property-types';

/**
 * How two items compare on one property, decided by the property's type rather than by its text.
 *
 * Sorting used to compare `readPropertyText` with a numeric collator, which reads digit runs as
 * numbers but not signs or decimal points: `1.25` sorted after `1.5` (it compared 25 with 5) and
 * `-10` after `-5`. Money, estimates and every formula total are exactly those values, so the type
 * now picks the comparison and the text is only ever the last resort.
 *
 * **A key is computed once per item, never per comparison.** A sort over 3,000 children makes about
 * 35,000 comparisons; deriving a key each time would parse a timestamp or scan an option list on
 * every one of them. Callers decorate, sort the keys, and undecorate.
 */

/**
 * One item's position on one property.
 *
 * `rank` carries everything that orders numerically - a number, a moment, a checkbox, an option's
 * position - and `text` breaks ties and orders everything that does not. A blank is its own flag
 * rather than a sentinel rank, because blanks sort last in *both* directions and a sentinel would
 * flip with the direction.
 */
export interface SortKey {
  readonly blank: boolean;
  readonly rank: number;
  readonly text: string;
}

/** One property to order by, and which way. */
export interface ViewSortKey {
  readonly property: string;
  readonly descending: boolean;
}

const BLANK: SortKey = { blank: true, rank: 0, text: '' };

/**
 * Hoisted for the reason the old sort measured: options resolved per `localeCompare` call cost 61ms
 * per 3,000-item sort against 2.65ms with one collator.
 */
const textCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** The text key the title sorts by. Its own case because it is not in the property bag. */
const TITLE_SORT_KEY = 'title';

/**
 * Reads one item's key for a property.
 *
 * `property` is undefined when the schema does not declare the key - a column carried over from a
 * removed property, or the title - and then the value's own runtime type decides.
 */
export function sortKeyFor(
  item: PropertyOwner,
  key: string,
  property: PropertyDefinition | undefined,
): SortKey {
  if (key === TITLE_SORT_KEY && property === undefined) {
    return item.title.length === 0 ? BLANK : { blank: false, rank: 0, text: item.title };
  }

  const value = item.properties[key];
  if (value === null || value === undefined || value === '') {
    return BLANK;
  }

  if (Array.isArray(value)) {
    const entries = value.filter((entry): entry is string => typeof entry === 'string');
    if (entries.length === 0) {
      return BLANK;
    }

    // A multi-select orders by its first chosen option's position, then by the whole list as text,
    // so two items tagged "urgent" sit together whatever else they carry.
    const first = entries[0] ?? '';
    return { blank: false, rank: optionRank(property, first), text: entries.join(', ') };
  }

  // A computed property's type says nothing about its value's shape - a formula can produce text
  // or a number - so its runtime value decides, exactly as an undeclared key's does.
  const shape =
    property === undefined || isComputedType(property.type) ? null : valueShapeOf(property.type);

  switch (shape) {
    case 'number':
      return numberKey(value);
    case 'checkbox':
      return typeof value === 'boolean'
        ? { blank: false, rank: value ? 1 : 0, text: '' }
        : textKey(value);
    case 'select':
      return typeof value === 'string'
        ? { blank: false, rank: optionRank(property, value), text: value }
        : textKey(value);
    case 'date':
    case 'timestamp':
    case 'datetime':
      return momentKey(value);
    case null:
      return runtimeKey(value);
    default:
      return textKey(value);
  }
}

/** Compares two keys ascending, blanks last. Direction is applied by the caller, blanks excepted. */
export function compareSortKeys(left: SortKey, right: SortKey, descending: boolean): number {
  if (left.blank || right.blank) {
    // Blanks last in both directions: a column of empties at the top tells nobody anything, and
    // flipping the direction should not make them the headline.
    return left.blank === right.blank ? 0 : left.blank ? 1 : -1;
  }

  let comparison = left.rank === right.rank ? 0 : left.rank < right.rank ? -1 : 1;
  if (comparison === 0 && left.text !== right.text) {
    comparison = textCollator.compare(left.text, right.text);
  }

  return descending ? -comparison : comparison;
}

function numberKey(value: unknown): SortKey {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? { blank: false, rank: value, text: '' } : BLANK;
  }

  // A number-typed property holding text is stale data rather than a number; it still has a place,
  // after nothing in particular, so it is not lost from the list.
  return textKey(value);
}

/**
 * A date, a timestamp or a date-or-time as one comparable instant.
 *
 * A bare `yyyy-MM-dd` is read as that day's UTC midnight and a stored timestamp by the instant its
 * offset fixes. The two only meet in a date-or-time property, where an all-day entry sorting at the
 * start of its day is the order a calendar reads in. `Date.parse` rather than Luxon: the zone in
 * brackets does not move the instant, and Luxon per item would be the expensive part of a sort.
 */
function momentKey(value: unknown): SortKey {
  if (typeof value !== 'string') {
    return runtimeKey(value);
  }

  const bracket = value.indexOf('[');
  const moment = bracket === -1 ? value : value.slice(0, bracket);
  const parsed = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(moment) ? `${moment}T00:00:00Z` : moment);

  return Number.isNaN(parsed) ? textKey(value) : { blank: false, rank: parsed, text: '' };
}

function runtimeKey(value: unknown): SortKey {
  if (typeof value === 'number') {
    return numberKey(value);
  }

  if (typeof value === 'boolean') {
    return { blank: false, rank: value ? 1 : 0, text: '' };
  }

  return textKey(value);
}

/**
 * Text, ranked after every number: in a mixed column the numbers read as a sequence and the stray
 * words follow them rather than interleaving by their first digit.
 */
function textKey(value: unknown): SortKey {
  const text = typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
  return text.length === 0 ? BLANK : { blank: false, rank: Number.MAX_VALUE, text };
}

/**
 * An option's position in the schema, so a select sorts in the order somebody arranged its options
 * - To do, Doing, Done - rather than alphabetically. A value the options no longer list sorts after
 * every listed one, and among its kind by text.
 */
function optionRank(property: PropertyDefinition | undefined, value: string): number {
  if (property === undefined) {
    return 0;
  }

  const index = property.options.indexOf(value);
  return index === -1 ? property.options.length : index;
}
