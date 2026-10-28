/**
 * What one person has kept.
 *
 * Two properties of the payload are guarantees rather than accidents, and a view built against it
 * has to honour both.
 *
 * **Titles come from the items, not from the bookmarks.** A rename shows here immediately, and
 * nothing in this response is a stale copy of something that lives elsewhere.
 *
 * **A shelf can be larger than its list.** A bookmark outlives access to what it points at, so
 * `hidden` counts the kept items the caller may no longer read, or that have been trashed. It
 * deliberately does not say which: naming them would disclose the titles of documents somebody has
 * been removed from. A view that renders this must say the shelf is holding more than it can show,
 * because a short list looks exactly like a short shelf.
 */

import { z } from 'zod';
import type { components } from '../generated/api.js';
import { itemTypeSchema } from './item.js';

/** One item on the shelf. */
const keptItemSchema = z.object({
  itemId: z.uuid(),

  /**
   * What the item is called, or null when it has never been named. The server does not invent a
   * name, so a view that wants one supplies its own copy.
   */
  title: z.string().nullable(),

  type: itemTypeSchema,

  /** Which workspace it lives in. A shelf crosses workspaces, so an item has to say where it is. */
  workspaceId: z.uuid(),

  keptAt: z.iso.datetime({ offset: true }),
});

export type KeptItem = z.infer<typeof keptItemSchema>;

/**
 * A count the server sends as either an integer or a string, per the contract.
 *
 * The same union `itemSequenceSchema` uses, for the same reason: accept what the contract permits
 * rather than what we expect to see.
 */
const shelfCountSchema = z.union([z.int(), z.string().regex(/^-?\d+$/)]);

export const shelfSchema = z.object({
  items: z.array(keptItemSchema),

  /** How many kept items are not in `items`, because they cannot currently be read. */
  hidden: shelfCountSchema,
});

export type Shelf = z.infer<typeof shelfSchema>;

/**
 * The compile-time tie to the generated contract. A field Core renames stops this package
 * compiling rather than failing at runtime in front of a user.
 */
const _shelfContract = shelfSchema satisfies z.ZodType<components['schemas']['ShelfResponse']>;
void _shelfContract;
