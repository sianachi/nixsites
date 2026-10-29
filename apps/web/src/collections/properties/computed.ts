import {
  type CellValue,
  type PropertyFormula,
  type PropertyFormulaPlan,
  evaluateFormulaPlan,
  isSheetError,
  planPropertyFormulas,
  sheetError,
} from '@nix/sheet';

import type { PropertyDefinition, PropertyOwner, PropertyValue } from '../core/container-model';

/**
 * Computed properties: the values an item has without ever having stored one.
 *
 * **Evaluated on read, and merged into the bag every other reader already uses.** A formula
 * property's value is produced here, from the values the item is carrying at this moment, and put
 * into `properties` under its own key before any view sees the item. That is what lets a list cell,
 * a board column, a sort, a gallery card and the property panel show a computed value without one
 * of them learning what a formula is - they read a property bag, as they always did.
 *
 * **Nothing computed is ever written back.** The write paths send only the keys somebody edited, and
 * Core refuses a value for a computed property outright, so a merged bag cannot leak back into
 * storage. The merge is a read-side decoration and the item in state stays exactly as the server
 * sent it.
 *
 * **A rollup arrives folded; a formula is evaluated here.** The two computed types are computed in
 * different places, because a rollup is an aggregate over rows this build does not hold and a
 * formula is an expression over values it does - ADR-0044 records the split. The rollups the server
 * sent are merged first, so a formula may read one as an ordinary field and "percent complete" is a
 * formula over a rollup rather than a third mechanism.
 *
 * **The engine is `@nix/sheet` and there is only one of it.** The same tokenizer, parser, operators,
 * coercions and functions run here as run in a spreadsheet body, which is why a formula reads the
 * same way in both places. This module's whole job is the two conversions the engine cannot make
 * for itself: a JSON property value into the engine's value domain, and a computed value back into
 * something a property bag can carry.
 */

/**
 * A property value as the engine sees it.
 *
 * `undefined` means the item has no such property. The engine answers `#NAME?` for it, which is
 * what makes a misspelled key visible instead of quietly arithmetic - but see
 * {@link computedValues}: that answer is only correct for a key *nothing declares*. A declared
 * property nobody has filled in yet is empty, not unknown, and is read as null.
 */
export function toCellValue(value: unknown): CellValue | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === 'string').join(', ');
  }

  // An object-shaped property value has no scalar reading. `#VALUE!` rather than absent, because
  // the property does exist and does hold something - it is the value that is of the wrong kind,
  // which is exactly what that code says and what `#NAME?` would deny.
  return sheetError('#VALUE!');
}

/**
 * A computed value as a property bag carries it.
 *
 * An error becomes its own code - `#DIV/0!` - which is what the sheet shows in a cell and what
 * every existing reader will render as text without being taught anything. It is a value that says
 * what went wrong, rather than a blank that says nothing. The sentence that goes with the code is
 * `PROPERTY_FORMULA_HELP`, shown wherever there is room for one.
 */
function toPropertyValue(value: CellValue): PropertyValue {
  return isSheetError(value) ? value.error : value;
}

/** The formula properties in a schema, in declaration order. */
export function formulaProperties(
  properties: readonly PropertyDefinition[],
): readonly PropertyFormula[] {
  const formulas: PropertyFormula[] = [];

  for (const property of properties) {
    // Nullish rather than a null check: a definition built as a draft carries no `expression` at
    // all, and a parsed one carries null. Both mean the same thing.
    if (property.type === 'formula' && property.expression != null) {
      formulas.push({ key: property.key, expression: property.expression });
    }
  }

  return formulas;
}

/**
 * A schema's formulas, parsed and ordered, plus the keys "empty" is measured against.
 *
 * **Built once per schema and reused for every item under it**, because neither the parse nor the
 * dependency order can come out differently for a different item. Doing both per item measured
 * 10.49 ms over 3,000 children with three formulas each, against 3.02 ms planned once - and this
 * derivation runs twice per property edit, once optimistically and once on the server's answer.
 */
export interface ComputedPlan {
  readonly plan: PropertyFormulaPlan;

  /**
   * Every key the schema in force declares.
   *
   * **What tells a property nobody has filled in from a property nobody declared.** A write owes
   * only the keys it names, so an item that has never been given a `price` carries no `price` key
   * at all - the ordinary state of most properties on most items, not an exception. Reading the bag
   * alone would answer `#NAME?` for it, and the first ordinary use of this feature - declare a
   * formula over a property, then fill that property in on some children and not others - would
   * show an unknown-name error on every row somebody had not got to yet. So a declared key reads as
   * empty, and only an undeclared one reads as unknown, which is the misspelling the distinction
   * exists to catch.
   */
  readonly declared: ReadonlySet<string>;

  /** Whether there is anything to compute at all. */
  readonly empty: boolean;
}

/** Prepares a schema for evaluation. Cheap and allocation-free when it declares no formulas. */
export function planFor(properties: readonly PropertyDefinition[] | undefined): ComputedPlan {
  const formulas = formulaProperties(properties ?? []);
  if (formulas.length === 0) {
    return NOTHING_TO_COMPUTE;
  }

  const declared = new Set<string>();
  for (const property of properties ?? []) {
    declared.add(property.key);
  }

  return { plan: planPropertyFormulas(formulas), declared, empty: false };
}

/**
 * One item's computed values, keyed by property key: the folds the server sent, plus the formulas
 * evaluated over them.
 */
export function computedValues(
  item: PropertyOwner,
  prepared: ComputedPlan,
): Readonly<Record<string, PropertyValue>> {
  const folded = item.computed ?? null;

  if (prepared.empty) {
    return folded === null ? EMPTY : (folded as Record<string, PropertyValue>);
  }

  const { values } = evaluateFormulaPlan(prepared.plan, (key) => {
    // A rollup first: it is a value this item has, and a formula reading one should see the number
    // rather than the empty slot the stored bag has where a rollup would be.
    const rolled = folded?.[key];
    if (rolled !== undefined) {
      return toCellValue(rolled);
    }

    const stored = item.properties[key];
    if (stored !== undefined) {
      return toCellValue(stored);
    }

    return prepared.declared.has(key) ? null : undefined;
  });

  const computed: Record<string, PropertyValue> = { ...(folded as Record<string, PropertyValue>) };
  for (const [key, value] of values) {
    computed[key] = toPropertyValue(value);
  }

  return computed;
}

/**
 * The same items, each carrying its computed values alongside its stored ones.
 *
 * Returns the array it was given when there is nothing to compute, so a container with no formulas
 * pays neither an allocation nor a changed identity - which matters because this sits between the
 * loader and every view's memoised derivation of it.
 *
 * Costs two objects per item when there is - a spread of the item and a spread of its bag, measured
 * at 0.63 MB retained over 3,000 children. That is ADR-0044's merge-into-the-bag decision paid for
 * in full, and it buys every reader staying ignorant of what a formula is.
 */
export function decorateItems<TItem extends PropertyOwner>(
  items: readonly TItem[],
  properties: readonly PropertyDefinition[] | undefined,
): readonly TItem[] {
  const prepared = planFor(properties);

  // Nothing to evaluate *and* nothing folded: the array comes back as it was, identity included.
  // A page carrying folds still has to be merged even with no formulas in the schema.
  if (prepared.empty && !items.some((item) => item.computed != null)) {
    return items;
  }

  return items.map((item) => ({
    ...item,
    properties: { ...item.properties, ...computedValues(item, prepared) },
  }));
}

/**
 * One item's, for the panel and the places that hold a single item rather than a page of them.
 *
 * Named for the axis rather than by a plural, because the axis is the only thing that differs:
 * {@link decorateItems} is the page and this is the row, and a reader at a call site should be able
 * to tell which without opening either.
 */
export function decorateItem<TItem extends PropertyOwner>(
  item: TItem,
  properties: readonly PropertyDefinition[] | undefined,
): TItem {
  const prepared = planFor(properties);
  if (prepared.empty && item.computed == null) {
    return item;
  }

  return {
    ...item,
    properties: { ...item.properties, ...computedValues(item, prepared) },
  };
}

/** The plan for a schema with no formulas: shared, so the ordinary case allocates nothing. */
const NOTHING_TO_COMPUTE: ComputedPlan = {
  plan: planPropertyFormulas([]),
  declared: new Set<string>(),
  empty: true,
};

/** Frozen so a caller cannot make the no-formulas case a shared mutable bag. */
const EMPTY: Readonly<Record<string, PropertyValue>> = Object.freeze({});

/**
 * The item as it now stands, keeping the folds the read that produced it did not compute.
 *
 * **Null means "this response did not fold children", not "there are none."** A write answers with
 * the item, not with a fresh fold of its children, so a rename, a move, a restore or a property
 * edit all come back carrying null - and replacing the row in state with that response would blank
 * every rollup column on it until the next full load. The contract keeps null and `{}` apart for
 * exactly this reason; this is the half of it the client owes.
 *
 * The values are the ones folded when the item was last read, which may now be one edit stale. That
 * is the honest trade against blanking them: a rollup is a summary of other rows, and the write
 * that just happened may or may not have changed them.
 */
export function keepComputed<TItem extends PropertyOwner>(
  previous: TItem | undefined,
  next: TItem,
): TItem {
  return next.computed == null && previous?.computed != null
    ? { ...next, computed: previous.computed }
    : next;
}
