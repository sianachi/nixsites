import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { fixtureRequest, fixtureSource, idsToKeys, type Fixture } from '../fixture.test-helper';
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

const ctxFolder = join(import.meta.dirname, '..', '..', 'fixtures', 'chart', 'ctx');
const ctxFixtures = readdirSync(ctxFolder)
  .filter((n) => n.endsWith('.json'))
  .sort()
  .map((n) => JSON.parse(readFileSync(join(ctxFolder, n), 'utf8')) as Fixture);

describe("chart fixtures that depend on the reader's day", () => {
  for (const f of ctxFixtures)
    it(f.name, async () => {
      const answer = await computeView({ ...fixtureSource(f), timeZone: null }, fixtureRequest(f));
      expect(
        idsToKeys(
          answer,
          f.items.map((i) => i.key),
        ),
      ).toEqual(f.expected);
    });

  // A one-day window ending today: its `to` is the reader's day.
  const view = { ...chart, chart: { kind: 'line', period: 'day', lastPeriods: 1 } };
  const today: Fixture = {
    ...fixture([]),
    items: [{ key: 'root', parent: null, type: 'note', title: 'Root', views: { views: [view] } }],
  };
  const ask = (zone: { timeZone?: string | null }) =>
    computeView({ ...fixtureSource(today), ...zone }, fixtureRequest(today)) as Promise<{
      body: { to: string };
    } | null>;

  it('returns null when the reader zone is unknown', async () => {
    expect(await ask({})).toBeNull();
  });

  it('takes today in the reader zone, and UTC for an unknown zone name', async () => {
    // 2026-06-15T12:00Z is already the 16th in Auckland.
    expect((await ask({ timeZone: 'Pacific/Auckland' }))?.body.to).toBe('2026-06-16');
    expect((await ask({ timeZone: null }))?.body.to).toBe('2026-06-15');
    expect((await ask({ timeZone: 'Not/AZone' }))?.body.to).toBe('2026-06-15');
  });
});
