import { describe, expect, it } from 'vitest';

import { fixtureRequest, fixtureSource, type Fixture } from '../fixture.test-helper';
import { computeView } from '../index';

const chart = { id: 'c1', name: 'Chart', kind: 'chart', groupBy: 'size' };

function fixture(kids: Record<string, unknown>[]): Fixture {
  return {
    name: 'inline',
    now: '2026-06-15T12:00:00Z',
    items: [
      { key: 'root', parent: null, type: 'note', title: 'Root', views: { views: [chart] } },
      ...kids.map((properties, n) => ({
        key: `k${String(n)}`,
        parent: 'root',
        type: 'note',
        title: 'k',
        properties,
      })),
    ],
    request: { method: 'GET', path: '/api/v1/items/{root}/chart?view=c1' },
    expected: { status: 200, body: null },
  };
}

const run = (f: Fixture) => computeView(fixtureSource(f), fixtureRequest(f));

describe('chart answers it cannot give exactly with null', () => {
  it('groups by a fractional number, whose text form jsonb decides', async () => {
    expect(await run(fixture([{ size: 1.5 }]))).toBeNull();
  });

  it('breaks a tie between values whose collation order is not known', async () => {
    expect(await run(fixture([{ size: 'a b' }, { size: 'a-b' }]))).toBeNull();
  });

  it('answers a tie between plain lowercase values', async () => {
    expect(await run(fixture([{ size: 'b' }, { size: 'a' }]))).toMatchObject({ status: 200 });
  });
});
