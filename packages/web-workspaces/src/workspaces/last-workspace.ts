import { writeStored } from '@nix/web-foundation/lib/stored-setting';
import { browserStorage } from '@nix/web-foundation/lib/browser-storage';

const LAST_WORKSPACE_KEY = 'nix.last-workspace-id';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function readLastWorkspaceId(): string | null {
  try {
    const value = browserStorage()?.getItem(LAST_WORKSPACE_KEY) ?? null;
    return value !== null && UUID.test(value) ? value : null;
  } catch {
    return null;
  }
}

const RECENT_KEY = 'nix.recent-workspace-ids';

/** Workspace ids, most recently opened first. */
export function readRecentWorkspaceIds(): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(browserStorage()?.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === 'string' && UUID.test(id))
      : [];
  } catch {
    return [];
  }
}

export function rememberLastWorkspaceId(workspaceId: string): void {
  // Workspace selection still works when browser persistence is unavailable.
  writeStored(LAST_WORKSPACE_KEY, workspaceId);
  const recent = [workspaceId, ...readRecentWorkspaceIds().filter((id) => id !== workspaceId)];
  writeStored(RECENT_KEY, JSON.stringify(recent.slice(0, 20)));
}
