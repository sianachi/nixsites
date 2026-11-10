import type { WorkspaceClosedReason } from './workspace-unlock-screen';

/**
 * Why a workspace that was open here closed. Said by whoever closes it (the relock button, the
 * expiry timer) and read by the screen that replaces the workspace, which is rendered a moment
 * later by a different component. Held in memory only: it is a courtesy in words, never a fact
 * Core relies on, and a reload forgets it.
 */
const reasons = new Map<string, WorkspaceClosedReason>();

export function rememberClosedReason(workspaceId: string, reason: WorkspaceClosedReason): void {
  reasons.set(workspaceId, reason);
}

export function closedReason(workspaceId: string): WorkspaceClosedReason | null {
  return reasons.get(workspaceId) ?? null;
}

export function forgetClosedReason(workspaceId: string): void {
  reasons.delete(workspaceId);
}
