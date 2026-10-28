/**
 * An item: the workspace's universal object — a note, task, folder, board or file.
 *
 * Two rules make this file work, and they are the pattern every resource schema copies. The schema
 * is the source of truth and the TypeScript type is always `z.infer` of it, never a hand-written
 * interface that can drift. And the `satisfies` line at the bottom ties it to the generated
 * contract, so a field the backend renames fails this package's build instead of failing at
 * runtime in front of a user.
 *
 * This schema was previously a guess made before the contract existed, and it was wrong in three
 * ways worth remembering: it called the field `kind` and typed it as an enum, and it was missing
 * `seq`, `lifecycleState` and `createdAt`. The enum was the interesting mistake — item kinds are
 * added as a feature, so an enum would have broken every client each time one landed.
 *
 * The `satisfies` line has since earned itself once more: `properties` arrived with property
 * schemas and this file stopped compiling, which is exactly where that should be found.
 */

import { z } from 'zod';
import type { components } from '../generated/api.js';

/**
 * The item's kind, as an open string.
 *
 * Deliberately not an enum. It says how an item's own *body* is drawn - a note's prose, a canvas's
 * scene - and nothing about what it can contain: every item can hold children, declare a property
 * schema and offer views, whatever its kind. The set is open by design and a client is expected to
 * render an unknown kind generically rather than fail to parse the response that carried it.
 */
export const itemTypeSchema = z.string();

/**
 * Kinds this build renders specially. Anything else falls back to a generic row.
 *
 * `folder` is gone: it was never a kind of body, only a claim about what an item could contain,
 * and that claim is no longer any item's to make. `file` and `task` went with it as things that
 * were listed here and created nowhere - MVP-6 brings files back when there is a body to draw.
 */
export const KNOWN_ITEM_TYPES = ['note', 'canvas', 'spreadsheet', 'artifact'] as const;

/** Where an item sits in the deletion lifecycle. Open for the same reason as the kind. */
const itemLifecycleStateSchema = z.string();

/**
 * Sibling position.
 *
 * The contract types this as `number | string` because it is a 64-bit integer, and values beyond
 * `Number.MAX_SAFE_INTEGER` cannot survive a round trip through a JavaScript number. Real
 * positions are small — they advance in gaps of a thousand — but the schema accepts what the
 * contract permits rather than what we expect to see, because the day one exceeds it the honest
 * outcome is a wide type rather than a silently rounded sort order.
 *
 * Both branches are narrowed to exactly what `BigInt` can convert without throwing or silently
 * defaulting: the number branch must be an integer (`BigInt(1.5)` throws `RangeError`), and the
 * string branch must match an optional-sign run of digits (a bare `z.string()` would let through
 * `'1e3'` or `'x'`, which throw `SyntaxError` when handed to `BigInt`, and `''`, which `BigInt`
 * quietly turns into `0n` instead of failing). Anything that doesn't fit fails to parse here, at
 * the boundary, rather than throwing - or worse, silently misordering - inside a sort comparator
 * downstream.
 */
const itemSequenceSchema = z.union([z.int(), z.string().regex(/^-?\d+$/)]);

/**
 * The item's property values, keyed by the schema's property keys.
 *
 * `unknown` rather than a union of the value shapes, deliberately. A property's type is declared by
 * a schema this package cannot see, the set of types is open, and a value whose type this build
 * does not recognise still has to survive being parsed - so the boundary's job here is to prove the
 * bag is an object and hand the values on. Interpreting one is the job of whatever knows the schema
 * it belongs to.
 *
 * The title lives in here as well as in the flat field. The flat one is the promotion every client
 * needs to render a row; this is the storage it was promoted from.
 */
const itemPropertiesSchema = z.record(z.string(), z.unknown());

export const itemSchema = z.object({
  id: z.uuid(),
  workspaceId: z.uuid(),
  parentId: z.uuid().nullable(),
  type: itemTypeSchema,
  title: z.string(),

  /**
   * Whether the item has at least one child that is not deleted.
   *
   * The tree draws its expand control from this rather than from the item's type, because every
   * item can hold children - so without it every row would have to offer one, and most would
   * expand to nothing.
   */
  hasChildren: z.boolean(),

  seq: itemSequenceSchema,
  lifecycleState: itemLifecycleStateSchema,
  properties: itemPropertiesSchema,

  /**
   * The values the item has without storing one: every rollup the schema in force declares, folded
   * across this item's own children.
   *
   * **Null is not empty, and the difference is load-bearing.** A read that did not fold children
   * sends null - a write response answers with the item, not with a fresh fold of its children -
   * and a read that folded and found no rollups sends `{}`. A client that conflated the two would
   * draw a rollup column blank after every edit. Defaulted as well as nullable, so a server from
   * before the field still parses.
   */
  computed: itemPropertiesSchema.nullable().default(null),

  /**
   * Whether the item is protected from deletion. It cannot be trashed, and neither can an ancestor
   * while it sits beneath it. Defaulted, so a server from before the field still parses.
   */
  noDelete: z.boolean().default(false),

  /** Whether the item refuses new children: nothing can be created under it or moved into it. */
  noChildren: z.boolean().default(false),

  /**
   * The system feature managing the item (`calendar` for a linked calendar's container,
   * `calendar_event` for a mirrored event), or null. A managed item's deletion protection is the
   * system's, and is lifted by unlinking the calendar in settings, never by the protection toggle.
   */
  managedBy: z.string().nullable().default(null),

  // `offset: true`, because the server sends one. Core serialises a `DateTimeOffset`, which
  // reaches the wire as `2026-07-26T21:59:30.648333+00:00` - and Zod's default rejects anything
  // that is not `Z`, so every single item response was failing this check and logging it. The
  // parse still has to be strict about being a timestamp at all; what it must not be strict
  // about is which of two legal spellings of UTC the server picked.
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});

export type Item = z.infer<typeof itemSchema>;

/**
 * The compile-time tie to the generated contract.
 *
 * If Core renames a field or changes a type, this line stops compiling and the failure lands here,
 * in the package that owns the boundary, rather than in a component at runtime.
 */
const _itemContract = itemSchema satisfies z.ZodType<components['schemas']['ItemResponse']>;
void _itemContract;
