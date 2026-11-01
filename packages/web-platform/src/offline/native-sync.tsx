import { files, principal, workspaces } from '@nix/api-client';
import { createFetchMirrorApi } from '@nix/sync-core/fetch-api';
import { useSessionStore } from '@nix/web-foundation/lib/session-store';
import { injectBodyCache, indexedBodyCache } from '@nix/web-foundation/lib/body-cache';
import { useEffect, type ReactNode } from 'react';

import { useApiClient } from '../api/api-client-provider';
import { useAuth } from '../auth/auth-provider';
import { createMirrorBodyCache } from './mirror-body-cache';
import { REMEMBERED, rememberKey } from './mirror-fetch';
import { discardNativeMirror, getNativeMirror } from './native-mirror';
import { setOfflineState, useOfflineState } from './offline-state';
import { getShellFetch } from './shell-fetch';
import { createSyncScheduler, runFullSync } from './sync';

/**
 * Keeps the iOS shell's offline copy current. Renders nothing, and does nothing at all outside the
 * shell. Mounted under the API client, so every call here goes through the same session.
 */

/** The small boot reads (preferences, settings) are kept by the shell's fetch as they pass by. */
async function warmRemembered(getToken: () => Promise<string | null>): Promise<void> {
  const shellFetch = getShellFetch();
  const token = await getToken();
  if (shellFetch === undefined || token === null) return;
  await Promise.all(
    [...REMEMBERED].map((path) =>
      shellFetch(path, {
        headers: { authorization: `Bearer ${token}` },
        credentials: 'omit',
      }).catch(() => undefined),
    ),
  );
}

export function NativeSync(): ReactNode {
  const mirror = getNativeMirror();
  const client = useApiClient();
  const { getAccessToken } = useAuth();
  const profile = useSessionStore((state) => state.profile);
  const status = useSessionStore((state) => state.status);
  const { bootOffline } = useOfflineState();

  useEffect(() => {
    if (mirror === null || status !== 'authenticated' || profile === null) return;
    const controller = new AbortController();
    let stop = (): void => undefined;

    void (async () => {
      let store = mirror.current();
      if (!bootOffline) {
        const me = await client.query(principal.currentPrincipal(), { forceRefresh: true });
        store = await mirror.open({ tenantId: me.tenantId, principalId: me.id });
        await mirror.saveSession({
          profile: { subject: profile.subject, name: profile.name, email: profile.email },
        });
        await store.setSetting(rememberKey('/api/v1/me'), JSON.stringify(me));
      }
      if (store === null || controller.signal.aborted) return;
      const body = createMirrorBodyCache(
        () => mirror.current(),
        indexedBodyCache,
        () => useSessionStore.getState().profile?.subject,
      );
      injectBodyCache(body);

      const origin = globalThis.location.origin;
      const api = createFetchMirrorApi({
        coreUrl: origin,
        collabUrl: `${origin}/collab`,
        getToken: async () => {
          const token = await getAccessToken();
          if (token === null) throw new Error('There is no session to sync with.');
          return token;
        },
        isSessionClosed: () => useSessionStore.getState().status !== 'authenticated',
      });
      const ownerId = crypto.randomUUID();
      const scheduler = createSyncScheduler(async () => {
        if (bootOffline || !navigator.onLine) return;
        const outcome = await runFullSync({
          mirror,
          store,
          api,
          ownerId,
          signal: controller.signal,
          listWorkspaces: async () => {
            const all = [];
            for await (const workspace of client.paginate(workspaces.listWorkspaces()))
              all.push(workspace);
            return all;
          },
          capability: (itemId, versionId) =>
            client.query(files.downloadFile(itemId, versionId), { forceRefresh: true }),
        });
        if (outcome === 'revoked') await discardNativeMirror();
        else {
          setOfflineState({ lastSyncedAt: Date.now() });
          await warmRemembered(() => getAccessToken());
        }
      });
      stop = scheduler.start();
    })().catch(() => undefined);

    return () => {
      controller.abort();
      stop();
      injectBodyCache(undefined);
    };
  }, [bootOffline, client, getAccessToken, mirror, profile, status]);

  return null;
}
