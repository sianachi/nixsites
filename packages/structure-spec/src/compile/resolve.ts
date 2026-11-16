import { resolveFieldRef, type FieldRefResolution, type ResolvedField } from '../spec/refs.js';
import type { StructureProperty } from '../types.js';

/**
 * A field reference's failure, worded so the difference between "no field named this" and "more
 * than one field could be meant" is visible in the thrown message - `resolveFieldRef`
 * (`../spec/refs.js`) already tells the two apart in its return value, and swallowing that
 * distinction in a single generic message would make an ambiguous rollup source or view column
 * look identical to a typo.
 */
export function describeUnresolvedFieldRef(
  ref: string,
  resolution: FieldRefResolution & { ok: false },
): string {
  if (resolution.code === 'ambiguous') {
    return `Field reference "${ref}" is ambiguous: it could mean ${resolution.candidates.join(' or ')}.`;
  }
  return `Field reference "${ref}" does not resolve to a known field.`;
}

/**
 * The `{ existing, added }` scope `resolveFieldRef` takes, built from the same `effective` /
 * `addedKeys` pair every view and form compiler in this module already accepts: only the keys in
 * `addedKeys` are label-searchable (architecture 2.3), and every key in `effective` - added or not
 * - is exact-match searchable. `addedKeys` is optional so a caller resolving outside an operation's
 * own field-compilation step (a direct unit test, for instance) can still resolve by label against
 * everything it is given.
 */
interface RefScope {
  readonly existing: readonly StructureProperty[];
  readonly added: readonly ResolvedField[];
}

// A compilation resolves every reference of a view or form against the same schema and the same
// added keys, so the scope is prepared once for that pair, not once per reference. Held weakly:
// it lasts as long as the caller's own schema array.
const scopes = new WeakMap<
  readonly StructureProperty[],
  Map<ReadonlySet<string> | undefined, RefScope>
>();

function refScope(
  effective: readonly StructureProperty[],
  addedKeys?: ReadonlySet<string>,
): RefScope {
  let prepared = scopes.get(effective);
  if (prepared === undefined) {
    prepared = new Map();
    scopes.set(effective, prepared);
  }
  let scope = prepared.get(addedKeys);
  if (scope === undefined) {
    const isAdded = (property: StructureProperty): boolean =>
      addedKeys === undefined || addedKeys.has(property.key);
    scope = {
      existing: effective.filter((property) => !isAdded(property)),
      added: effective
        .filter(isAdded)
        .map((property) => ({ key: property.key, label: property.label })),
    };
    prepared.set(addedKeys, scope);
  }
  return scope;
}

/**
 * Resolves a `FieldRef` against the schema a view or a form sees, throwing when it does not
 * resolve - the shape every production compiler in this package wants, since an unresolvable ref
 * at this point is a caller error (`@nix/structure-spec/validate` has already accepted the spec).
 */
export function resolveKey(
  ref: string,
  effective: readonly StructureProperty[],
  addedKeys?: ReadonlySet<string>,
): string {
  const resolution = resolveFieldRef(ref, refScope(effective, addedKeys));
  if (!resolution.ok) {
    throw new Error(describeUnresolvedFieldRef(ref, resolution));
  }
  return resolution.key;
}

/**
 * The same resolution as `resolveKey`, but returned as data instead of thrown - what
 * `@nix/structure-spec/validate` needs to report *why* a `FieldRef` failed (unknown vs.
 * ambiguous, and which candidates) at a precise problem path, before it ever tries compiling the
 * spec for real.
 */
export function tryResolveKey(
  ref: string,
  effective: readonly StructureProperty[],
  addedKeys?: ReadonlySet<string>,
): FieldRefResolution {
  return resolveFieldRef(ref, refScope(effective, addedKeys));
}
