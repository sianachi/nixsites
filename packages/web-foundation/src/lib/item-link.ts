/**
 * The address that opens one item in its workspace - what "Copy link" puts on the clipboard, and
 * what anyone with access can paste to land on the same item. Access is still Core's to decide on
 * arrival; the link carries no capability of its own.
 */
export function itemLink(origin: string, workspaceId: string, itemId: string): string {
  return `${origin}/w/${encodeURIComponent(workspaceId)}?item=${encodeURIComponent(itemId)}`;
}

/** Copies an item's link, resolving whether the clipboard accepted it. */
export async function copyItemLink(workspaceId: string, itemId: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(itemLink(globalThis.location.origin, workspaceId, itemId));
    return true;
  } catch {
    return false;
  }
}
