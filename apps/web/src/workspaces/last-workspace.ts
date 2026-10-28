import { writeStored } from '../editor/stored-setting';
import { browserStorage } from '../lib/browser-storage';

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

export function rememberLastWorkspaceId(workspaceId: string): void {
  // Workspace selection still works when browser persistence is unavailable.
  writeStored(LAST_WORKSPACE_KEY, workspaceId);
}
