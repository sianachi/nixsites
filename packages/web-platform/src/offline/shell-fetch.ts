import { createMirrorFetch } from './mirror-fetch';
import { getNativeMirror } from './native-mirror';
import { getOfflineState, setOfflineState } from './offline-state';

let instance: typeof fetch | null | undefined;

/** The API client's fetch in the iOS shell (network first, the synced copy as a fallback); undefined elsewhere. */
export function getShellFetch(): typeof fetch | undefined {
  if (instance === undefined) {
    const mirror = getNativeMirror();
    instance =
      mirror === null
        ? null
        : createMirrorFetch({
            inner: (input, init) => globalThis.fetch(input, init),
            store: () => mirror.current(),
            principalId: () => mirror.principalId(),
            readFile: (itemId, versionId) => mirror.fileGet(itemId, versionId),
            isBootOffline: () => getOfflineState().bootOffline,
            onReachability: (up) => {
              setOfflineState({ networkDown: !up });
            },
            onUnlocked: (itemId) => {
              const store = mirror.current();
              if (store === null) return;
              void (async () => {
                const [item] = await store.readItems([itemId]);
                if (item === undefined) return;
                // A sealed workspace is rebuilt from a fresh snapshot on the next pass.
                await store.sealWorkspace(item.workspaceId);
                setOfflineState({ resyncRequestedAt: Date.now() });
              })().catch(() => undefined);
            },
          });
  }
  return instance ?? undefined;
}
