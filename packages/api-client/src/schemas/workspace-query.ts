/**
 * What an ad-hoc workspace query or aggregate answered (`POST /workspaces/{id}/query` and
 * `/query/aggregate`).
 *
 * The same guarantees as a saved query's results: **the rows were permission-filtered inside the
 * statement**, so a truncated answer is a full answer that was cut, never a full answer minus
 * refusals; and **`truncated` is the honest-state field** a view must surface. An aggregate adds a
 * third: **`skipped` counts values that were not numbers** and were left out of the fold rather
 * than counted as zero, so a total that skipped something must say so.
 */

import { z } from 'zod';
import type { components } from '../generated/api.js';

/** One item an ad-hoc query matched. */
const workspaceQueryRowSchema = z.object({
  id: z.uuid(),
  workspaceId: z.uuid(),

  /** Its parent, or null at a workspace root. */
  containerId: z.uuid().nullable(),

  /** The parent's title, so a row can say where it lives without a second read. */
  containerTitle: z.string().nullable(),

  /** The item's title, or null when it has never been named. */
  title: z.string().nullable(),

  /** The item's body kind. */
  type: z.string(),

  /** The property bag as stored. */
  properties: z.record(z.string(), z.unknown()),

  /** The row's group when the query was grouped; null for "no value" or when ungrouped. */
  group: z.string().nullable(),
});

export type WorkspaceQueryRow = z.infer<typeof workspaceQueryRowSchema>;

/** One group of a grouped query, in display order. */
const queryGroupSchema = z.object({
  /** The group's value, or null for "no value". */
  key: z.string().nullable(),

  /** What to call it; today the key itself, null for "no value". The server invents no copy. */
  label: z.string().nullable(),

  /** Every matched row in the group, including any the limit cut. */
  count: z.int(),
});

export type QueryGroup = z.infer<typeof queryGroupSchema>;

export const workspaceQueryResultsSchema = z.object({
  workspaceId: z.uuid(),

  /** The day the tokens resolved to, echoed; null when none was sent. */
  today: z.string().nullable(),

  results: z.array(workspaceQueryRowSchema),

  /** The ceiling the run applied: 100 unless asked, never more than 500. */
  limit: z.int(),

  /** True when more rows matched than the limit allowed, so this is part of the answer. */
  truncated: z.boolean(),

  groupBy: z.string().nullable(),

  /** The groups the returned rows fall in, in order; empty when ungrouped. */
  groups: z.array(queryGroupSchema),
});

export type WorkspaceQueryResults = z.infer<typeof workspaceQueryResultsSchema>;

/** One group of an aggregate. */
const aggregateGroupSchema = z.object({
  key: z.string().nullable(),
  label: z.string().nullable(),

  /** The fold over the group's numbers, or null when it has none; for `count`, the row count. */
  value: z.number().nullable(),

  /** How many rows the group holds. */
  count: z.int(),

  /** How many of them held a value that is not a number and were left out of the fold. */
  skipped: z.int(),
});

export type AggregateGroup = z.infer<typeof aggregateGroupSchema>;

export const workspaceAggregateSchema = z.object({
  workspaceId: z.uuid(),
  today: z.string().nullable(),

  /** The fold: `count`, `sum`, `avg`, `min` or `max`. An open string, like every view vocabulary. */
  function: z.string(),
  property: z.string().nullable(),
  groupBy: z.string().nullable(),

  /** The groups in display order, at most 100; empty when ungrouped. */
  groups: z.array(aggregateGroupSchema),

  /** The fold over every matched row, whatever the group ceiling cut. */
  total: z.number().nullable(),

  /** How many rows matched. */
  count: z.int(),

  /** How many matched rows held a value that is not a number, left out rather than counted as zero. */
  skipped: z.int(),

  /** How many groups exist. */
  groupCount: z.int(),

  /** Whether groups exist beyond the ones returned. */
  truncated: z.boolean(),
});

export type WorkspaceAggregate = z.infer<typeof workspaceAggregateSchema>;

/**
 * The compile-time ties to the generated contract. A field Core renames stops this package
 * compiling rather than failing at runtime in front of a user.
 */
const _workspaceQueryContract = workspaceQueryResultsSchema satisfies z.ZodType<
  components['schemas']['WorkspaceQueryResponse']
>;
void _workspaceQueryContract;

const _workspaceAggregateContract = workspaceAggregateSchema satisfies z.ZodType<
  components['schemas']['WorkspaceAggregateResponse']
>;
void _workspaceAggregateContract;
