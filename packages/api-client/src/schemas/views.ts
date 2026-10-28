/**
 * A container's views, as `GET /items/{id}/views` returns them — the summary a caller needs to
 * decide what to open.
 *
 * **A summary on purpose, not the whole `ViewResponse`.** A view's full configuration — its columns,
 * grouping, filters, form — is what `query` runs, not what a caller listing a container's views
 * reads; so this parses each view down to its identity (id, name, kind) and the two container-level
 * facts (which views cannot currently render, and which one opens by default). The `satisfies` ties
 * below are to a `Pick` of the generated contract, so a rename of any field we *do* read fails this
 * package's build, while the fields we deliberately drop cost nothing to carry.
 */

import { z } from 'zod';
import type { components } from '../generated/api.js';

const viewSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.string(),
});

export const containerViewsSchema = z.object({
  views: z.array(viewSummarySchema),

  /** Views whose configured property is gone or no longer fits, so they cannot draw. */
  unrenderable: z.array(z.string()),

  /** What opens: a view id, or `document` for the item's own body. */
  default: z.string(),

  /**
   * Whether the item's own document tab is left out of its switcher. A hidden tab, not a protected
   * body: nothing about who can read the item changes. Defaulted so an older server, which never
   * sends it, still parses as "shown".
   */
  hideDocument: z.boolean().default(false),
  version: z.string().nullable().default(null),
});

export type ContainerViews = z.infer<typeof containerViewsSchema>;

const nullableText = z.string().nullable().default(null);
const textList = z
  .array(z.string())
  .nullish()
  .transform((value) => value ?? []);
const wireInteger = z.union([z.int(), z.string().regex(/^-?\d+$/)]);

const filterConditionSchema = z.object({
  property: nullableText,
  operator: nullableText,
  value: nullableText,
});
const filterRuleSchema = filterConditionSchema.extend({
  any: z.array(filterConditionSchema).nullable().default(null),
});
const formConditionSchema = z.object({
  fieldBlockId: z.string(),
  operator: z.string(),
  value: nullableText,
});
const interactiveFormSchema = z.object({
  pages: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      description: nullableText,
      visibleWhen: z.array(formConditionSchema).default([]),
      blocks: z.array(
        z.object({
          id: z.string(),
          kind: z.string(),
          propertyKey: nullableText,
          text: z.string(),
          help: nullableText,
          required: z.boolean(),
          identityRole: nullableText,
          visibleWhen: z.array(formConditionSchema).default([]),
        }),
      ),
    }),
  ),
  titleMode: z.string(),
  titleFieldBlockId: nullableText,
  confirmationTitle: z.string(),
  confirmationMessage: z.string(),
});

/** Full stored configuration, shared by editors and the pet's evidence reads. Defaults preserve
 * reads from servers predating optional view features; every known field is tied to Core's wire. */
export const viewConfigurationSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.string(),
  columns: textList,
  groupBy: nullableText,
  groupOrder: textList,
  dateProperty: nullableText,
  sortBy: nullableText,
  sortDescending: z.boolean().default(false),
  mode: nullableText,
  coverProperty: nullableText,
  endDateProperty: nullableText,
  cardSize: nullableText,
  open: nullableText,
  filters: z.array(filterRuleSchema).default([]),
  companionViewId: nullableText,
  companionPlacement: nullableText,
  interactiveForm: interactiveFormSchema.nullable().default(null),
  measure: nullableText,
  measureProperty: nullableText,
  sorts: z.array(z.object({ property: z.string(), descending: z.boolean() })).default([]),
  collapsedGroups: textList,
  groupLimits: z.array(z.object({ group: z.string(), limit: wireInteger })).default([]),
  aggregates: z.array(z.object({ property: z.string(), function: z.string() })).default([]),
  habitWidgets: z
    .array(
      z.object({
        id: z.string(),
        kind: z.string(),
        habitId: z.string(),
        from: z.string(),
        to: z.string(),
      }),
    )
    .nullish()
    .transform((value) => value ?? []),
  layout: nullableText,
  doneProperty: nullableText,
  rowBy: nullableText,
  program: nullableText,
  chart: z
    .object({
      kind: nullableText,
      period: nullableText,
      splitBy: nullableText,
      lastPeriods: wireInteger.nullable().default(null),
      from: nullableText,
      to: nullableText,
      cumulative: z.boolean().nullable().default(null),
      rollingAverage: z.boolean().nullable().default(null),
      stacked: z.boolean().nullable().default(null),
    })
    .nullable()
    .default(null),
}) satisfies z.ZodType<components['schemas']['ViewResponse']>;

export type ViewConfiguration = z.infer<typeof viewConfigurationSchema>;

export const containerViewConfigurationsSchema = z.object({
  views: z.array(viewConfigurationSchema),
  unrenderable: z.array(z.string()),
  default: z.string(),
  hideDocument: z.boolean().default(false),
  version: z.string().nullable().default(null),
});

export type ContainerViewConfigurations = z.infer<typeof containerViewConfigurationsSchema>;

type ViewSummaryContract = Pick<components['schemas']['ViewResponse'], 'id' | 'name' | 'kind'>;
const _viewContract = viewSummarySchema satisfies z.ZodType<ViewSummaryContract>;
void _viewContract;

type ContainerViewsSummaryContract = Pick<
  components['schemas']['ContainerViewsResponse'],
  'unrenderable' | 'default' | 'hideDocument'
> & { views: ViewSummaryContract[] };
const _containerContract = containerViewsSchema satisfies z.ZodType<ContainerViewsSummaryContract>;
void _containerContract;
