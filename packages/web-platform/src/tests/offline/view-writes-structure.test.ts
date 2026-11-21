import type { MirrorItem } from '@nix/sync-core/mirror';
import { describe, expect, it } from 'vitest';

import type { MirrorReader } from '../../offline/mirror-fetch';
import { planStructureWrite } from '../../offline/view-writes/structure';

const ID = '0192f6e0-0000-7000-8000-000000000001';
const item = (over: Partial<MirrorItem> = {}) =>
  ({
    id: ID,
    revision: '4',
    lifecycleState: 'active',
    locked: false,
    canWrite: true,
    noDelete: false,
    noChildren: true,
    managedBy: null,
    viewsVersion: 'v1',
    schema: {
      properties: [{ key: 'a', label: 'A', type: 'text', required: false }],
      inherit: false,
    },
    ...over,
  }) as MirrorItem;
const store = (found: MirrorItem | undefined) =>
  ({
    readItems: () => Promise.resolve(found === undefined ? [] : [found]),
  }) as unknown as MirrorReader;
const plan = (found: MirrorItem | undefined, part: string, body: unknown, method = 'PUT') =>
  planStructureWrite(store(found), method, `/api/v1/items/${ID}/${part}`, body, () =>
    Promise.resolve(null),
  );

describe('protection, views and schema offline', () => {
  it('queues protection with the flags the device last saw', async () => {
    expect(await plan(item(), 'protection', { noDelete: true })).toMatchObject({
      kind: 'request',
      body: { noDelete: true, base: { noDelete: false, noChildren: true } },
      answer: { reread: `/api/v1/items/${ID}` },
    });
  });

  it.each([
    ['collaboration', { collaboration: true }],
    ['a non-boolean flag', { noDelete: 'yes' }],
  ])('leaves %s to a connection', async (_name, body) => {
    expect(await plan(item(), 'protection', body)).toBeNull();
  });

  it('leaves the deletion protection of a managed item to Core', async () => {
    expect(
      await plan(item({ managedBy: 'calendar' }), 'protection', { noDelete: false }),
    ).toBeNull();
  });

  it('queues views only with the version the person saw', async () => {
    const body = { views: [], default: 'document', expectedVersion: 'v1' };
    expect(await plan(item(), 'views', body)).toMatchObject({ kind: 'request', body });
    expect(await plan(item(), 'views', { ...body, expectedVersion: undefined })).toBeNull();
    expect(await plan(item({ viewsVersion: null }), 'views', body)).toBeNull();
    expect(await plan(item({ viewsVersion: undefined }), 'views', body)).toBeNull();
  });

  it('queues a schema with the document it was edited from', async () => {
    const properties = [{ key: 'b', label: 'B', type: 'text', required: false }];
    expect(await plan(item(), 'schema', { properties, inherit: true })).toMatchObject({
      kind: 'request',
      body: {
        properties,
        inherit: true,
        base: { properties: [expect.objectContaining({ key: 'a' })], inherit: false },
      },
    });
    expect(await plan(item(), 'schema', { properties })).toBeNull();
  });

  it.each([
    ['an item waiting to be created', item({ revision: '0' })],
    ['a locked item', item({ locked: true })],
    ['a read-only item', item({ canWrite: false })],
    ['a missing item', undefined],
  ])('does not queue for %s', async (_name, found) => {
    expect(await plan(found, 'protection', { noDelete: true })).toBeNull();
  });

  it('does not take other routes or methods', async () => {
    expect(await plan(item(), 'pet-protection', {})).toBeNull();
    expect(await plan(item(), 'view-setups', {})).toBeNull();
    expect(await plan(item(), 'schema', {}, 'DELETE')).toBeNull();
  });
});
