import { files, principal, workspaces } from '@nix/api-client';
import { createFetchMirrorApi } from '@nix/sync-core/fetch-api';
import { useSessionStore } from '@nix/web-foundation/lib/session-store';
import {
  injectBodyCache,
  injectPendingBodySink,
  indexedBodyCache,
} from '@nix/web-foundation/lib/body-cache';
import { useEffect, type ReactNode } from 'react';

import { useApiClient } from '../api/api-client-provider';
import { useAuth } from '../auth/auth-provider';
import { createMirrorBodyCache, createMirrorPendingSink } from './mirror-body-cache';
import { REMEMBERED, rememberKey } from './mirror-fetch';
import { discardNativeMirror, getNativeMirror, type NativeMirror } from './native-mirror';
import {
  getOfflineState,
  setOfflineState,
  subscribeOfflineState,
  useOfflineState,
} from './offline-state';
import { getShellFetch } from './shell-fetch';
import { createSyncScheduler, describeSyncProblem, runFullSync, type SyncReport } from './sync';

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

/**
 * Shows what the sync could not do, with a notification when it starts failing (iOS shows it only
 * while the app is off screen), and clears it once a pass does everything. A pass that got no
 * answer from the network says nothing either way.
 */
function reportSyncProblem(mirror: NativeMirror, report: SyncReport): void {
  if (report.unreachable || !navigator.onLine) return;
  const problem = describeSyncProblem(report);
  const before = getOfflineState().syncProblem;
  setOfflineState({ syncProblem: problem });
  if (problem !== null && before === null)
    void mirror.notify({ title: 'Nix could not sync', body: `${problem} Open Nix to try again.` });
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
        // iOS asks once, here at sign-in, so a later failure can be said while the app is closed.
        void mirror.notify();
      }
      if (store === null || controller.signal.aborted) return;
      const body = createMirrorBodyCache(
        () => mirror.current(),
        indexedBodyCache,
        () => useSessionStore.getState().profile?.subject,
      );
      injectBodyCache(body);
      injectPendingBodySink(
        createMirrorPendingSink(
          () => mirror.current(),
          () => useSessionStore.getState().profile?.subject,
        ),
      );

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
        await mirror.keepAwake(true);
        try {
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
            // Queued changes were replayed: item ids and lists the screens hold may have changed.
            onReplayed: () => {
              client.invalidate(['items']);
              client.invalidate(['workspaces']);
            },
            capability: (itemId, versionId) =>
              client.query(files.downloadFile(itemId, versionId), { forceRefresh: true }),
          });
          if (outcome === 'revoked') await discardNativeMirror();
          else {
            setOfflineState({ lastSyncedAt: Date.now() });
            reportSyncProblem(mirror, outcome);
            await warmRemembered(() => getAccessToken());
          }
        } finally {
          await mirror.keepAwake(false);
        }
      });
      const stopScheduler = scheduler.start();
      // Writes queued while the connection was flaky go out as soon as a request gets through.
      let wasDown = getOfflineState().networkDown;
      let resyncAt = getOfflineState().resyncRequestedAt;
      const unsubscribe = subscribeOfflineState(() => {
        const { networkDown: down, resyncRequestedAt } = getOfflineState();
        if ((wasDown && !down) || resyncRequestedAt !== resyncAt) void scheduler.trigger();
        wasDown = down;
        resyncAt = resyncRequestedAt;
      });
      stop = () => {
        unsubscribe();
        stopScheduler();
      };
    })().catch((error: unknown) => {
      // Without an open copy nothing syncs and the app cannot start offline: say so.
      if (controller.signal.aborted) return;
      console.error('Offline copy could not be opened', error);
      setOfflineState({
        syncProblem: 'The offline copy could not be opened, so Nix will not work offline.',
      });
    });

    return () => {
      controller.abort();
      stop();
      injectBodyCache(undefined);
      injectPendingBodySink(undefined);
    };
  }, [bootOffline, client, getAccessToken, mirror, profile, status]);

  return null;
}
