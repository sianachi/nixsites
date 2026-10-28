/**
 * Full-text search results, as `GET /api/v1/search` returns them.
 *
 * `truncated` is carried as its own field, never folded into the result list: a cut result set is an
 * honest partial answer, and a caller (the CLI, the MCP server) must be able to say "there are more"
 * rather than present a capped list as complete. Each hit is the identity a caller needs to open the
 * item — its id, its workspace, its body kind and its title — plus its parent and modification time,
 * which a picker uses to rank, and nothing heavier.
 */

import { z } from 'zod';
import type { components } from '../generated/api.js';

export const searchHitSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  type: z.string(),
  title: z.string().nullable(),
  /** The item it sits under, or null for a workspace root; ranks siblings of the open note first. */
  parentId: z.string().nullable(),
  /** When the item was last modified (ISO 8601), for ranking by recency. */
  updatedAt: z.string(),
});

export type SearchHit = z.infer<typeof searchHitSchema>;

export const searchResultsSchema = z.object({
  query: z.string(),
  results: z.array(searchHitSchema),
  /** The cap that was applied; the result count reaching it is why `truncated` may be set. */
  limit: z.number(),
  /** Whether more matches existed than the limit returned — an honest partial, never hidden. */
  truncated: z.boolean(),
});

export type SearchResults = z.infer<typeof searchResultsSchema>;

const _hitContract = searchHitSchema satisfies z.ZodType<
  components['schemas']['SearchHitResponse']
>;
void _hitContract;

const _resultsContract = searchResultsSchema satisfies z.ZodType<
  components['schemas']['SearchResponse']
>;
void _resultsContract;

/** Passages of a note and the notes under it, as `GET /api/v1/items/{id}/passages` returns them. */
export const notePassagesSchema = z.object({
  passages: z.array(
    z.object({
      itemId: z.string(),
      title: z.string(),
      /** The heading trail above the passage, outermost first; empty before the first heading. */
      heading: z.string(),
      ord: z.number(),
      text: z.string(),
    }),
  ),
});

export type NotePassages = z.infer<typeof notePassagesSchema>;

const _passagesContract = notePassagesSchema satisfies z.ZodType<
  components['schemas']['PassagesResponse']
>;
void _passagesContract;
