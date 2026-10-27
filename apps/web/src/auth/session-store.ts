import { create } from 'zustand';

/**
 * Who is signed in, and where the sign-in process has got to.
 *
 * A Zustand slice rather than context, so a component subscribes to the one field it renders and a
 * token refresh does not re-render the whole application. Actions are named as events - what
 * happened - rather than as setters, which is what keeps the reducer readable when a fourth state
 * arrives.
 *
 * **The access token is deliberately not in this store.** Provider tokens never reach the browser;
 * a short-lived Core token lives only in AuthProvider's in-memory ref. Putting it here would put it
 * in devtools and state snapshots, neither of which needs it.
 */

export type SessionStatus =
  /** Nothing has been attempted yet; Core may still restore its HttpOnly session. */
  | 'unknown'
  /** Session restoration or the login redirect is in flight. */
  | 'authenticating'
  /** Signed in. */
  | 'authenticated'
  /** Signed out, or never signed in. */
  | 'anonymous'
  /** Sign-in was attempted and failed. `error` says why. */
  | 'failed'
  /**
   * Core could not be reached at all - the device is offline, or the server is not answering. Not
   * a sign-in failure. Restoration is retried.
   */
  | 'unreachable';

/** Why Core could not be reached, as far as the browser can tell. */
export interface Unreachable {
  /** `offline` when the device reports no network; `server` when it has one and Core is silent. */
  readonly cause: 'offline' | 'server';
  readonly lastTriedAt: number;
}

export interface SessionProfile {
  /** The issuer's stable subject claim. Not an email - people change those. */
  readonly subject: string;
  readonly name: string;
  readonly email: string | null;
}

export interface SessionState {
  readonly status: SessionStatus;
  readonly profile: SessionProfile | null;
  readonly error: string | null;
  /** Bumped to ask the provider for another restore attempt after `unreachable`. */
  readonly restoreAttempt: number;
  /**
   * The last unreachable answer, kept while a retry is in flight so the offline screen stays up
   * and says it is trying, rather than flashing the restoring screen and back.
   */
  readonly unreachable: Unreachable | null;

  /** A sign-in or session restore has started. */
  readonly signInStarted: () => void;
  /** An in-flight startup restore was abandoned because its provider unmounted. */
  readonly sessionRestoreCancelled: () => void;
  /** The identity provider returned a user. */
  readonly signInSucceeded: (profile: SessionProfile) => void;
  /** Sign-in failed, or a renew failed and the session is gone. */
  readonly signInFailed: (message: string) => void;
  /** The session restore could not reach Core at all. */
  readonly sessionUnreachable: (
    cause: Unreachable['cause'],
    cachedProfile?: SessionProfile | null,
  ) => void;
  /** Ask for the session to be restored again, after the network returns. */
  readonly sessionRetryRequested: () => void;
  /**
   * The session ended, deliberately or otherwise. `reason` is set only when the ending itself
   * needs explaining - a session that expired underneath the person - and left unset for a
   * deliberate sign-out, which needs no excuse.
   */
  readonly signedOut: (reason?: string) => void;
}

export const useSessionStore = create<SessionState>((set) => ({
  status: 'unknown',
  profile: null,
  error: null,
  restoreAttempt: 0,
  unreachable: null,

  signInStarted: () => {
    set({ status: 'authenticating', error: null });
  },

  sessionRestoreCancelled: () => {
    set((state) =>
      state.status === 'authenticating'
        ? {
            status: 'unknown',
            profile: state.unreachable === null ? null : state.profile,
            error: null,
          }
        : state,
    );
  },

  signInSucceeded: (profile) => {
    set({ status: 'authenticated', profile, error: null, unreachable: null });
  },

  signInFailed: (message) => {
    // The profile is cleared as well as the status set: a half-signed-in state where a stale name
    // is still rendered next to a failure is exactly the kind of dishonest view to avoid.
    set({ status: 'failed', profile: null, error: message, unreachable: null });
  },

  sessionUnreachable: (cause, cachedProfile) => {
    set((state) => ({
      status: 'unreachable',
      profile: cachedProfile === undefined ? state.profile : cachedProfile,
      error: null,
      unreachable: { cause, lastTriedAt: Date.now() },
    }));
  },

  sessionRetryRequested: () => {
    set((state) =>
      state.status === 'unreachable'
        ? { status: 'unknown', restoreAttempt: state.restoreAttempt + 1 }
        : state,
    );
  },

  signedOut: (reason) => {
    set({ status: 'anonymous', profile: null, error: reason ?? null, unreachable: null });
  },
}));

/** Selector: whether the application should render its authenticated shell. */
export const selectIsAuthenticated = (state: SessionState): boolean =>
  state.status === 'authenticated';

/** Selector: whether a sign-in is in flight, for disabling the button that started it. */
export const selectIsBusy = (state: SessionState): boolean =>
  state.status === 'authenticating' || state.status === 'unknown';
