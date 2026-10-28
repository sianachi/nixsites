import { z } from 'zod';

/** Loaded descendants become unavailable with their deleted parent. */
export function itemSubtreeIds(
  items: readonly { readonly id: string; readonly parentId: string | null }[],
  roots: readonly string[],
): Set<string> {
  const children = new Map<string, string[]>();
  for (const item of items) {
    if (item.parentId === null) continue;
    const siblings = children.get(item.parentId) ?? [];
    siblings.push(item.id);
    children.set(item.parentId, siblings);
  }
  const removed = new Set(roots);
  const pending = [...removed];
  for (const parentId of pending) {
    for (const id of children.get(parentId) ?? []) {
      if (removed.has(id)) continue;
      removed.add(id);
      pending.push(id);
    }
  }
  return removed;
}

const eventName = 'nix:item-children-changed';
const detailSchema = z.object({
  workspaceId: z.string(),
  parentId: z.string().nullable(),
  removedItemIds: z.array(z.string()).default([]),
  restoredItemIds: z.array(z.string()).default([]),
});
const pending = new Map<
  string,
  {
    parentId: string | null;
    quiet: ReturnType<typeof setTimeout>;
    deadline: ReturnType<typeof setTimeout>;
  }
>();
let subscribers = 0;

export function cancelItemChildrenRefresh(workspaceId: string): void {
  const entry = pending.get(workspaceId);
  if (entry === undefined) return;
  clearTimeout(entry.quiet);
  clearTimeout(entry.deadline);
  pending.delete(workspaceId);
}
/** A null parent requests a workspace-wide refresh after a multi-container change. */
export function notifyItemChildrenChanged(
  workspaceId: string,
  parentId: string | null,
  change: {
    readonly removedItemIds?: readonly string[];
    readonly restoredItemIds?: readonly string[];
  } = {},
): void {
  if (subscribers === 0) return;
  if ((change.removedItemIds?.length ?? 0) === 0 && (change.restoredItemIds?.length ?? 0) === 0) {
    const previous = pending.get(workspaceId);
    const nextParent = previous === undefined || previous.parentId === parentId ? parentId : null;
    const flush = (): void => {
      const entry = pending.get(workspaceId);
      if (entry === undefined) return;
      clearTimeout(entry.quiet);
      clearTimeout(entry.deadline);
      pending.delete(workspaceId);
      window.dispatchEvent(
        new CustomEvent(eventName, { detail: { workspaceId, parentId: entry.parentId } }),
      );
    };
    if (previous !== undefined) clearTimeout(previous.quiet);
    pending.set(workspaceId, {
      parentId: nextParent,
      quiet: setTimeout(flush, 150),
      deadline: previous?.deadline ?? setTimeout(flush, 1_000),
    });
    return;
  }
  cancelItemChildrenRefresh(workspaceId);
  window.dispatchEvent(
    new CustomEvent(eventName, { detail: { workspaceId, parentId, ...change } }),
  );
}
export function onItemChildrenChanged(
  listener: (detail: z.infer<typeof detailSchema>) => void,
): () => void {
  const receive = (event: Event): void => {
    if (!(event instanceof CustomEvent)) return;
    const parsed = detailSchema.safeParse(event.detail);
    if (parsed.success) listener(parsed.data);
  };
  subscribers += 1;
  window.addEventListener(eventName, receive);
  return () => {
    window.removeEventListener(eventName, receive);
    subscribers -= 1;
    if (subscribers === 0)
      for (const workspaceId of pending.keys()) cancelItemChildrenRefresh(workspaceId);
  };
}
