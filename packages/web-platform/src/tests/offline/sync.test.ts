import type { MirrorItem } from '@nix/sync-core/mirror';
import type { SqliteMirrorStore } from '@nix/sync-sqlite';
import { describe, expect, it, vi } from 'vitest';

import {
  createSyncScheduler,
  describeSyncProblem,
  downloadable,
  runFullSync,
  syncFiles,
  type SyncDeps,
} from '../../offline/sync';

const runSyncPass = vi.hoisted(() => vi.fn());
vi.mock('@nix/sync-core', () => ({ runSyncPass }));

const fileItem = (id: string, versionId: string, over: Partial<MirrorItem> = {}) =>
  ({
    id,
    lifecycleState: 'active',
    locked: false,
    file: { versionId, fileName: 'f', mediaType: 'text/plain', byteLength: 3, sha256: 'h' },
    ...over,
  }) as unknown as MirrorItem;

function setup(items: MirrorItem[], index: Record<string, string>) {
  const stored = { ...index };
  const mirror = {
    fileIndex: vi.fn(() => Promise.resolve({ ...stored })),
    setFileIndex: vi.fn((next: Record<string, string>) => {
      for (const key of Object.keys(stored)) Reflect.deleteProperty(stored, key);
      Object.assign(stored, next);
      return Promise.resolve();
    }),
    fileDownload: vi.fn(() =>
      Promise.resolve<{ bytes: number; sha256: string } | null>({ bytes: 3, sha256: 'h' }),
    ),
    fileDelete: vi.fn(() => Promise.resolve()),
  };
  const capability = vi.fn((itemId: string, versionId: string) =>
    Promise.resolve({
      url: `https://files.example/${itemId}/${versionId}`,
      byteLength: 3,
      sha256: 'h',
    }),
  );
  const deps = {
    mirror,
    store: { listItems: () => Promise.resolve(items) } as unknown as SqliteMirrorStore,
    capability,
  } as unknown as SyncDeps;
  return { deps, mirror, capability, stored };
}

describe('file sync', () => {
  it('downloads unstored versions and drops files that left the mirror', async () => {
    const { deps, mirror, stored } = setup(
      [fileItem('a', 'v2'), fileItem('b', 'v1'), fileItem('locked', 'v1', { locked: true })],
      { a: 'v1', gone: 'v9', b: 'v1' },
    );
    await syncFiles(deps, ['ws']);
    expect(mirror.fileDelete).toHaveBeenCalledWith('a', 'v1');
    expect(mirror.fileDelete).toHaveBeenCalledWith('gone', 'v9');
    expect(mirror.fileDownload).toHaveBeenCalledTimes(1);
    expect(mirror.fileDownload).toHaveBeenCalledWith('a', 'v2', 'https://files.example/a/v2');
    expect(stored).toEqual({ a: 'v2', b: 'v1' });
  });

  it('skips a version that changed under it and removes a short download', async () => {
    const changed = setup([fileItem('a', 'v1')], {});
    changed.capability.mockResolvedValueOnce({
      url: 'https://f.example/x',
      byteLength: 3,
      sha256: 'other',
    });
    await syncFiles(changed.deps, ['ws']);
    expect(changed.mirror.fileDownload).not.toHaveBeenCalled();

    const short = setup([fileItem('a', 'v1')], {});
    short.mirror.fileDownload.mockResolvedValueOnce({ bytes: 2, sha256: 'h' });
    await syncFiles(short.deps, ['ws']);
    expect(short.mirror.fileDelete).toHaveBeenCalledWith('a', 'v1');
    expect(short.stored).toEqual({});
  });

  it('removes a download whose digest is not the one Core named, and skips a refused one', async () => {
    const forged = setup([fileItem('a', 'v1')], {});
    forged.mirror.fileDownload.mockResolvedValueOnce({ bytes: 3, sha256: 'evil' });
    await syncFiles(forged.deps, ['ws']);
    expect(forged.mirror.fileDelete).toHaveBeenCalledWith('a', 'v1');
    expect(forged.stored).toEqual({});

    const refused = setup([fileItem('a', 'v1')], {});
    refused.mirror.fileDownload.mockResolvedValueOnce(null);
    await syncFiles(refused.deps, ['ws']);
    expect(refused.stored).toEqual({});
  });

  it('counts the files it could not store, but not a version that changed under it', async () => {
    const failing = setup([fileItem('a', 'v1'), fileItem('b', 'v1'), fileItem('c', 'v1')], {});
    failing.mirror.fileDownload
      .mockRejectedValueOnce(new Error('Download failed.'))
      .mockResolvedValueOnce({ bytes: 3, sha256: 'evil' });
    expect(await syncFiles(failing.deps, ['ws'])).toBe(2);
    expect(failing.stored).toEqual({ c: 'v1' });

    const changed = setup([fileItem('a', 'v1')], {});
    changed.capability.mockResolvedValueOnce({ url: 'https://f/a', byteLength: 3, sha256: 'new' });
    expect(await syncFiles(changed.deps, ['ws'])).toBe(0);
  });

  it('only fetches from plain https or local urls', () => {
    expect(downloadable('https://files.example/x')).toBe(true);
    expect(downloadable('http://localhost:9000/x')).toBe(true);
    expect(downloadable('http://files.example/x')).toBe(false);
    expect(downloadable('https://u:p@files.example/x')).toBe(false);
  });
});

describe('sync scheduler', () => {
  it('runs one pass at a time', async () => {
    let release: () => void = () => undefined;
    const run = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
    const scheduler = createSyncScheduler(run);
    const first = scheduler.trigger();
    const second = scheduler.trigger();
    expect(run).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, second]);
    run.mockResolvedValueOnce(undefined);
    await scheduler.trigger();
    expect(run).toHaveBeenCalledTimes(2);
  });
});

describe('full sync report', () => {
  it('names failed workspaces, and marks a pass that got no answer as unreachable', async () => {
    const { deps } = setup([], {});
    const store = {
      listItems: () => Promise.resolve([]),
      replaceWorkspaceList: vi.fn(() => Promise.resolve()),
      setSetting: vi.fn(() => Promise.resolve()),
    };
    const workspaces = ['Home', 'Work', 'Away'].map((name) => ({
      id: name,
      name,
      lifecycleState: 'active',
    }));
    runSyncPass
      .mockResolvedValueOnce({ status: 'complete', replayedOperations: 0, conflicts: 0 })
      .mockRejectedValueOnce(new Error('Snapshot response does not advance'))
      .mockRejectedValueOnce(new TypeError('Load failed'));
    const report = await runFullSync({
      ...deps,
      store: store as unknown as SqliteMirrorStore,
      listWorkspaces: () => Promise.resolve(workspaces),
    });
    expect(report).toEqual({ failedWorkspaces: ['Work'], failedFiles: 0, unreachable: true });
  });

  it('says nothing when everything synced', () => {
    expect(describeSyncProblem({ failedWorkspaces: [], failedFiles: 0, unreachable: false })).toBe(
      null,
    );
    expect(
      describeSyncProblem({ failedWorkspaces: ['Work'], failedFiles: 2, unreachable: false }),
    ).toBe('Work could not be synced; 2 files could not be downloaded.');
  });
});
