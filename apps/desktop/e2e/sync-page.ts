import { createFetchMirrorApi } from '../../../packages/sync-core/src/fetch-api.ts';
import { openSqliteMirror, windowNixStorePost } from '../../../packages/sync-sqlite/src/index.ts';
import { createWebkitSqliteDriver } from '../../../packages/sync-sqlite/src/webkit-driver.ts';
import { runFullSync } from '../../../packages/web-platform/src/offline/sync.ts';

// Bundled into the page by e2e/boundary.mjs: the real sync engine, mirror and full-sync loop, with
// the desktop store behind them (through contextBridge) and a fake Core behind the network.

const workspace = '00000000-0000-4000-8000-000000000001';
const itemId = '00000000-0000-4000-8000-000000000002';
const scope = { serverOrigin: location.origin, tenantId: 'tenant', principalId: 'alice' };

/** Fails the first `changes` request with the error the desktop store gives a timed-out transaction. */
const interruptOnce = (api: ReturnType<typeof createFetchMirrorApi>) => {
  let done = false;
  return {
    ...api,
    changes: async (input: Parameters<typeof api.changes>[0]) => {
      if (!done) {
        done = true;
        await windowNixStorePost()({ op: 'commit', tx: 'stale' });
      }
      return api.changes(input);
    },
  };
};

(globalThis as Record<string, unknown>).__sync = async (scenario: string) => {
  const store = await openSqliteMirror({ driver: createWebkitSqliteDriver(), scope });
  const baseApi = createFetchMirrorApi({
    coreUrl: location.origin,
    collabUrl: `${location.origin}/collab`,
    getToken: () => Promise.resolve('token'),
    wait: () => Promise.resolve(),
  });
  const api = scenario === 'interrupted' ? interruptOnce(baseApi) : baseApi;
  const run = () =>
    runFullSync({
      mirror: {
        fileIndex: () => Promise.resolve({}),
        setFileIndex: () => Promise.resolve(),
        fileDownload: () => Promise.resolve(null),
        fileDelete: () => Promise.resolve(),
      },
      store,
      api,
      ownerId: 'e2e',
      listWorkspaces: () =>
        Promise.resolve([{ id: workspace, name: 'Work', lifecycleState: 'active' }]),
      capability: () => Promise.reject(new Error('no files')),
    });
  const state = async () => ({
    items: (await store.listItems(workspace)).length,
    outbox: (await store.listOutbox(workspace)).length,
    conflicts: (await store.listConflicts(workspace)).length,
  });
  const mode = (name: string) => fetch(`/__mode/${name}`);
  try {
    await mode('ok');
    const first = await run();
    if (scenario === 'queue') {
      await store.enqueue(workspace, {
        operationId: '00000000-0000-4000-8000-000000000005',
        itemId,
        kind: 'rename',
        expectedRevision: '1',
        payload: { title: 'Renamed offline' },
      });
    }
    const queued = await state();
    await mode(
      { refused: 'proxy403', 'core-refused': 'core403', queue: 'replay422' }[scenario] ?? 'ok',
    );
    const second = await run();
    return { first, second, queued, after: await state() };
  } finally {
    await store.wipeWorkspace(workspace);
    await store.close();
  }
};
