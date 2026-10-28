/**
 * Model-free suggestion shapes: an item's co-citations (`GET /api/v1/items/{id}/related`) and the
 * titles a passage names (`POST /api/v1/search/mentions`).
 *
 * Both reuse the search hit, so a picker ranks every candidate with the same fields. Both carry
 * `truncated` as its own field, for the reason the search results do: a capped answer is an honest
 * partial, never a complete one.
 */

import { z } from 'zod';
import type { components } from '../generated/api.js';
import { searchHitSchema } from './search.js';

const integer = z.union([z.int(), z.string().regex(/^-?\d+$/)]);

const relatedItemSchema = z.object({
  item: searchHitSchema,
  /** How many readable, unlocked documents link to both this item and the one asked about. */
  sharedSources: integer,
});

export const relatedItemsSchema = z.object({
  /** Most shared sources first, then by title. */
  related: z.array(relatedItemSchema),
  limit: integer,
  truncated: z.boolean(),
});

export type RelatedItems = z.infer<typeof relatedItemsSchema>;

const mentionSchema = z.object({
  item: searchHitSchema,
  /** The words that matched, exactly as they appear in the text that was sent (NFC-normalised). */
  phrase: z.string(),
});

export type Mention = z.infer<typeof mentionSchema>;

export const mentionsSchema = z.object({
  /** Longest phrase first. */
  mentions: z.array(mentionSchema),
  /** Set when 20 matches were found, or the text held more phrases than one request matches. */
  truncated: z.boolean(),
});

export type Mentions = z.infer<typeof mentionsSchema>;

const _relatedItemsContract = relatedItemsSchema satisfies z.ZodType<
  components['schemas']['RelatedItemsResponse']
>;
void _relatedItemsContract;

const _mentionsContract = mentionsSchema satisfies z.ZodType<
  components['schemas']['MentionsResponse']
>;
void _mentionsContract;
