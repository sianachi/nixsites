/**
 * The items resource: the only place item URLs appear.
 *
 * Every method returns a descriptor rather than performing a request, so the client decides how it
 * is executed — deduplicated, cached, cancelled — and a caller writes `client.query(items.byId(id))`
 * without ever seeing a path. That is what keeps URL construction out of components.
 *
 * Paths are written against the committed contract at `backend/openapi/nix-api.json`. Every
 * operation below currently answers 501 with `api.not_implemented`: the shapes are real and stable,
 * the behaviour arrives with the goal that implements them. Build against MSW until then — a 501 is
 * deliberately impossible to mistake for a working endpoint.
 */

import {
  defineCommand,
  definePagedQuery,
  defineQuery,
  type CommandEndpoint,
  type PagedQueryEndpoint,
  type QueryEndpoint,
} from '../endpoints.js';
import { itemSchema, noContentSchema, type Item } from '../schemas/index.js';
import type {
  CreateItemRequestContract,
  CreateStructuredItemRequestContract,
  MoveItemRequestContract,
  StructuredItemContract,
  UpdateItemRequestContract,
} from '../contracts.js';
import type { components } from '../generated/api.js';
import { z } from 'zod';

/** Cache key prefix for everything under one workspace's tree. */
const workspaceTreeKey = (workspaceId: string): readonly string[] => [
  'workspaces',
  workspaceId,
  'items',
];

/** Cache key for one item. */
const itemKey = (itemId: string): readonly string[] => ['items', itemId];

export interface ListItemsOptions {
  /** The folder to list, or omitted for the workspace roots. */
  readonly parentId?: string | undefined;
  /** Whether soft-deleted items are included. Off by default, as the contract defaults it. */
  readonly includeDeleted?: boolean | undefined;
  /** Items per page; the server decides what it actually returns. */
  readonly pageSize?: number | undefined;
}

/** The children of a folder, or the workspace roots, in sibling order. */
export const listItems = (
  workspaceId: string,
  options: ListItemsOptions = {},
): PagedQueryEndpoint<Item> =>
  definePagedQuery<Item>({
    operation: 'items.list',
    path: `/api/v1/workspaces/${workspaceId}/items`,
    itemSchema,
    query: {
      parentId: options.parentId,
      includeDeleted: options.includeDeleted,
    },
    pageSize: options.pageSize,
  });

/** Directly deleted, recoverable items in one workspace, newest first. */
export const listTrash = (workspaceId: string, pageSize?: number): PagedQueryEndpoint<Item> =>
  definePagedQuery<Item>({
    operation: 'items.trash',
    path: `/api/v1/workspaces/${workspaceId}/items/trash`,
    itemSchema,
    pageSize,
  });

/** One item. */
export const itemById = (itemId: string): QueryEndpoint<Item> =>
  defineQuery<Item>({
    operation: 'items.get',
    path: `/api/v1/items/${itemId}`,
    schema: itemSchema,
    cacheKey: itemKey(itemId),
  });

export interface CreateItemInput {
  readonly type: string;
  readonly title: string;
  readonly parentId?: string | null | undefined;
  /** Stable UUID reused with the identical input until an offline creation is confirmed. */
  readonly idempotencyKey?: string | undefined;

  /**
   * Property values to store with the item, checked against the schema in force where it lands.
   *
   * **Sent with the create rather than patched afterwards**, which is what makes a seeded item one
   * write instead of two - and at the scale the stress rows name, two writes per item is twice as
   * far past the write rate limit for the same corpus. Omitted means an item with only its title,
   * which is what every create did before this field existed.
   */
  readonly properties?: Readonly<Record<string, unknown>> | undefined;
}

/** Creates an item under a parent, or at the workspace root when the parent is null. */
export const createItem = (workspaceId: string, input: CreateItemInput): CommandEndpoint<Item> =>
  defineCommand<Item>({
    operation: 'items.create',
    method: 'POST',
    path: `/api/v1/workspaces/${workspaceId}/items`,
    schema: itemSchema,
    body: {
      type: input.type,
      title: input.title,
      parentId: input.parentId ?? null,
      properties: input.properties ?? null,
      ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
    } satisfies CreateItemRequestContract,
    invalidates: [workspaceTreeKey(workspaceId)],
  });

/**
 * The write callers only consume the created item and the public form URL. Core's accompanying
 * schema and view summary remain authoritative on their dedicated reads, so deliberately omit
 * them here instead of maintaining a second full configuration parser.
 */
type StructuredItemWriteResultContract = Pick<StructuredItemContract, 'item'> & {
  publicForm: null | Pick<Exclude<StructuredItemContract['publicForm'], null>, 'url'>;
};

export const structuredItemSchema = z.object({
  item: itemSchema,
  publicForm: z.object({ url: z.string().nullable() }).nullable(),
}) satisfies z.ZodType<StructuredItemWriteResultContract>;

export type StructuredItem = z.infer<typeof structuredItemSchema>;

/** Atomically creates an item with its schema, views and optional published form. */
export const createStructuredItem = (
  workspaceId: string,
  body: CreateStructuredItemRequestContract,
): CommandEndpoint<StructuredItem> =>
  defineCommand<StructuredItem>({
    operation: 'items.createStructured',
    method: 'POST',
    path: `/api/v1/workspaces/${workspaceId}/structured-items`,
    schema: structuredItemSchema,
    body,
    invalidates: [workspaceTreeKey(workspaceId)],
  });

/** Renames an item. Moving and deleting are separate operations, as the contract has them. */
export const renameItem = (
  workspaceId: string,
  itemId: string,
  title: string,
): CommandEndpoint<Item> =>
  defineCommand<Item>({
    operation: 'items.rename',
    method: 'PATCH',
    path: `/api/v1/items/${itemId}`,
    schema: itemSchema,
    body: { title } satisfies UpdateItemRequestContract,
    invalidates: [itemKey(itemId), workspaceTreeKey(workspaceId)],
  });

export interface MoveItemInput {
  /** The new parent, or null for the workspace root. */
  readonly parentId: string | null;
  /** The sibling to place it after, or null to place it first. */
  readonly afterId?: string | null | undefined;
  /** Destination workspace; omitted keeps the item in its current workspace. */
  readonly workspaceId?: string | undefined;
}

/**
 * Moves an item to a new parent.
 *
 * Fails with `items.move_would_create_cycle` when the destination is the item itself or one of its
 * descendants — which is what dragging a folder onto its own child does, so it is an ordinary
 * outcome a view should render rather than an error to report.
 */
export const moveItem = (
  workspaceId: string,
  itemId: string,
  input: MoveItemInput,
): CommandEndpoint<Item> =>
  defineCommand<Item>({
    operation: 'items.move',
    method: 'POST',
    path: `/api/v1/items/${itemId}/move`,
    schema: itemSchema,
    body: {
      parentId: input.parentId,
      afterId: input.afterId ?? null,
      ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
    } satisfies MoveItemRequestContract,
    invalidates:
      input.workspaceId === undefined
        ? [itemKey(itemId), workspaceTreeKey(workspaceId)]
        : [
            ['items'],
            ['search'],
            ['bookmarks'],
            workspaceTreeKey(workspaceId),
            workspaceTreeKey(input.workspaceId),
          ],
  });

const itemMoveWorkspaceSchema = z.object({
  id: z.uuid(),
  name: z.string(),
}) satisfies z.ZodType<components['schemas']['ItemMoveWorkspace']>;

export type ItemMoveWorkspace = z.infer<typeof itemMoveWorkspaceSchema>;

/** Only active destinations Core confirms the caller can write are offered. */
export const listItemMoveWorkspaces = (itemId: string): PagedQueryEndpoint<ItemMoveWorkspace> =>
  definePagedQuery({
    operation: 'items.move.workspaces',
    path: `/api/v1/items/${itemId}/move-workspaces`,
    itemSchema: itemMoveWorkspaceSchema,
    pageSize: 100,
  });

export interface ItemProtectionInput {
  /** Whether the item is protected from deletion; omitted leaves it as it is. */
  readonly noDelete?: boolean;
  /** Whether the item refuses new children; omitted leaves it as it is. */
  readonly noChildren?: boolean;
  /** Whether several people may edit the item at once; omitted leaves it as it is. */
  readonly collaboration?: boolean;
}

/**
 * Sets an item's protections. Fails with `items.protection_managed` when the deletion protection
 * belongs to a linked calendar.
 */
export const setItemProtection = (
  workspaceId: string,
  itemId: string,
  input: ItemProtectionInput,
): CommandEndpoint<Item> =>
  defineCommand<Item>({
    operation: 'items.setProtection',
    method: 'PUT',
    path: `/api/v1/items/${itemId}/protection`,
    schema: itemSchema,
    body: {
      noDelete: input.noDelete ?? null,
      noChildren: input.noChildren ?? null,
      collaboration: input.collaboration ?? null,
    } satisfies components['schemas']['SetItemProtectionRequest'],
    invalidates: [itemKey(itemId), workspaceTreeKey(workspaceId)],
  });

/** Soft-deletes an item. The subtree stays intact and restoring is the same flag flipped back. */
export const deleteItem = (workspaceId: string, itemId: string): CommandEndpoint<undefined> =>
  defineCommand<undefined>({
    operation: 'items.delete',
    method: 'DELETE',
    path: `/api/v1/items/${itemId}`,
    schema: noContentSchema,
    invalidates: [itemKey(itemId), workspaceTreeKey(workspaceId)],
  });

/** Restores a soft-deleted item. */
export const restoreItem = (workspaceId: string, itemId: string): CommandEndpoint<Item> =>
  defineCommand<Item>({
    operation: 'items.restore',
    method: 'POST',
    path: `/api/v1/items/${itemId}/restore`,
    schema: itemSchema,
    invalidates: [itemKey(itemId), workspaceTreeKey(workspaceId)],
  });

export const purgeItem = (workspaceId: string, itemId: string): CommandEndpoint<undefined> =>
  defineCommand<undefined>({
    operation: 'items.purge',
    method: 'DELETE',
    path: `/api/v1/items/${itemId}/purge`,
    schema: noContentSchema,
    invalidates: [itemKey(itemId), workspaceTreeKey(workspaceId)],
  });
