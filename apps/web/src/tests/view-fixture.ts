import type {
  EffectiveSchema,
  Item,
  PropertyDefinition,
  View,
} from '../collections/core/container-model';

/**
 * A view, with only the fields a test cares about spelled out.
 *
 * **One of these rather than nine.** Every test file under `tests/views/` used to carry its own
 * complete `View` literal - the same thirteen fields, the same nulls - so a field added to the
 * record was thirteen edits in ten files, none of which any test was about. ADR-0020 accepts that
 * threading cost for the flat view record on the product side, where each site is a real decision;
 * it is not a reason for the fixtures to restate the shape ten times.
 *
 * The defaults are the least interesting view there is: a list, configured with nothing, named
 * once. A test that cares about a field says so and the rest stay out of the way - which is also
 * what makes a fixture readable, since what a test overrides is exactly what it is about.
 *
 * Files with their own house defaults - a board grouped by status, a calendar placed by a date -
 * keep a local `viewOf` that calls this with them, so a caller's overrides still win.
 */
export function aView(overrides: Partial<View> = {}): View {
  return {
    id: 'view-1',
    name: 'Everything',
    kind: 'list',
    columns: [],
    groupBy: null,
    groupOrder: [],
    dateProperty: null,
    sortBy: null,
    sortDescending: false,
    mode: null,
    coverProperty: null,
    endDateProperty: null,
    cardSize: null,
    layout: null,
    filters: [],
    ...overrides,
  };
}

/** A text-ish property definition with nothing configured. */
export function property(key: string, label: string, type: string): PropertyDefinition {
  return { key, label, type, options: [], required: false };
}

/** An effective schema that declares exactly these properties. */
export function schemaOf(...properties: readonly PropertyDefinition[]): EffectiveSchema {
  return { properties: [...properties], declared: [...properties], inherit: true };
}

export function item(
  id: string,
  title: string,
  seq: number,
  properties: Record<string, unknown> = {},
): Item {
  return {
    id,
    workspaceId: 'workspace-1',
    parentId: 'folder-1',
    type: 'note',
    title,
    hasChildren: false,
    seq,
    lifecycleState: 'active',
    properties,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

export function itemOf(overrides: Partial<Item> & { id: string; title: string }): Item {
  return {
    workspaceId: 'a1000000-0000-4000-8000-000000000001',
    parentId: 'c1000000-0000-4000-8000-000000000001',
    type: 'note',
    hasChildren: false,
    seq: 1000,
    lifecycleState: 'active',
    properties: {},
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

export function datedItem(id: string, title: string, properties: Record<string, unknown>): Item {
  return {
    id,
    workspaceId: 'a1000000-0000-4000-8000-000000000001',
    parentId: 'c1000000-0000-4000-8000-000000000001',
    type: 'note',
    title,
    hasChildren: false,
    seq: 1000,
    lifecycleState: 'active',
    properties: { title, ...properties },
    createdAt: '2026-03-01T00:00:00.000Z',
    updatedAt: '2026-03-01T00:00:00.000Z',
  };
}
