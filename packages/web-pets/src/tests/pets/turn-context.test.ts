import { describe, expect, it, vi } from 'vitest';
import type { NixClient } from '@nix/api-client';
import {
  buildWorkspaceMap,
  ownerTurnContext,
  truncateUnits,
  WORKSPACE_MAP_LIMIT,
} from '../../pets/turn-context';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';

function id(n: number): string {
  return `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
}

function item(n: number, hasChildren: boolean, parentId: string | null = null) {
  return {
    id: id(n),
    workspaceId: WORKSPACE_ID,
    parentId,
    title: `Item ${String(n)}`,
    type: 'note',
    hasChildren,
  };
}

/** A client whose listing answers from `tree` (keyed by parent id, '' for the root) and whose
 * cache holds view summaries for the ids in `cachedViews`. */
/** Answers lock reads: unlocked unless the id is in `locked`, refused when it is in `failing`. */
function lockQuery(locked: readonly string[] = [], failing: readonly string[] = []) {
  return vi.fn((endpoint: { path: string }) => {
    const itemId = endpoint.path.split('/')[4] ?? '';
    if (failing.includes(itemId)) return Promise.reject(new Error('lock read failed'));
    return Promise.resolve({ locked: locked.includes(itemId), unlockedUntil: null });
  });
}

function fakeClient(
  tree: Record<string, unknown[]>,
  cachedViews: Record<string, string[]> = {},
  query: ReturnType<typeof vi.fn> = lockQuery(),
): { client: NixClient; paginate: ReturnType<typeof vi.fn> } {
  const paginate = vi.fn(async function* (endpoint: { query: { parentId?: string } }) {
    await Promise.resolve();
    yield* tree[endpoint.query.parentId ?? ''] ?? [];
  });
  const peek = vi.fn((key: readonly string[]) => {
    const kinds = key[2] === 'views' ? cachedViews[key[1] ?? ''] : undefined;
    return kinds === undefined
      ? undefined
      : { data: { views: kinds.map((kind) => ({ kind })) }, storedAt: 0, stale: false };
  });
  return { client: { paginate, query, cache: { peek } } as unknown as NixClient, paginate };
}

describe('ownerTurnContext', () => {
  it('reports the browser zone and the day in that zone as yyyy-MM-dd', () => {
    const context = ownerTurnContext(new Date('2026-10-09T12:00:00Z'));
    expect(context.timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(context.today).toMatch(/^2026-10-(08|09|10)$/);
  });
});

describe('buildWorkspaceMap', () => {
  it('lists every root and the containers one level down, with cached view kinds only', async () => {
    const { client } = fakeClient(
      {
        '': [item(1, true), item(2, false)],
        [id(1)]: [item(3, true, id(1)), item(4, false, id(1))],
      },
      { [id(1)]: ['board', 'calendar'] },
    );
    const map = await buildWorkspaceMap(client, WORKSPACE_ID, new AbortController().signal);
    expect(map).toEqual([
      { id: id(1), title: 'Item 1', type: 'note', viewKinds: ['board', 'calendar'] },
      { id: id(2), title: 'Item 2', type: 'note' },
      { id: id(3), title: 'Item 3', type: 'note' },
    ]);
  });

  it('stops at the map limit and reads children for a bounded number of roots', async () => {
    const roots = Array.from({ length: 30 }, (_, index) => item(index + 1, true));
    const tree: Record<string, unknown[]> = { '': roots };
    for (const root of roots)
      tree[root.id] = Array.from({ length: 5 }, (_, index) => item(1000 + index, true, root.id));
    const { client, paginate } = fakeClient(tree);
    const map = await buildWorkspaceMap(client, WORKSPACE_ID, new AbortController().signal);
    expect(map).toHaveLength(WORKSPACE_MAP_LIMIT);
    // The root listing plus at most eight child listings: never one request per root.
    expect(paginate.mock.calls.length).toBeLessThanOrEqual(9);
    expect(map?.slice(0, 30).map((entry) => entry.id)).toEqual(roots.map((root) => root.id));
  });

  it('keeps the rest of the map when one container refuses its listing', async () => {
    const paginate = vi.fn(async function* (endpoint: { query: { parentId?: string } }) {
      await Promise.resolve();
      const parent = endpoint.query.parentId;
      if (parent === id(1)) throw new Error('locked');
      if (parent === undefined) yield* [item(1, true), item(2, true)];
      else if (parent === id(2)) yield item(3, true, id(2));
    });
    const client = {
      paginate,
      query: lockQuery(),
      cache: { peek: vi.fn() },
    } as unknown as NixClient;
    const map = await buildWorkspaceMap(client, WORKSPACE_ID, new AbortController().signal);
    expect(map?.map((entry) => entry.id)).toEqual([id(1), id(2), id(3)]);
  });

  it('never lists what sits under a lock, opened or not, and skips a root whose lock cannot be read', async () => {
    const tree = {
      '': [item(1, true), item(2, true), item(3, true)],
      [id(1)]: [item(11, true, id(1))],
      [id(2)]: [item(12, true, id(2))],
      [id(3)]: [item(13, true, id(3))],
    };
    const { client, paginate } = fakeClient(tree, {}, lockQuery([id(1)], [id(3)]));
    const map = await buildWorkspaceMap(client, WORKSPACE_ID, new AbortController().signal);
    expect(map?.map((entry) => entry.id)).toEqual([id(1), id(2), id(3), id(12)]);
    const listed = paginate.mock.calls.map(
      ([endpoint]) => (endpoint as { query: { parentId?: string } }).query.parentId,
    );
    expect(listed).not.toContain(id(1));
    expect(listed).not.toContain(id(3));
  });

  it('shortens titles and types to the shared limits counted in UTF-16 units', async () => {
    const long = { ...item(1, false), title: 'é'.repeat(300), type: 't'.repeat(80) };
    const { client } = fakeClient({ '': [long] }, { [id(1)]: ['board', 'x'.repeat(41)] });
    const [entry] =
      (await buildWorkspaceMap(client, WORKSPACE_ID, new AbortController().signal)) ?? [];
    expect(entry?.title).toHaveLength(240);
    expect(entry?.type).toHaveLength(64);
    expect(entry?.viewKinds).toEqual(['board']);
    const clef = String.fromCodePoint(0x1d11e);
    expect(truncateUnits(`a${clef}`, 2)).toBe('a');
    expect(truncateUnits(`a${clef}`, 3)).toBe(`a${clef}`);
  });

  it('gives up quietly when the workspace cannot be listed, so the message still goes', async () => {
    const paginate = vi.fn(async function* () {
      await Promise.resolve();
      yield* [];
      throw new Error('offline');
    });
    const client = {
      paginate,
      query: lockQuery(),
      cache: { peek: vi.fn() },
    } as unknown as NixClient;
    await expect(
      buildWorkspaceMap(client, WORKSPACE_ID, new AbortController().signal),
    ).resolves.toBeUndefined();
  });
});
