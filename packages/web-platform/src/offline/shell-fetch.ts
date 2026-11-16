import { createMirrorFetch } from './mirror-fetch';
import { getNativeMirror } from './native-mirror';
import { getOfflineState, setOfflineState } from './offline-state';

let instance: typeof fetch | null | undefined;
let writtenTimer: ReturnType<typeof setTimeout> | undefined;
let writtenAt = 0;

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
            // One pass shortly after a burst of changes, not one per change, and no more than one a
            // minute: each pass asks Core about every workspace, on the rate limit queries share.
            onWritten: () => {
              clearTimeout(writtenTimer);
              const wait = Math.max(15_000, writtenAt + 60_000 - Date.now());
              writtenTimer = setTimeout(() => {
                writtenAt = Date.now();
                setOfflineState({ resyncRequestedAt: writtenAt });
              }, wait);
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
