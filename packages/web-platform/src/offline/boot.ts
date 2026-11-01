import type { StoredSession } from './native-mirror';

/** How a session check failed: no usable answer, or an answer that closed the session. */
export type SessionFailure = 'unreachable' | 'refused';

/**
 * Whether the iOS shell may open on its synced copy. Only when Core gave no usable answer and this
 * device holds the profile it last signed in with. A 401, a refusal or a changed account never
 * does: those close admission instead.
 */
export function canBootOffline(failure: SessionFailure, stored: StoredSession | null): boolean {
  return failure === 'unreachable' && stored !== null;
}
