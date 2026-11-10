/**
 * Whether a workspace password has closed the workspace to this session, judged from a workspace
 * list entry. A closed workspace is still the person's - it stays in the mirror with every
 * unsynced edit - but Core answers its sync routes with 423 until it is unlocked, and the device
 * shows nothing of it. Judged by the clock as well, so an unlock that ran out is not trusted just
 * because the last list said it was open.
 */
export function closedByPassword(workspace: {
  passwordProtected?: boolean | null;
  unlockedUntil?: string | null;
}): boolean {
  if (workspace.passwordProtected !== true) return false;
  return workspace.unlockedUntil == null || Date.parse(workspace.unlockedUntil) <= Date.now();
}
