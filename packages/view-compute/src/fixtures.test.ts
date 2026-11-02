import { describe, expect, it } from 'vitest';

import { fixtureRequest, fixtureSource, idsToKeys, loadFixtures } from './fixture.test-helper';
import { computeView } from './index';

describe('fixture ids', () => {
  it('round-trips keys through ids', () => {
    const fixture = {
      name: 'ids',
      now: '2026-01-01T00:00:00Z',
      items: [{ key: 'root', parent: null, type: 'page', title: 'Root' }],
      request: { method: 'GET' as const, path: '/api/v1/items/{root}/query?w={workspace}' },
      expected: { status: 200 as const, body: null },
    };
    const url = fixtureRequest(fixture).url;
    expect(idsToKeys(url.pathname + url.search, ['root'])).toBe(fixture.request.path);
    expect(fixtureSource(fixture).now().toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });
});

// The same files are replayed through Core's handlers by the C# side, so the two cannot drift.
for (const slice of ['query', 'chart', 'calendar', 'habit', 'finance']) {
  const fixtures = loadFixtures(slice);
  describe.skipIf(fixtures.length === 0)(`${slice} fixtures`, () => {
    for (const fixture of fixtures)
      it(fixture.name, async () => {
        const answer = await computeView(fixtureSource(fixture), fixtureRequest(fixture));
        const keys = fixture.items.map((item) => item.key);
        expect(idsToKeys(answer, keys)).toEqual(fixture.expected);
      });
  });
}
