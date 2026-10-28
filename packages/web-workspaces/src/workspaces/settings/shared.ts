import type { useWorkspace } from '../workspace-context';
import type { useWorkspaceAdministration } from '../use-workspace-administration';

export type AssignableRole = 'owner' | 'editor' | 'viewer';
export type Administration = ReturnType<typeof useWorkspaceAdministration>;
export type CurrentWorkspace = ReturnType<typeof useWorkspace>['workspace'];

export type Confirmation =
  | { readonly kind: 'remove'; readonly principalId: string; readonly name: string }
  | { readonly kind: 'leave' }
  | { readonly kind: 'archive' }
  | null;

export function invitationReason(reason: string | null): string {
  switch (reason) {
    case 'self':
      return 'You';
    case 'already_has_access':
      return 'Already has access';
    case 'invitation_pending':
      return 'Invitation pending';
    case 'email_missing':
      return 'No email address';
    case 'email_unverified':
      return 'Email not verified';
    default:
      return 'Cannot invite';
  }
}

export function formatBytes(value: number | string): string {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 1024) return `${String(value)} bytes`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let amount = bytes;
  let unit = 'bytes';
  for (const nextUnit of units) {
    amount /= 1024;
    unit = nextUnit;
    if (amount < 1024 || nextUnit === units[units.length - 1]) break;
  }
  return `${amount.toFixed(amount >= 10 ? 0 : 1)} ${unit}`;
}
