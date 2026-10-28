/**
 * What one run of a saved query answered.
 *
 * Two properties of the payload are guarantees rather than accidents. **The rows are already
 * permission-filtered inside the statement**, so the limit was spent only on rows the caller may
 * read - a truncated answer is a full answer that was cut, never a full answer minus refusals.
 * And **`truncated` is the honest-state field**: a list that was cut and does not say so reads as
 * a list that ended, so a view rendering this must surface it.
 */

import { z } from 'zod';
import type { components } from '../generated/api.js';

/** One item a saved query matched. */
const queryResultSchema = z.object({
  id: z.uuid(),
  workspaceId: z.uuid(),

  /** Its parent, or null at a workspace root. */
  containerId: z.uuid().nullable(),

  /**
   * The parent's title, so a cross-container row can say where it lives without a second read.
   * Null when the parent has never been named, or when there is no parent.
   */
  containerTitle: z.string().nullable(),

  /** The item's title, or null when it has never been named. The server invents no copy. */
  title: z.string().nullable(),

  /** The item's body kind. */
  type: z.string(),

  /** The property bag as stored, so a row can show the values it matched on. */
  properties: z.record(z.string(), z.unknown()),
});

export type QueryResultRow = z.infer<typeof queryResultSchema>;

/**
 * The limit as the wire may spell it: the generated contract admits number or string for int32,
 * and the schema accepts what the contract permits rather than what we expect to see.
 */
const queryLimitSchema = z.union([z.int(), z.string().regex(/^-?\d+$/)]);

export const itemQueryResultsSchema = z.object({
  /** The smart list that was run. */
  itemId: z.uuid(),

  /** The query view that ran. */
  viewId: z.string(),

  /** The day the `today` token resolved to, echoed so a late response matches its request. */
  today: z.string(),

  results: z.array(queryResultSchema),

  limit: queryLimitSchema,

  /** True when more rows matched than the limit allowed, so this is part of the answer. */
  truncated: z.boolean(),
});

export type ItemQueryResults = z.infer<typeof itemQueryResultsSchema>;

/**
 * The compile-time tie to the generated contract. A field Core renames stops this package
 * compiling rather than failing at runtime in front of a user.
 */
const _itemQueryContract = itemQueryResultsSchema satisfies z.ZodType<
  components['schemas']['QueryResultsResponse']
>;
void _itemQueryContract;
