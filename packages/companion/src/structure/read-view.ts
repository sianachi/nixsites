import {
  itemChart,
  itemQuery,
  structure,
  views,
  workspaceQuery,
  type ItemChart,
  type QueryGroup,
  type QueryResultRow,
  type WorkspaceAggregate,
  type WorkspaceAggregateQuery,
  type WorkspaceQueryMatch,
} from '@nix/api-client';
import { isComputedType, SORTED_VIEW_KINDS } from '@nix/structure-spec';
import { z } from 'zod';
import { checkItem } from '../guards.js';
import type { CompanionPorts } from '../ports.js';
import { WorkspaceToolRefusal } from '../tool-args.js';
import { describeView, type ReadStructureView } from './read-structure.js';

export const MAX_VIEW_SAMPLE = 25;
const MAX_AGGREGATES = 4;
/** Core's six named series and its possible Other series. */
const MAX_CHART_SERIES = 7;

export const readViewQuerySchema = z.strictObject({
  viewId: z.string().min(1).max(128),
  pageSize: z.int().min(1).max(MAX_VIEW_SAMPLE).default(MAX_VIEW_SAMPLE),
  cursor: z.string().max(1024).optional(),
});

export interface ReadViewResult {
  item: { id: string; title: string; type: string };
  view: ReadStructureView;
  source: 'saved_query' | 'workspace_query' | 'chart' | 'configuration_only';
  today: string;
  timeZone: string;
  /** Whether the saved filter rules were applied to these rows by Core. */
  appliedViewRules: boolean;
  results: QueryResultRow[];
  returned: number;
  totalCount: number | null;
  truncated: boolean;
  /** No cursor is manufactured: the current Core query contracts expose limits, not pages. */
  nextCursor: null;
  limits: string[];
  /** Aggregate contributors and matches beyond the sample cannot all be lock-probed without
   * unbounded reads. The executor uses this flag to hold later writes for owner review. */
  hasUnboundedProvenance: boolean;
  groups?: QueryGroup[];
  aggregates?: WorkspaceAggregate[];
  chart?: ItemChart;
  chartSampleTruncated?: boolean;
}

/** Reads saved configuration before its data. All row selection and folds run in Core, so a
 * sampling limit is spent on visible matching rows rather than a first page filtered afterwards.
 * Specialty renderers and transient browser rules are explicitly outside this stored read. */
export async function readView(
  ports: CompanionPorts,
  workspaceId: string,
  itemId: string,
  queryJson: string,
  signal: AbortSignal,
): Promise<ReadViewResult> {
  let raw: unknown;
  try {
    raw = JSON.parse(queryJson) as unknown;
  } catch {
    throw new WorkspaceToolRefusal(
      'read_view query must be JSON with viewId and optional pageSize (1 to 25).',
    );
  }
  const parsed = readViewQuerySchema.safeParse(raw);
  if (!parsed.success)
    throw new WorkspaceToolRefusal(
      'read_view requires viewId and an optional pageSize from 1 to 25; no additional query rules are accepted.',
    );
  const request = parsed.data;
  if (request.cursor)
    throw new WorkspaceToolRefusal(
      'Core view reads do not support cursors. This tool returns a bounded sample, not a page that can be continued.',
    );

  const item = await checkItem(ports, workspaceId, itemId, signal);
  const options = { signal, forceRefresh: true };
  const [configuration, schema] = await Promise.all([
    ports.core.query(views.containerViewConfigurations(itemId), options),
    ports.core.query(structure.effectiveSchema(itemId), options),
  ]);
  const rawView = configuration.views.find((candidate) => candidate.id === request.viewId);
  if (rawView === undefined)
    throw new WorkspaceToolRefusal('This view was not found on the item. No result was read.');
  const view = describeView(
    rawView,
    configuration,
    new Map(schema.properties.map((property) => [property.key, property.label])),
  );
  const base: ReadViewResult = {
    item: { id: item.id, title: item.title, type: item.type },
    view,
    source: 'configuration_only',
    today: ports.clock.today(),
    timeZone: ports.clock.timeZone(),
    appliedViewRules: false,
    results: [],
    returned: 0,
    totalCount: null,
    truncated: false,
    nextCursor: null,
    limits: [
      'This read uses saved configuration. Temporary browser filters, personally hidden items and collapsed groups are not reproduced.',
    ],
    hasUnboundedProvenance: false,
  };
  if (!view.canRender)
    throw new WorkspaceToolRefusal(
      'Core marks this view as unrenderable. Inspect read_structure for its configured fields and types. No data result was attempted; this is not an empty view.',
    );
  if (view.kind === 'query') {
    const result = await ports.core.query(
      itemQuery.itemQuery(itemId, view.id, base.today),
      options,
    );
    const scopedRows = result.results.filter((row) => row.workspaceId === workspaceId);
    base.limits.push(
      'Core saved queries have no cursor or exact total count; this is a sample of their bounded result.',
    );
    base.limits.push(
      "Saved queries may span workspaces. Only results in this conversation's workspace are returned; this does not describe matches in other workspaces.",
    );
    return {
      ...base,
      source: 'saved_query',
      appliedViewRules: true,
      results: scopedRows.slice(0, request.pageSize),
      returned: Math.min(scopedRows.length, request.pageSize),
      totalCount: null,
      truncated: result.truncated || scopedRows.length > request.pageSize,
      hasUnboundedProvenance: result.truncated || scopedRows.length > request.pageSize,
    };
  }
  if (view.kind === 'chart') {
    const chart = await ports.core.query(itemChart.itemChart(itemId, view.id), options);
    const sampleTruncated =
      chart.buckets.length > request.pageSize ||
      chart.series.length > MAX_CHART_SERIES ||
      chart.buckets.some((bucket) => bucket.cells.length > MAX_CHART_SERIES);
    base.limits.push(
      'Chart buckets and totals are computed by Core over the chart source. This is aggregate evidence, not item rows; the bucket sample may omit buckets.',
    );
    if (view.filters.length > 0)
      base.limits.push(
        "The current Core chart endpoint does not apply this view's saved filters. These chart totals must not be described as filtered.",
      );
    return {
      ...base,
      source: 'chart',
      appliedViewRules: view.filters.length === 0,
      totalCount: chart.children,
      returned: Math.min(chart.buckets.length, request.pageSize),
      truncated: chart.truncated || sampleTruncated,
      chart: {
        ...chart,
        series: chart.series.slice(0, MAX_CHART_SERIES),
        buckets: chart.buckets.slice(0, request.pageSize).map((bucket) => ({
          ...bucket,
          cells: bucket.cells.slice(0, MAX_CHART_SERIES),
        })),
      },
      chartSampleTruncated: sampleTruncated,
      hasUnboundedProvenance: true,
    };
  }

  // Stored formulas and rollups have no matching values in Core's ad-hoc query source. A query
  // over those keys would look exact while disagreeing with the computed values on screen.
  const computed = new Set(
    schema.properties
      .filter((property) => isComputedType(property.type))
      .map((property) => property.key),
  );
  const appliesSavedRules = (SORTED_VIEW_KINDS as readonly string[]).includes(view.kind);
  const filterKeys = view.filters.flatMap(
    (rule) => rule.any?.map((condition) => condition.property) ?? [rule.property],
  );
  if (appliesSavedRules && filterKeys.some((key) => key !== null && computed.has(key))) {
    base.limits.push(
      'A saved filter names a computed field. Core workspace queries match stored values, so they cannot faithfully evaluate this view. No data result was attempted; this is not an empty view.',
    );
    return base;
  }

  const match: WorkspaceQueryMatch = {
    scope: { parentId: itemId, descendants: false },
    filters: appliesSavedRules ? view.filters : [],
    today: base.today,
    ...(!appliesSavedRules || view.groupBy === null
      ? {}
      : { groupBy: { property: view.groupBy, order: view.groupOrder } }),
  };
  const sort = !appliesSavedRules
    ? undefined
    : (view.sorts[0] ??
      (view.sortBy === null
        ? undefined
        : { property: view.sortBy, descending: view.sortDescending }));
  const queryMatch = {
    ...match,
    ...(sort === undefined || computed.has(sort.property) ? {} : { sort }),
    limit: request.pageSize,
  };
  const [result, count] = await Promise.all([
    ports.core.execute(workspaceQuery.runWorkspaceQuery(workspaceId, queryMatch), { signal }),
    ports.core.execute(
      workspaceQuery.aggregateWorkspaceQuery(workspaceId, {
        ...match,
        aggregate: { function: 'count' },
      }),
      { signal },
    ),
  ]);
  const aggregates: WorkspaceAggregate[] = [];
  for (const aggregate of (appliesSavedRules ? view.aggregates : []).slice(0, MAX_AGGREGATES)) {
    const fold = aggregate.function;
    if (!['count', 'sum', 'avg', 'min', 'max'].includes(fold) || computed.has(aggregate.property)) {
      base.limits.push(
        `The ${fold} summary of ${aggregate.property} is not supported by Core's stored-value aggregate read.`,
      );
      continue;
    }
    aggregates.push(
      await ports.core.execute(
        workspaceQuery.aggregateWorkspaceQuery(workspaceId, {
          ...match,
          aggregate: {
            function: fold as WorkspaceAggregateQuery['aggregate']['function'],
            property: aggregate.property,
          },
        }),
        { signal },
      ),
    );
  }
  if (view.aggregates.length > MAX_AGGREGATES)
    base.limits.push(`At most ${String(MAX_AGGREGATES)} configured summaries are read per call.`);
  if (result.groups.length > request.pageSize)
    base.limits.push(
      'Only the first groups fit in this bounded sample. Group counts come from Core, and more groups may exist.',
    );
  base.limits.push(
    'The sample uses Core stored-value filter semantics and query ordering. It does not reproduce type-aware UI ordering, computed columns, per-group display limits or nested outline descendants.',
  );
  base.limits.push(
    'Rows, counts and configured summaries are separate Core reads; concurrent changes can make their snapshots differ.',
  );
  if (view.sorts.length > 1)
    base.limits.push('Core currently accepts one sort key; only the first saved sort key is used.');
  if (sort !== undefined && computed.has(sort.property))
    base.limits.push(
      'The saved sort names a computed field, so Core default query ordering is used.',
    );
  if (['form', 'interactive_form', 'habit_tracker', 'finance', 'drive'].includes(view.kind))
    base.limits.push(
      'This result samples matching child items. Specialized submissions, habit check-ins, finance calculations and file previews are not read by this operation.',
    );
  if (!appliesSavedRules)
    base.limits.push(
      'This renderer does not apply saved filters or sorting. The read ignores those settings and samples direct children in Core default query order; its count describes children, not the specialized display.',
    );
  return {
    ...base,
    source: 'workspace_query',
    appliedViewRules: appliesSavedRules,
    results: result.results.slice(0, request.pageSize),
    returned: Math.min(result.results.length, request.pageSize),
    totalCount: count.count,
    truncated: result.truncated || result.results.length > request.pageSize,
    groups: result.groups.slice(0, request.pageSize),
    aggregates,
    hasUnboundedProvenance: true,
  };
}
