import { createNixClient, NixApiError, type NixClient } from '@nix/api-client';
import { createContext, use, useEffect, useMemo, type ReactNode } from 'react';

import { useAuth } from '../auth/auth-provider';
import { useSessionStore } from '@nix/web-foundation/lib/session-store';
import { bodyCacheAccountEpoch } from '@nix/web-foundation/lib/body-cache';
import { connectCacheInvalidationChannel } from './cache-invalidation-channel';

const ApiClientContext = createContext<NixClient | null>(null);

export function useApiClient(): NixClient {
  const client = use(ApiClientContext);
  if (client === null) {
    throw new Error('useApiClient was called outside ApiClientProvider.');
  }
  return client;
}

/**
 * The current client, or null when there is none.
 *
 * A control that can *sometimes* reach Core - an image property's upload capability, say - calls
 * this instead of {@link useApiClient}, so a render with no provider above it (most component
 * tests render a leaf directly, without the app's own provider tree) can turn that capability off
 * rather than throw.
 */
export function useOptionalApiClient(): NixClient | null {
  return use(ApiClientContext);
}

export function ApiClientProvider({ children }: { readonly children: ReactNode }): ReactNode {
  const { getAccessToken, handleSessionRefusal } = useAuth();
  const subject = useSessionStore((state) => state.profile?.subject);
  const client = useMemo(
    () =>
      createNixClient({
        baseUrl: globalThis.location.origin,
        tokens: {
          getAccessToken: async () => {
            const token = await getAccessToken();
            if (
              subject !== undefined &&
              (token === null || useSessionStore.getState().profile?.subject !== subject)
            )
              throw NixApiError.network(new Error('The browser session is unavailable.'));
            return token;
          },
          // Core renews only its own short-lived bearer token from the HttpOnly browser session;
          // provider tokens never enter this client or JavaScript at all.
          refreshAccessToken: async () => {
            const profile = useSessionStore.getState().profile;
            const epoch = subject === undefined ? null : bodyCacheAccountEpoch(subject);
            const token = await getAccessToken(true);
            const session = useSessionStore.getState();
            if (
              subject !== undefined &&
              (session.profile?.subject !== subject ||
                bodyCacheAccountEpoch(subject) !== epoch ||
                (token === null &&
                  (session.profile !== profile || session.status !== 'authenticated')))
            )
              throw NixApiError.network(new Error('The browser session is unavailable.'));
            return token;
          },
        },
        telemetry: {
          onRequestError: (event) => {
            if (
              subject !== undefined &&
              (event.status === 401 || event.code === 'auth.principal_inactive')
            )
              handleSessionRefusal(subject);
          },
        },
      }),
    [getAccessToken, handleSessionRefusal, subject],
  );

  useEffect(() => {
    if (subject === undefined) return;
    const epoch = bodyCacheAccountEpoch(subject);
    if (epoch === null) return;
    return connectCacheInvalidationChannel(
      client,
      subject,
      epoch,
      () =>
        useSessionStore.getState().profile?.subject === subject &&
        bodyCacheAccountEpoch(subject) === epoch,
    );
  }, [client, subject]);

  return <ApiClientContext value={client}>{children}</ApiClientContext>;
}

/** Supplies a deterministic client to isolated component stories and interaction tests. */
export function ApiClientOverrideProvider({
  client,
  children,
}: {
  readonly client: NixClient;
  readonly children: ReactNode;
}): ReactNode {
  return <ApiClientContext value={client}>{children}</ApiClientContext>;
}
