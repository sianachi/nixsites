import { useAuth } from './auth-provider';

export type AuthMode = 'local' | 'oidc';

/** The install's sign-in mode, or null when it is not known (treat null as "not local"). */
export function useAuthMode(): AuthMode | null {
  try {
    return (useAuth() as { mode?: AuthMode }).mode ?? null;
  } catch {
    // A page rendered on its own, outside the auth provider.
    return null;
  }
}
