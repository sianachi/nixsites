import { inNativeShell } from '../pwa/install-nix';

/**
 * Signing out with no network wipes the synced copy but cannot end the server session, so its
 * cookie would sign the person straight back in at the next online launch. This marker records
 * that the server still owes a logout. It holds no secret, only that fact.
 */
// Not under `nix.offline`: sign-out clears that prefix, and this has to outlive it.
const KEY = 'nix.logout-pending';

const storage = (): Storage | null => {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
};

/** Set before the wipe, so a crash between the wipe and the logout still leaves it. Shell only. */
export function markLogoutPending(): boolean {
  if (!inNativeShell) return false;
  try {
    storage()?.setItem(KEY, '1');
    return true;
  } catch {
    return false;
  }
}

export function isLogoutPending(): boolean {
  try {
    return storage()?.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export function clearLogoutPending(): void {
  try {
    storage()?.removeItem(KEY);
  } catch {
    /* Nothing to clear. */
  }
}

/**
 * Ends the server session if a sign-out is still owed. True when nothing is owed or the logout
 * went through (any answer below 500); false when the server could not be reached, in which case
 * no session may be treated as signed in yet.
 */
export async function completePendingLogout(): Promise<boolean> {
  if (!isLogoutPending()) return true;
  try {
    const response = await fetch('/auth/logout', {
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
    if (response.status >= 500) return false;
  } catch {
    return false;
  }
  clearLogoutPending();
  return true;
}
