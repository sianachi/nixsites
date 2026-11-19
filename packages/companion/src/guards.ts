import { items, type Item } from '@nix/api-client';
import type { StructureProperty, StructureView } from '@nix/structure-spec';
import type { CompanionPorts } from './ports.js';
import { WorkspaceToolRefusal } from './tool-args.js';

/** A stable serialization of all configuration that can affect an approved structure change. */
export type StructureFingerprint = string;

export function isPetItemWithheld(item: {
  settings?: Pick<Item['settings'], 'withholdFromPets'>;
}): boolean {
  return item.settings?.withholdFromPets === true;
}

export function requirePetItem(item: Pick<Item, 'settings'>): void {
  if (isPetItemWithheld(item)) throw new WorkspaceToolRefusal('This item is unavailable to pets.');
}

/** An opaque result is usable only when Core can confirm that the workspace is unprotected. */
export async function canReadOpaqueWorkspaceData(
  ports: CompanionPorts,
  workspaceId: string,
  signal: AbortSignal,
): Promise<boolean> {
  try {
    const status = await ports.core.query(items.getWorkspacePetProtection(workspaceId), {
      signal,
      forceRefresh: true,
    });
    return !status.hasProtectedItems;
  } catch {
    signal.throwIfAborted();
    return false;
  }
}

/** Search, view and calendar rows can carry content without exposing the current item settings. */
export async function petSourceIds(
  ports: CompanionPorts,
  workspaceId: string,
  ids: readonly (string | null)[],
  signal: AbortSignal,
): Promise<Set<string>> {
  const distinct = [
    ...new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0)),
  ];
  const allowed = new Set<string>();
  for (let offset = 0; offset < distinct.length; offset += 8) {
    await Promise.allSettled(
      distinct.slice(offset, offset + 8).map(async (id) => {
        const item = await checkItem(ports, workspaceId, id, signal);
        if (item.id === id) allowed.add(id);
      }),
    );
    signal.throwIfAborted();
  }
  return allowed;
}

/** Reads an item and refuses it outside this workspace. Scope guards supplement, never
 * replace, permission checks in Core and collab. */
export async function checkItem(
  ports: CompanionPorts,
  workspaceId: string,
  id: string,
  signal: AbortSignal,
): Promise<Item> {
  const item = await itemInWorkspace(ports, workspaceId, id, signal);
  requirePetItem(item);
  return item;
}

/** Internal ancestry checks may inspect identifiers on withheld rows without showing them to pets. */
export async function itemInWorkspace(
  ports: CompanionPorts,
  workspaceId: string,
  id: string,
  signal: AbortSignal,
): Promise<Item> {
  if (!id) throw new Error('An item identity is required.');
  const item = await ports.core.query(items.itemById(id), { signal, forceRefresh: true });
  if (item.workspaceId !== workspaceId)
    throw new WorkspaceToolRefusal('The item is outside this workspace. No action was run.');
  return item;
}

/** Fingerprints a structure so `run.ts` can refuse a write whose preview no longer matches what
 * it would execute against (architecture 1.2's fingerprint fence). */
export function structureFingerprint(
  schema: {
    declared: readonly StructureProperty[];
    effective?: readonly StructureProperty[];
    inherit?: boolean;
    defaultViewId?: string;
    hideDocument?: boolean;
    version?: string;
  },
  views: readonly StructureView[],
): StructureFingerprint {
  const stable = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stable);
    if (value !== null && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, entry]) => [key, stable(entry)]),
      );
    return value;
  };
  return JSON.stringify(stable({ schema, views }));
}

/** Item kinds whose body is prose these tools can read and edit: notes, and artifacts, which
 * keep their program in a note-shaped body. */
export function hasProseBody(type: string): boolean {
  return type === 'note' || type === 'artifact';
}
