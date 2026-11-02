import { describe, expect, it } from 'vitest';

import { fixtureItems, fixtureRequest, fixtureSource, loadFixtures } from '../fixture.test-helper';
import { computeView } from '../index';

describe('finance offline', () => {
  it('asks Core about a locked finance root rather than calling it unconfigured', async () => {
    const fixture = loadFixtures('finance').find((f) => f.expected.status === 200);
    if (fixture === undefined) throw new Error('no answered finance fixture');
    const request = fixtureRequest(fixture);
    const rootId = /\/items\/([^/]+)\/finance/.exec(request.url.pathname)?.[1];
    const items = fixtureItems(fixture).map((item) =>
      item.id === rootId ? { ...item, locked: true } : item,
    );
    const source = {
      ...fixtureSource(fixture),
      item: (id: string) => Promise.resolve(items.find((item) => item.id === id)),
      workspaceItems: () => Promise.resolve(items),
    };
    expect(await computeView(source, request)).toBeNull();
  });
});
