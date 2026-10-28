/**
 * `nixctl item`: the tree, read and written.
 *
 * Every item is the same kind of thing - a body, children, a property schema, views - so these are
 * the operations on that one shape: list a container's children, read one, create one, move one,
 * trash one, bring it back. The commands are thin adapters over `@nix/api-client`'s item resource,
 * so a rule about what a move may do or how a delete is soft lives in Core and its client, not here.
 *
 * A workspace id is required where the underlying request needs it (creating, moving, deleting,
 * restoring and listing all name the workspace, so its cache can be kept in step); reading one item
 * by id does not.
 */

import { items } from '@nix/api-client';
import { resolveSession, type SessionDeps } from './shared.ts';
import { printResult, type OutputOptions } from '../output.ts';

interface ItemView {
  readonly id: string;
  readonly title: string;
  readonly type: string;
  readonly parentId: string | null;
  readonly hasChildren: boolean;
  readonly lifecycleState: string;
}

function view(item: ItemView): ItemView {
  return {
    id: item.id,
    title: item.title,
    type: item.type,
    parentId: item.parentId,
    hasChildren: item.hasChildren,
    lifecycleState: item.lifecycleState,
  };
}

/** What `item get` prints: the list row plus the property values a one-item read is for. */
interface ItemDetailView extends ItemView {
  readonly properties: Readonly<Record<string, unknown>>;
}

function detailView(item: ItemDetailView): ItemDetailView {
  return { ...view(item), properties: item.properties };
}

export interface ListOptions {
  readonly workspaceId: string;
  readonly parentId?: string | undefined;
  readonly includeDeleted: boolean;
}

/** Lists the children of a container, or the workspace roots when no parent is named. */
export async function listItems(
  profileName: string | undefined,
  options: ListOptions,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const session = await resolveSession(profileName, deps);
  const endpoint = items.listItems(options.workspaceId, {
    parentId: options.parentId,
    includeDeleted: options.includeDeleted,
  });

  const rows: ItemView[] = [];
  for await (const item of session.client.paginate(endpoint)) {
    rows.push(view(item));
  }

  printResult({ items: rows, count: rows.length }, output);
}

/** Reads one item by id. */
export async function getItem(
  profileName: string | undefined,
  itemId: string,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const session = await resolveSession(profileName, deps);
  const item = await session.client.query(items.itemById(itemId));
  // The one-item read carries the property values too - `props set` reports only the keys it
  // wrote, so this is how a script (or an import verification) reads a value back. The list view
  // stays trimmed; a tree listing is about shape, not contents. Core mirrors the title into the
  // property bag on every create, so `properties.title` here is the server's echo - the top-level
  // `title` is the canonical one.
  printResult(detailView(item), output);
}

export interface CreateOptions {
  readonly workspaceId: string;
  readonly type: string;
  readonly title: string;
  readonly parentId?: string | null | undefined;
}

/** Creates an item under a parent, or at the workspace root when no parent is named. */
export async function createItem(
  profileName: string | undefined,
  options: CreateOptions,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const session = await resolveSession(profileName, deps);
  const item = await session.client.execute(
    items.createItem(options.workspaceId, {
      type: options.type,
      title: options.title,
      parentId: options.parentId ?? null,
    }),
  );
  printResult(view(item), output);
}

export interface MoveOptions {
  readonly workspaceId: string;
  readonly destinationWorkspaceId?: string | undefined;
  readonly parentId: string | null;
  readonly afterId?: string | null | undefined;
}

/** Moves an item to a new parent and position. */
export async function moveItem(
  profileName: string | undefined,
  itemId: string,
  options: MoveOptions,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const session = await resolveSession(profileName, deps);
  const item = await session.client.execute(
    items.moveItem(options.workspaceId, itemId, {
      parentId: options.parentId,
      afterId: options.afterId,
      workspaceId: options.destinationWorkspaceId,
    }),
  );
  printResult({ ...view(item), workspaceId: item.workspaceId }, output);
}

/** Soft-deletes an item; it can be restored until it is purged. */
export async function deleteItem(
  profileName: string | undefined,
  itemId: string,
  workspaceId: string,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const session = await resolveSession(profileName, deps);
  await session.client.execute(items.deleteItem(workspaceId, itemId));
  printResult({ id: itemId, deleted: true }, output);
}

/** Restores a soft-deleted item. */
export async function restoreItem(
  profileName: string | undefined,
  itemId: string,
  workspaceId: string,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const session = await resolveSession(profileName, deps);
  const item = await session.client.execute(items.restoreItem(workspaceId, itemId));
  printResult(view(item), output);
}

/** Renames an item; moving and deleting are separate operations, as the contract has them. */
export async function renameItem(
  profileName: string | undefined,
  itemId: string,
  workspaceId: string,
  title: string,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const session = await resolveSession(profileName, deps);
  const item = await session.client.execute(items.renameItem(workspaceId, itemId, title));
  printResult(view(item), output);
}
