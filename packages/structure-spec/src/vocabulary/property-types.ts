/**
 * What each property type is called when a person reads it.
 *
 * **One table, because the wire name is not a word anybody should be shown.** The contract stores
 * types as `multi_select`, `timestamp` and `image`; the interface calls them "Multi-select (any of
 * a list)", "Date and time" and "Picture". Three panels had grown their own answer to that - the
 * schema editor had this table, and the board and the gallery interpolated the raw token into a
 * sentence - so a person could be told their cover property "is now a multi_select field", with the
 * underscore, about a type they had chosen from a list that never used that word.
 *
 * The gallery makes the gap unmissable rather than merely untidy: it is the first type whose label
 * and wire name are different words entirely, so a hint saying "there is no image property yet"
 * sends somebody looking for "Image" in a list that only offers "Picture".
 */

/** The types a person may choose, and what to call them. */
export const PROPERTY_TYPES = [
  { value: 'text', label: 'Text' },
  // The same string as `text`, for values too long for a one-line field: line breaks are kept and
  // nothing is formatted - see PropertyType.LongText in PropertyType.cs.
  { value: 'long_text', label: 'Long text (several lines)' },
  { value: 'number', label: 'Number' },
  { value: 'select', label: 'Select (one of a list)' },
  { value: 'multi_select', label: 'Multi-select (any of a list)' },
  { value: 'date', label: 'Date' },
  { value: 'timestamp', label: 'Date and time' },
  // A synced calendar event toggles between all-day and timed from one edit to the next on the
  // provider's side, so the property holding it has to accept either shape without its declared
  // type changing underneath it - see PropertyType.DateTime in PropertyType.cs.
  { value: 'datetime', label: 'Date or time' },
  { value: 'checkbox', label: 'Checkbox' },
  { value: 'url', label: 'Link' },
  // Told apart from a link because everything downstream reads them differently: a link is text
  // somebody clicks, and this is fetched and drawn by the browser without anybody deciding to. It
  // is also what lets a gallery offer covers from the properties that are pictures rather than
  // from every link in the workspace.
  { value: 'image', label: 'Picture' },
  // The task types (goal 3.1): the type carries the meaning, the value keeps the plain shape. A
  // schema declaring one of these is saying "this property IS the due date", which is what lets a
  // smart list or a timeline bind to the meaning instead of to a key-name convention.
  { value: 'due_date', label: 'Due date' },
  { value: 'start_date', label: 'Start date' },
  { value: 'completion', label: 'Completion' },
  { value: 'priority', label: 'Priority (1 to 4)' },
  { value: 'estimate', label: 'Estimate' },
  // Also goal 3.1's shape-versus-meaning split, arriving with 3.5: stored as a principal's
  // identifier, a canonical lowercase UUID string (or null when unassigned), so it shares its shape
  // with every other string property while its type says the string names a person.
  { value: 'assignee', label: 'Assignee' },
  // Goal 2.1. The only type whose declaration carries an expression and whose values are never
  // stored: it is computed wherever it is read, from the item's other properties.
  { value: 'formula', label: 'Formula' },
  // Goal 2.2, and the other half of the computed pair: folded across the item's children by the
  // server, because an aggregate belongs where the rows are (ADR-0044).
  { value: 'rollup', label: 'Rollup (across children)' },
  // ADR-0051 section 4. Value-shaped exactly like `timestamp` - the type is the meaning, the
  // reserved key `reminder` under goal 3.1's rule - but deliberately not calendar-placeable (see
  // isDateShaped below): a reminder is when something is announced, not when it happens.
  { value: 'reminder', label: 'Reminder' },
] as const;

/**
 * The value shape a type stores. The task types deliberately share their shape with the plain
 * types they refine - a due date is stored exactly as a date - so everything that handles values
 * (cell coercion, column widths, date pickers) asks for the shape and stays one switch, while
 * everything that handles meaning (smart lists, the recurrence anchor) asks for the type.
 */
export type PropertyValueShape =
  | 'text'
  | 'long_text'
  | 'number'
  | 'select'
  | 'multi_select'
  | 'date'
  | 'timestamp'
  | 'checkbox'
  | 'url'
  | 'image'
  | 'datetime'
  | (string & {});

export function valueShapeOf(type: string): PropertyValueShape {
  switch (type) {
    case 'due_date':
    case 'start_date':
      return 'date';
    case 'completion':
      return 'checkbox';
    case 'priority':
    case 'estimate':
      return 'number';
    // A principal's identifier is stored exactly as a select's value is: a string, or null when
    // unset. The meaning - "this string names a person" - lives in the type, not the shape, which
    // is what keeps width and clearing on the same one switch as everything else string-shaped.
    case 'assignee':
      return 'text';
    // Value-shaped exactly like a timestamp - an RFC 9557 moment with its zone - so parsing,
    // formatting and cell coercion take the same path a plain Timestamp property does.
    case 'reminder':
      return 'timestamp';
    default:
      return type;
  }
}

/**
 * Whether a property of this type can sit on a calendar or a timeline. The server's counterpart
 * is `PropertyTypes.CanPlaceOnCalendar` (PropertyType.cs); the two must widen together.
 *
 * `reminder` is excluded explicitly rather than by shape: it shares its value shape with
 * `timestamp` (so parsing and formatting agree) but is deliberately not placeable - a reminder is
 * when something is announced, not when it happens, and placing it next to the moment it
 * announces would double the item on the grid.
 */
export function isDateShaped(type: string): boolean {
  if (type === 'reminder') {
    return false;
  }

  const shape = valueShapeOf(type);
  return shape === 'date' || shape === 'timestamp' || shape === 'datetime';
}

/**
 * Whether a board, list, sheet or gallery may group by a property of this type. The server's
 * counterpart is `PropertyTypes.CanGroupBy` (PropertyType.cs); the two must widen together, and
 * the catalog lists what each accepts so the C# parity test can hold them to it.
 *
 * Single select only for now. Grouping by a multi-select, checkbox, completion, priority or
 * assignee is decided (ADR-0054) but lands with the web board work that can draw it.
 */
export function canGroupBy(type: string): boolean {
  return type === 'select';
}

/**
 * Whether a list may draw sections, or a matrix may lay out an axis, by a property of this type: a
 * single select or anything checkbox-shaped (a checkbox, or a task's completion). Each gives a
 * small, closed set of groups - the options plus "no value", or yes and no - which is what a
 * heading per group or a row per group needs. Wider than `canGroupBy` on purpose: a board's
 * columns stay select-only until the board can draw the other shapes (ADR-0054), while a section
 * heading or a matrix cell already draws a checkbox's two values honestly. The server's
 * counterpart is `PropertyTypes.CanSectionBy`; the two must widen together.
 */
export function canSectionBy(type: string): boolean {
  return type === 'select' || valueShapeOf(type) === 'checkbox';
}

/**
 * The reserved grouping key that sections a list by each item's body kind (`item.type`) rather
 * than by a property. Spelled with the `$` every reserved key carries, so no declared property
 * can collide with it.
 */
export const TYPE_GROUP_KEY = '$type';

/**
 * Whether a chart may bucket its bars by a property of this type: a single select, a priority or
 * a checkbox (or completion) - each one value per item from a small closed set, which is what the
 * server's bucket fold reads - or a date-shaped property, which puts the chart on a time axis (each
 * item's day folded into a period). The server's counterpart is `PropertyTypes.CanChartBy`; the
 * two must widen together.
 */
export function canChartBy(type: string): boolean {
  return (
    type === 'select' ||
    type === 'priority' ||
    valueShapeOf(type) === 'checkbox' ||
    isDateShaped(type)
  );
}

/**
 * Whether a chart may split its buckets into series by a property of this type: the choice types,
 * whose values are one of a few per item. The server's counterpart is `PropertyTypes.CanSplitBy`;
 * the two must widen together.
 */
export function canSplitBy(type: string): boolean {
  return type === 'select' || type === 'checkbox' || type === 'completion' || type === 'assignee';
}

/**
 * Whether a property's values are computed on read rather than written.
 *
 * The server's counterpart is `PropertyTypes.IsComputed` (PropertyType.cs), and the two must widen
 * together: a type this build thinks is writable but Core refuses would leave somebody typing into
 * a control whose every commit is rejected.
 *
 * *Where* a computed value comes from differs between the two - a formula is evaluated here and a
 * rollup arrives folded from the server - but nothing that asks this question cares which.
 */
export function isComputedType(type: string): boolean {
  return type === 'formula' || type === 'rollup';
}

/**
 * What to call a type mid-sentence.
 *
 * Falls back to the stored name for a type this build does not know, which is the honest answer:
 * the type is real - a newer build declared it - and inventing a friendly word for it would be
 * making one up. The same open-set reasoning as `PropertyInput`'s read-only floor.
 */
export function propertyTypeLabel(type: string): string {
  return PROPERTY_TYPES.find((entry) => entry.value === type)?.label ?? type;
}

/**
 * The same word, lower case, for the middle of a sentence.
 *
 * "which is now a Date and time field" reads as a proper noun; "a date and time field" reads as
 * English. Only the first character moves, so "Multi-select" keeps its internal capital.
 */
export function propertyTypeWord(type: string): string {
  const label = propertyTypeLabel(type);
  return label.charAt(0).toLowerCase() + label.slice(1);
}

/**
 * The folds a rollup may take, and what each is called.
 *
 * The vocabulary is the server's (`RollupAggregate`), which is where it is declared and policed;
 * these are the words a person chooses from. `count` is the one fold that needs no property, which
 * is what {@link foldNeedsProperty} answers.
 */
export const ROLLUP_AGGREGATES = [
  { value: 'count', label: 'How many' },
  { value: 'sum', label: 'Total' },
  { value: 'average', label: 'Average' },
  { value: 'min', label: 'Smallest' },
  { value: 'max', label: 'Largest' },
  { value: 'any', label: 'Any of them' },
  { value: 'all', label: 'All of them' },
] as const;

/** What to call a fold. Falls back to the stored name, for the reason `propertyTypeLabel` does. */
export function rollupAggregateLabel(aggregate: string): string {
  return ROLLUP_AGGREGATES.find((entry) => entry.value === aggregate)?.label ?? aggregate;
}

/**
 * Whether a fold needs a property of the children to fold.
 *
 * Only a count does not: "how many things are in here" is a question about the container rather
 * than about any property of its contents. The server's counterpart is
 * `RollupAggregates.CountsChildren`, and the two must agree - a fold this build offers without a
 * property that Core requires one for would be a schema refused after it was composed.
 */
export function foldNeedsProperty(aggregate: string): boolean {
  return aggregate !== 'count';
}
