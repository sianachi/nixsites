import { stop as stopAudio } from '../audio/audio-store';
import { clearAudioPositions } from '../lib/audio-positions';
import { forgetThumbnails } from '../lib/thumbnail-cache';
import { clearPendingDailyTemplate } from '../lib/pending-daily-template';
import { clearPetDrafts } from '../pets/pet-drafts';
import {
  bodyCacheAccountEpoch,
  bodyCacheCleanupCurrent,
  clearBodyCache,
  openBodyCache,
  sealAccountBodies,
} from '../editor/body-cache';
import { clearFrecency } from '../lib/frecency';
import { clearSuggestionDismissals } from '../lib/suggestion-dismissals';
import { clearDrafts } from '../editor/draft-journal';
import { clearInterruptedImport } from '../import/import-interrupted-notice';
import {
  createContext,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { z } from 'zod';

import { browserStorage } from '../lib/browser-storage';
import { getServiceWorkerRegistration } from '../pwa/register-service-worker';
import { useSessionStore, type SessionProfile } from './session-store';

/**
 * Unsubscribes this device from push and tells Core to forget the subscription, before the
 * session that registered it ends. A shared browser must not keep delivering the outgoing
 * account's reminders to whoever uses it next.
 *
 * Entirely best-effort: every failure is swallowed and nothing here ever blocks or fails
 * sign-out. This runs ahead of `/auth/logout` (and therefore ahead of `accessTokenRef` being
 * cleared) specifically so the DELETE still carries a valid bearer token - `AuthProvider` sits
 * outside `ApiClientProvider` in `app.tsx` and has no `NixClient` of its own to reach for.
 */
async function unsubscribePushBeforeSignOut(accessToken: string | null): Promise<void> {
  try {
    const registration = getServiceWorkerRegistration();
    if (!registration) return;
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) return;
    const endpoint = subscription.endpoint;
    await subscription.unsubscribe().catch(() => undefined);
    await fetch('/api/v1/me/push-subscriptions', {
      method: 'DELETE',
      credentials: 'include',
      cache: 'no-store',
      headers: {
        'Content-Type': 'application/json',
        ...(accessToken === null ? {} : { Authorization: `Bearer ${accessToken}` }),
      },
      body: JSON.stringify({ endpoint }),
    });
  } catch {
    // Best-effort: sign-out proceeds either way. A subscription left behind here is still
    // useless to deliver to, since the account it was registered for is about to be signed out.
  }
}

/**
 * Browser authentication is mediated by Core. Zitadel tokens never enter JavaScript: Core keeps
 * the provider exchange server-side, gives the browser an opaque HttpOnly session cookie, and
 * returns only a short-lived Core JWT for the existing API and collaboration bearer boundaries.
 */

export interface AuthContextValue {
  /** Starts the server-owned authorization-code redirect. */
  readonly signIn: () => Promise<void>;
  /** Revokes the local browser session and clears its cookie. */
  readonly signOut: () => Promise<void>;
  /** Returns a current short-lived Core access token without exposing the session cookie. */
  readonly getAccessToken: (forceRefresh?: boolean) => Promise<string | null>;
  /** Closes local account access after an authoritative global session refusal. */
  readonly handleSessionRefusal: (subject: string) => void;
  /** Whether Core has the interactive provider and its signing key configured. */
  readonly isConfigured: boolean;
  /**
   * The identity provider's self-service page - password, passkeys, second factors - or null when
   * the deployment names none. Nix never handles credentials; it only points at where they live.
   */
  readonly accountUrl: string | null;
}

const browserProfileSchema = z.object({
  subject: z.string().min(1),
  name: z.string().min(1),
});

const browserSessionSchema = z.object({
  authenticated: z.boolean(),
  configured: z.boolean(),
  profile: browserProfileSchema.nullable(),
  accessToken: z.string().min(1).nullable(),
  expiresAt: z.iso.datetime({ offset: true }).nullable(),
  // Rendered as a link, so only a web address is kept: a javascript: URL from a misconfigured
  // deployment is dropped rather than becoming a click, without costing the sign-in itself.
  accountUrl: z
    .url({ protocol: /^https?$/ })
    .nullish()
    .catch(null),
});

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const value = use(AuthContext);
  if (value === null) {
    throw new Error('useAuth was called outside AuthProvider.');
  }

  return value;
}

/** Supplies a fixed session to the server-free demo, which mounts the app without a sign-in. */
export function AuthOverrideProvider({
  value,
  children,
}: {
  readonly value: AuthContextValue;
  readonly children: ReactNode;
}): ReactNode {
  return <AuthContext value={value}>{children}</AuthContext>;
}

export interface AuthProviderProps {
  readonly children: ReactNode;
}

interface AccessTokenState {
  readonly value: string;
  readonly expiresAt: number;
}

/** Session access is unavailable because transport failed or Core could not serve the request. */
class CoreUnreachable extends Error {
  constructor(readonly reason: 'offline' | 'server') {
    super(reason === 'offline' ? 'This device is offline.' : 'The Nix server is not answering.');
  }
}

/** Whether a request that got no answer at all did so for want of a network on this device. */
function networkCause(): 'offline' | 'server' {
  return typeof navigator !== 'undefined' && !navigator.onLine ? 'offline' : 'server';
}

/** How long to wait before each automatic retry while Core is unreachable. */
const RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000] as const;

function toProfile(profile: z.infer<typeof browserProfileSchema>): SessionProfile {
  return { subject: profile.subject, name: profile.name, email: null };
}

async function readJson(response: Response): Promise<unknown> {
  const mediaType = response.headers.get('content-type')?.split(';', 1)[0]?.trim();
  if (mediaType !== 'application/json') {
    throw new Error('Core returned an unexpected browser-session response.');
  }

  return response.json();
}

// Old tabs keep this database open, so clear its private chunks without a blocked deletion.
async function clearRetiredRecordings(): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('nix-recordings');
    request.onerror = () => {
      reject(new Error('Recording storage could not be opened.', { cause: request.error }));
    };
    request.onblocked = () => {
      reject(new Error('Recording storage is blocked.'));
    };
    request.onsuccess = () => {
      const db = request.result;
      const stores = ['sessions', 'chunks'].filter((name) => db.objectStoreNames.contains(name));
      if (stores.length === 0) {
        db.close();
        resolve();
        return;
      }
      try {
        const transaction = db.transaction(stores, 'readwrite');
        transaction.oncomplete = () => {
          db.close();
          resolve();
        };
        transaction.onabort = transaction.onerror = () => {
          db.close();
          reject(
            new Error('Recording storage could not be cleared.', { cause: transaction.error }),
          );
        };
        for (const name of stores) transaction.objectStore(name).clear();
      } catch (error) {
        db.close();
        reject(
          error instanceof Error
            ? error
            : new Error('Recording storage could not be cleared.', { cause: error }),
        );
      }
    };
  });
}

// Downloaded notes from the retired offline mode: deleted, not cleared, since no tab opens them now.
function clearRetiredOfflineNotes(): void {
  if (typeof indexedDB !== 'undefined')
    for (const name of ['nix-offline-notes', 'nix-offline-note-assets'])
      indexedDB.deleteDatabase(name);
  try {
    const storage = browserStorage();
    for (const key of Object.keys(storage ?? {}))
      if (key.startsWith('nix.offline')) storage?.removeItem(key);
  } catch {
    /* Storage that cannot be read holds nothing to remove. */
  }
}

export function AuthProvider({ children }: AuthProviderProps): ReactNode {
  // True until Core answers so the login screen never flashes a false configuration warning while
  // the session gate is still restoring. The response is authoritative before the gate settles.
  const [configured, setConfigured] = useState(true);
  const [accountUrl, setAccountUrl] = useState<string | null>(null);
  const accessTokenRef = useRef<AccessTokenState | null>(null);
  const refreshRef = useRef<Promise<string | null> | null>(null);
  const signingOutRef = useRef(false);
  const sessionGeneration = useRef(0);
  const restoreController = useRef<AbortController | null>(null);
  const invalidateSessionRequests = useCallback((): void => {
    sessionGeneration.current += 1;
    restoreController.current?.abort();
    refreshRef.current = null;
  }, []);

  const signInStarted = useSessionStore((state) => state.signInStarted);
  const sessionRestoreCancelled = useSessionStore((state) => state.sessionRestoreCancelled);
  const signInSucceeded = useSessionStore((state) => state.signInSucceeded);
  const signInFailed = useSessionStore((state) => state.signInFailed);
  const signedOut = useSessionStore((state) => state.signedOut);
  const sessionUnreachable = useSessionStore((state) => state.sessionUnreachable);
  const sessionRetryRequested = useSessionStore((state) => state.sessionRetryRequested);
  const restoreAttempt = useSessionStore((state) => state.restoreAttempt);
  const closeSession = useCallback(
    (subject: string, reason: string): void => {
      if (useSessionStore.getState().profile?.subject !== subject) return;
      invalidateSessionRequests();
      accessTokenRef.current = null;
      void sealAccountBodies(subject).catch(() => undefined);
      signedOut(reason);
    },
    [invalidateSessionRequests, signedOut],
  );

  useEffect(() => {
    // A remounted provider must not replace a definitive in-memory state with a second restore.
    // The application starts at `unknown`, while tests and an explicit sign-out may already have
    // established an authenticated, anonymous, or failed state before this effect runs.
    if (useSessionStore.getState().status !== 'unknown') {
      return;
    }

    const controller = new AbortController();
    restoreController.current = controller;
    const generation = sessionGeneration.current;
    const isAborted = (): boolean =>
      controller.signal.aborted || generation !== sessionGeneration.current;
    let settled = false;
    signInStarted();

    void fetch('/auth/session', {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    })
      // Classified here, at the one call that can fail for want of a network, rather than by
      // error type below: a TypeError from a bug later in this chain is a failure to report, not
      // an outage to wait out.
      .catch((cause: unknown) => {
        throw controller.signal.aborted ? cause : new CoreUnreachable(networkCause());
      })
      .then(async (response) => {
        if (isAborted()) return null;
        // Unavailable or rate-limited session responses cannot establish an account refusal.
        if (!response.ok && response.status !== 401 && response.status !== 403) {
          throw new CoreUnreachable('server');
        }
        if (!response.ok) {
          throw new Error('Core could not restore the browser session.');
        }

        return browserSessionSchema.parse(await readJson(response));
      })
      .then(async (session) => {
        if (session === null || isAborted()) {
          return;
        }

        settled = true;
        setConfigured(session.configured);
        setAccountUrl(session.accountUrl ?? null);
        if (
          session.authenticated &&
          session.profile !== null &&
          session.accessToken !== null &&
          session.expiresAt !== null
        ) {
          accessTokenRef.current = {
            value: session.accessToken,
            expiresAt: Date.parse(session.expiresAt),
          };
          const profile = toProfile(session.profile);
          // Opened before the workspace can mount an editor: a different person than the store
          // last belonged to clears it first. A store that cannot be opened stays closed, which
          // costs only the instant first paint.
          const opening = openBodyCache(profile.subject, { reauthorized: true });
          const openedEpoch = bodyCacheAccountEpoch(profile.subject);
          await opening.catch(() => undefined);
          if (isAborted()) return;
          if (bodyCacheAccountEpoch(profile.subject) !== openedEpoch) {
            signInFailed('The account changed in another tab. Reload to restore its session.');
            return;
          }
          signInSucceeded(profile);
          return;
        }

        accessTokenRef.current = null;
        signedOut();
      })
      .catch((error: unknown) => {
        if (isAborted()) {
          return;
        }

        settled = true;
        accessTokenRef.current = null;
        if (error instanceof CoreUnreachable) {
          sessionUnreachable(error.reason, null);
          return;
        }
        signInFailed(error instanceof Error ? error.message : 'Session could not be restored.');
      });

    return () => {
      controller.abort();
      if (restoreController.current === controller) restoreController.current = null;
      if (!settled) {
        sessionRestoreCancelled();
      }
    };
  }, [
    restoreAttempt,
    sessionRestoreCancelled,
    sessionUnreachable,
    signInFailed,
    signInStarted,
    signInSucceeded,
    signedOut,
  ]);

  // While Core is unreachable: try again the moment the device reports a network, and on a
  // lengthening timer regardless - a server that is down comes back without the device's network
  // ever changing, so waiting for `online` alone would wait forever.
  const status = useSessionStore((state) => state.status);
  useEffect(() => {
    if (status !== 'unreachable') return;
    const delay = RETRY_DELAYS_MS[Math.min(restoreAttempt, RETRY_DELAYS_MS.length - 1)];
    const timer = setTimeout(sessionRetryRequested, delay);
    window.addEventListener('online', sessionRetryRequested);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('online', sessionRetryRequested);
    };
  }, [restoreAttempt, sessionRetryRequested, status]);

  useEffect(() => {
    const clearSession = (event: Event): void => {
      const detail =
        event instanceof CustomEvent
          ? z
              .object({ subject: z.string().optional(), epoch: z.string().nullable().optional() })
              .safeParse(event.detail)
          : null;
      const notice = detail?.success ? detail.data : undefined;
      const subject = notice?.subject ?? useSessionStore.getState().profile?.subject;
      const epoch =
        notice?.epoch ?? (subject === undefined ? null : bodyCacheAccountEpoch(subject));
      if (
        notice?.subject !== undefined &&
        (useSessionStore.getState().profile?.subject !== notice.subject ||
          !bodyCacheCleanupCurrent(notice.subject, notice.epoch ?? null))
      )
        return;
      invalidateSessionRequests();
      accessTokenRef.current = null;
      refreshRef.current = null;
      signedOut();
      // Shared localStorage, already cleared by the signing-out tab; clearing again also drops
      // this tab's in-memory frecency cache.
      clearFrecency();
      clearSuggestionDismissals();
      stopAudio();
      clearAudioPositions();
      clearPetDrafts();
      clearPendingDailyTemplate();
      void forgetThumbnails();
      // The signing-out tab already cleared the shared store; clearing here as well stops this
      // tab's editors from writing a copy back after it did.
      if (typeof indexedDB !== 'undefined')
        void clearBodyCache(subject, epoch).catch(() => undefined);
      void clearRetiredRecordings().catch(() => undefined);
      clearRetiredOfflineNotes();
    };
    window.addEventListener('nix:signed-out-elsewhere', clearSession);
    return () => {
      window.removeEventListener('nix:signed-out-elsewhere', clearSession);
    };
  }, [invalidateSessionRequests, signedOut]);

  // ApiClientProvider retains these functions until account identity changes. They read refs so
  // renewing the same person's token does not recreate their client or its subscriptions.
  const value = useMemo<AuthContextValue>(
    () => ({
      isConfigured: configured,
      accountUrl,

      signIn: () => {
        if (!configured) {
          signInFailed('Interactive sign-in is not configured on this Nix server.');
          return Promise.resolve();
        }

        signInStarted();
        const returnTo = `${globalThis.location.pathname}${globalThis.location.search}${globalThis.location.hash}`;
        globalThis.location.assign(`/auth/login?returnTo=${encodeURIComponent(returnTo)}`);
        return Promise.resolve();
      },

      signOut: async () => {
        const subject = useSessionStore.getState().profile?.subject;
        const epoch = subject === undefined ? null : bodyCacheAccountEpoch(subject);
        signingOutRef.current = true;
        const pushToken = accessTokenRef.current?.value ?? null;
        invalidateSessionRequests();
        accessTokenRef.current = null;
        const localClearing =
          typeof indexedDB === 'undefined'
            ? Promise.resolve(true)
            : Promise.all([
                clearBodyCache(subject, epoch),
                clearDrafts(subject, epoch),
                clearRetiredRecordings(),
              ]).then(
                () => true,
                () => false,
              );
        clearRetiredOfflineNotes();
        clearInterruptedImport();
        clearFrecency();
        clearSuggestionDismissals();
        stopAudio();
        clearAudioPositions();
        clearPetDrafts();
        clearPendingDailyTemplate();
        await forgetThumbnails();
        await unsubscribePushBeforeSignOut(pushToken);
        const draftsCleared = await localClearing;
        try {
          await fetch('/auth/logout', {
            method: 'POST',
            credentials: 'include',
            cache: 'no-store',
            headers: { Accept: 'application/json' },
          });
        } finally {
          accessTokenRef.current = null;
          refreshRef.current = null;
          signedOut();
          signingOutRef.current = false;
          if (!draftsCleared)
            signInFailed(
              'Signed out. Local drafts, saved pages and recordings could not be cleared. Clear this site’s storage before sharing this device.',
            );
        }
      },

      handleSessionRefusal: (subject) => {
        closeSession(subject, 'Your session is no longer valid. Sign in again to continue.');
      },

      getAccessToken: async (forceRefresh = false) => {
        if (signingOutRef.current || useSessionStore.getState().status !== 'authenticated')
          return null;
        const generation = sessionGeneration.current;
        const profile = useSessionStore.getState().profile;
        const subject = profile?.subject;
        if (subject === undefined) return null;
        const epoch = bodyCacheAccountEpoch(subject);
        const hasCurrentSession = (): boolean =>
          generation === sessionGeneration.current &&
          !signingOutRef.current &&
          useSessionStore.getState().status === 'authenticated' &&
          useSessionStore.getState().profile?.subject === subject &&
          bodyCacheAccountEpoch(subject) === epoch;
        const renewalUnreachable = (cause: 'offline' | 'server'): void => {
          if (!hasCurrentSession() || useSessionStore.getState().profile !== profile) return;
          accessTokenRef.current = null;
          sessionUnreachable(cause, profile);
        };
        const current = accessTokenRef.current;
        if (!forceRefresh && current !== null && current.expiresAt - Date.now() > 30_000) {
          return current.value;
        }

        if (refreshRef.current !== null) {
          return refreshRef.current;
        }

        // Renew token and identity together: another tab may have changed the shared BFF cookie.
        const refresh = fetch('/auth/session', {
          method: 'GET',
          credentials: 'include',
          cache: 'no-store',
          headers: { Accept: 'application/json' },
        })
          .catch(() => {
            throw new CoreUnreachable(networkCause());
          })
          .then(async (response) => {
            if (!hasCurrentSession()) return null;
            if (response.status === 401 || response.status === 403) {
              closeSession(subject, 'Your session expired. Sign in again to continue.');
              return null;
            }

            if (!response.ok) {
              throw new CoreUnreachable('server');
            }

            const parsed = await readJson(response).then(
              (data) => browserSessionSchema.safeParse(data),
              () => null,
            );
            if (!hasCurrentSession()) return null;
            if (!parsed?.success) {
              closeSession(subject, 'Core returned an invalid session. Sign in again to continue.');
              return null;
            }
            const session = parsed.data;
            if (
              !session.authenticated ||
              session.profile === null ||
              session.accessToken === null ||
              session.expiresAt === null
            ) {
              closeSession(subject, 'Your session expired. Sign in again to continue.');
              return null;
            }
            if (session.profile.subject !== subject) {
              closeSession(
                subject,
                'The account changed in another tab. Sign in again to continue.',
              );
              return null;
            }
            accessTokenRef.current = {
              value: session.accessToken,
              expiresAt: Date.parse(session.expiresAt),
            };
            return session.accessToken;
          })
          .catch((cause: unknown) => {
            if (cause instanceof CoreUnreachable) renewalUnreachable(cause.reason);
            return null;
          })
          .finally(() => {
            if (refreshRef.current === refresh) refreshRef.current = null;
          });
        refreshRef.current = refresh;
        return refresh;
      },
    }),
    [
      accountUrl,
      configured,
      closeSession,
      invalidateSessionRequests,
      signInFailed,
      signInStarted,
      signedOut,
      sessionUnreachable,
    ],
  );

  return <AuthContext value={value}>{children}</AuthContext>;
}
