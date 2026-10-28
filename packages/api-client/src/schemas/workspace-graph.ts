/**
 * A workspace drawn as a graph: a node per item the caller may read, and a link per reference edge
 * between two of those nodes.
 *
 * Two properties of the payload are worth knowing before writing a view against it, because both
 * are guarantees rather than accidents. A link's two ends are always present in `nodes`, and a
 * node's `parentId` is null unless that parent is in `nodes` too — so nothing here points at
 * something the response does not carry, and a renderer never has to decide what to draw for a
 * dangling reference. And the response is bounded: when `nodesTruncated` or `linksTruncated` is
 * true, what came back is a real part of the workspace rather than all of it.
 *
 * That second one is the reason this schema does not treat the flags as optional detail. A
 * truncated list looks short and a truncated graph looks like a graph — a reader would conclude two
 * clusters are unconnected, which is a wrong answer rather than a missing one. A view that renders
 * this must say so.
 */

import { z } from 'zod';
import type { components } from '../generated/api.js';
import { itemTypeSchema } from './item.js';

/** One item, as a graph drawing needs it. */
const graphNodeSchema = z.object({
  id: z.uuid(),

  /**
   * The parent, or null at the workspace root — and also null when the parent exists but fell
   * outside the node ceiling, which is what keeps the payload self-contained.
   */
  parentId: z.uuid().nullable(),

  type: itemTypeSchema,

  /**
   * What the item is called, or null when it has never been named. The server does not invent a
   * name, so a view that wants one supplies its own copy.
   */
  title: z.string().nullable(),

  /** When the item was created. What a time-lapse orders the drawing by. */
  createdAt: z.iso.datetime({ offset: true }),

  /**
   * When the item was last modified, or null when the item is locked or sits under a lock - the
   * time a withheld body last changed is withheld with it.
   */
  lastModifiedAt: z.iso.datetime({ offset: true }).nullable(),
});

export type GraphNode = z.infer<typeof graphNodeSchema>;

/** One reference edge. Both ends are nodes of the same response. */
const graphLinkSchema = z.object({
  sourceId: z.uuid(),
  targetId: z.uuid(),

  /** How many times the source refers to the target. Published as an integer or its decimal string. */
  occurrences: z.union([z.int(), z.string().regex(/^-?\d+$/)]),
});

export type GraphLink = z.infer<typeof graphLinkSchema>;

/**
 * A ceiling the server applied, echoed back.
 *
 * `number | string` for the reason `itemSequenceSchema` is: the contract publishes integers as
 * either, and the schema accepts what the contract permits rather than what we expect to see.
 */
const graphLimitSchema = z.union([z.int(), z.string().regex(/^-?\d+$/)]);

export const workspaceGraphSchema = z.object({
  workspaceId: z.uuid(),
  nodes: z.array(graphNodeSchema),
  links: z.array(graphLinkSchema),
  nodeLimit: graphLimitSchema,
  linkLimit: graphLimitSchema,

  /** True when the node ceiling was reached, so this is part of the workspace and not all of it. */
  nodesTruncated: z.boolean(),

  /** True when the link ceiling was reached. Independent of `nodesTruncated`. */
  linksTruncated: z.boolean(),
});

export type WorkspaceGraph = z.infer<typeof workspaceGraphSchema>;

/**
 * The compile-time tie to the generated contract. A field Core renames stops this package
 * compiling rather than failing at runtime in front of a user.
 */
const _workspaceGraphContract = workspaceGraphSchema satisfies z.ZodType<
  components['schemas']['WorkspaceGraphResponse']
>;
void _workspaceGraphContract;
