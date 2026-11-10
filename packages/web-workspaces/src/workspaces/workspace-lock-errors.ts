import { isNixApiError } from '@nix/api-client';

/** What to tell somebody whose workspace-password request was refused, by the code Core returned. */
export function workspaceLockRefusal(cause: unknown, fallback: string): string {
  if (!isNixApiError(cause)) return fallback;
  switch (cause.code) {
    case 'workspaces.wrong_password':
      return 'That password is not right.';
    case 'workspaces.password_invalid':
      return 'Use a password of 8 to 256 characters.';
    case 'workspaces.password_exists':
      return 'This workspace already has a password. Enter the current one to change it.';
    case 'workspaces.password_not_set':
      return 'This workspace has no password.';
    case 'workspaces.credential_cannot_unlock':
      return 'This sign-in cannot unlock workspaces. Sign in through the browser and try again.';
    case 'workspaces.too_many_attempts':
      // Core says how long to wait; its wording is already for the person.
      return cause.detail ?? 'Too many wrong passwords. Try again later.';
    case 'workspaces.password_busy':
      return 'Passwords cannot be checked right now. Try again in a moment.';
    case 'workspaces.join_refused':
      return 'That link and password did not open a workspace. Check both with whoever shared it.';
    case 'workspaces.not_found':
      return 'You do not have permission to do that here.';
    case 'request.rate_limited':
      return 'Too many attempts. Wait a minute and try again.';
    default:
      return fallback;
  }
}

/** The address a person shares so others can join with the password. */
export function workspaceJoinUrl(workspaceId: string): string {
  return `${window.location.origin}/join/${workspaceId}`;
}
