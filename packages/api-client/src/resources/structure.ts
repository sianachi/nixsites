/**
 * The structure resource: the only place the schema and properties URLs appear.
 *
 * Two axes an item declares over its subtree — the property *schema* (`GET/PUT /items/{id}/schema`)
 * and the property *values* on the item itself (`PATCH /items/{id}/properties`). A property write
 * changes what a board groups by or a calendar places, so it invalidates the item and its cached
 * views; a schema write additionally invalidates the item's schema key.
 */

import {
  defineCommand,
  defineQuery,
  type CommandEndpoint,
  type QueryEndpoint,
} from '../endpoints.js';
import {
  effectiveSchemaSchema,
  itemSchema,
  type EffectiveSchema,
  type Item,
  type PropertyDefinition,
} from '../schemas/index.js';

const itemKey = (itemId: string): readonly string[] => ['items', itemId];
const schemaKey = (itemId: string): readonly string[] => ['items', itemId, 'schema'];

/** The property schema resolved at an item: what it declares, whether it inherits, and the merge. */
export const effectiveSchema = (itemId: string): QueryEndpoint<EffectiveSchema> =>
  defineQuery<EffectiveSchema>({
    operation: 'schema.get',
    path: `/api/v1/items/${itemId}/schema`,
    schema: effectiveSchemaSchema,
    cacheKey: schemaKey(itemId),
  });

export interface SetSchemaInput {
  /** The properties this item declares for its subtree, replacing the whole declared set. */
  readonly properties: readonly PropertyDefinition[];
  /** Whether the declared set merges the ancestors' schema in, or stands alone. */
  readonly inherit: boolean;
}

/** Replaces the item's declared schema and returns the effective schema after the change. */
export const setItemSchema = (
  itemId: string,
  input: SetSchemaInput,
): CommandEndpoint<EffectiveSchema> =>
  defineCommand<EffectiveSchema>({
    operation: 'schema.set',
    method: 'PUT',
    path: `/api/v1/items/${itemId}/schema`,
    schema: effectiveSchemaSchema,
    body: { properties: input.properties, inherit: input.inherit },
    invalidates: [schemaKey(itemId), itemKey(itemId)],
  });

/**
 * Merges property values onto an item, returning the item as it now stands.
 *
 * The bag is a *merge*, matching the endpoint: a key set to `null` clears that property, a key left
 * out is untouched. This is what a board or calendar drag performs when it changes an item's group
 * or date, so it invalidates the item and any cached view of its container.
 */
export const setItemProperties = (
  itemId: string,
  properties: Readonly<Record<string, unknown>>,
  strict?: boolean,
): CommandEndpoint<Item> =>
  defineCommand<Item>({
    operation: 'properties.set',
    method: 'PATCH',
    path: `/api/v1/items/${itemId}/properties`,
    schema: itemSchema,
    body: strict === undefined ? { properties } : { properties, strict },
    invalidates: [itemKey(itemId)],
  });
