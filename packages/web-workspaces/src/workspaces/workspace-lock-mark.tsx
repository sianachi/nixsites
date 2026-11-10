import type { Workspace } from '@nix/api-client';
import { Icon } from '@nix/ui';
import { Lock, LockOpen } from 'lucide-react';
import type { ReactNode } from 'react';

/**
 * Whether a password closes this workspace to the current session: it has one, and no unlock is
 * running. The clock counts as well as the list, so an unlock that ran out reads as closed even
 * before the list is read again.
 */
export function workspaceClosed(
  workspace: Pick<Workspace, 'passwordProtected' | 'unlockedUntil'>,
  now: number = Date.now(),
): boolean {
  if (!workspace.passwordProtected) return false;
  const until = workspace.unlockedUntil;
  return until === null || until === undefined || Date.parse(until) <= now;
}

/**
 * A small lock beside a workspace's name wherever workspaces are listed: shut while a password
 * closes it, open while this session has it unlocked. It carries its state in words for assistive
 * technology, so the name it sits beside stays a plain name.
 */
export function WorkspaceLockMark({
  workspace,
}: {
  readonly workspace: Pick<Workspace, 'passwordProtected' | 'unlockedUntil'>;
}): ReactNode {
  if (!workspace.passwordProtected) return null;
  const closed = workspaceClosed(workspace);
  return (
    <span className="inline-flex shrink-0 items-center text-muted">
      <Icon icon={closed ? Lock : LockOpen} size="sm" />
      <span className="sr-only">{closed ? ' (locked)' : ' (password protected, unlocked)'}</span>
    </span>
  );
}
