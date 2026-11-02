/* eslint-disable @typescript-eslint/no-non-null-assertion -- ported refusal text interpolates Core's numeric limits; request-shape checks are narrowed by hand */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  type Fixture,
  fixtureId,
  fixtureItems,
  fixtureRequest,
  fixtureSource,
  idsToKeys,
} from '../fixture.test-helper';
import { computeView } from '../index';
import type { ViewAnswer } from '../types';
import { itemQueryResultsSchema } from '../../../api-client/src/schemas/item-query';
import {
  workspaceAggregateSchema,
  workspaceQueryResultsSchema,
} from '../../../api-client/src/schemas/workspace-query';
import type { QuerySource } from './index';

const PRINCIPAL = '1b1b1b1b-1111-4111-8111-1b1b1b1b1b1b'; // Core's seeded caller in the replay

function contextSource(fixture: Fixture, extra: Partial<QuerySource> = {}): QuerySource {
  return {
    ...fixtureSource(fixture),
    principalId: PRINCIPAL,
    timeZone: null,
    workspaceIds: () => Promise.resolve([fixtureId('workspace')]),
    ...extra,
  };
}

const folder = join(import.meta.dirname, '..', '..', 'fixtures', 'query', 'ctx');
describe('query fixtures that need the caller context', () => {
  for (const name of readdirSync(folder)
    .filter((n) => n.endsWith('.json'))
    .sort()) {
    const fixture = JSON.parse(readFileSync(join(folder, name), 'utf8')) as Fixture;
    it(fixture.name, async () => {
      const answer = await computeView(contextSource(fixture), fixtureRequest(fixture));
      expect(
        idsToKeys(
          answer,
          fixture.items.map((i) => i.key),
        ),
      ).toEqual(fixture.expected);
    });
  }
});

const base: Fixture = {
  name: 'unit',
  now: '2026-03-10T12:00:00Z',
  items: [
    { key: 'a', parent: null, type: 'task', title: 'A', properties: { title: 'A', n: 1 } },
    { key: 'b', parent: null, type: 'task', title: 'B', properties: { title: 'B', n: 1 } },
  ],
  request: {
    method: 'POST',
    path: '/api/v1/workspaces/{workspace}/query',
    body: { sort: { property: 'n' } },
  },
  expected: { status: 200, body: null },
};

const ask = (
  fixture: Fixture,
  source: QuerySource = fixtureSource(fixture),
): Promise<ViewAnswer | null> => computeView(source, fixtureRequest(fixture));

describe('query semantics', () => {
  it('breaks ties by id, ascending, whatever the direction', async () => {
    const ids = [fixtureId('a'), fixtureId('b')].sort();
    for (const descending of [false, true]) {
      const fixture = {
        ...base,
        request: { ...base.request, body: { sort: { property: 'n', descending } } },
      };
      const answer = (await ask(fixture)) as { body: { results: { id: string }[] } };
      expect(answer.body.results.map((r) => r.id)).toEqual(ids);
    }
  });

  it('hides an item whose unlock grant has lapsed, and withholds what a lock hides', async () => {
    const items = fixtureItems(base).map((item, i) => ({
      ...item,
      locked: true,
      updatedAt: null,
      metadataExpiresAt: i === 0 ? '2026-03-01T00:00:00Z' : '2099-01-01T00:00:00Z',
    }));
    const source: QuerySource = {
      item: (id) => Promise.resolve(items.find((x) => x.id === id)),
      workspaceItems: () => Promise.resolve(items),
      now: () => new Date(base.now),
    };
    // Expired grant: only the second item remains.
    const answer = (await ask(base, source)) as { body: { results: { id: string }[] } };
    expect(answer.body.results.map((r) => r.id)).toEqual([fixtureId('b')]);
    // Recency order needs last_modified_at, which a lock withholds from the copy: not answered.
    const recency = { ...base, request: { ...base.request, body: {} } };
    const two = items.map((x) => ({ ...x, metadataExpiresAt: '2099-01-01T00:00:00Z' }));
    const both: QuerySource = { ...source, workspaceItems: () => Promise.resolve(two) };
    expect(await ask(recency, both)).toBeNull();
  });

  it('does not answer what the caller context is needed for', async () => {
    const me = { ...base, request: { ...base.request, body: { preset: 'assigned-to-me' } } };
    expect(await ask(me)).toBeNull();
    const created = {
      ...base,
      request: {
        ...base.request,
        body: { filters: [{ property: '$created', operator: 'on', value: '2026-03-10' }] },
      },
    };
    expect(await ask(created)).toBeNull();
    expect(await ask(created, contextSource(created))).not.toBeNull();
  });

  it('reads the day in the caller zone', async () => {
    const fixture: Fixture = {
      ...base,
      items: [{ ...base.items[0]!, createdAt: '2026-03-10T03:00:00Z' }],
      request: {
        ...base.request,
        body: { filters: [{ property: '$created', operator: 'on', value: '2026-03-09' }] },
      },
    };
    const count = async (zone: string | null): Promise<number> =>
      (
        (await ask(fixture, contextSource(fixture, { timeZone: zone }))) as {
          body: { results: unknown[] };
        }
      ).body.results.length;
    expect(await count(null)).toBe(0);
    expect(await count('America/New_York')).toBe(1); // 03:00Z is 23:00 on the 9th (EDT began on the 8th)
  });

  it('does not answer a workspace the copy does not hold', async () => {
    const empty: Fixture = { ...base, items: [] };
    expect(await ask(empty)).toBeNull();
  });

  it('does not answer a smart list without the readable workspaces', async () => {
    const list: Fixture = {
      ...base,
      items: [
        {
          key: 'list',
          parent: null,
          type: 'page',
          title: 'L',
          properties: { title: 'L' },
          views: { views: [{ id: 'q', name: 'Q', kind: 'query' }] },
        },
      ],
      request: { method: 'GET', path: '/api/v1/items/{list}/query?view=q&today=2026-03-10' },
    };
    expect(await ask(list)).toBeNull();
    const answer = await ask(list, contextSource(list));
    expect(answer).toMatchObject({ status: 200 });
  });

  it('refuses stored rules that no longer validate', async () => {
    const list: Fixture = {
      ...base,
      items: [
        {
          key: 'list',
          parent: null,
          type: 'page',
          title: 'L',
          properties: { title: 'L' },
          views: {
            views: [
              {
                id: 'q',
                name: 'Q',
                kind: 'query',
                filters: [{ property: 'x', operator: 'within-next', value: '999' }],
              },
            ],
          },
        },
      ],
      request: { method: 'GET', path: '/api/v1/items/{list}/query?view=q&today=2026-03-10' },
    };
    expect(await ask(list, contextSource(list))).toMatchObject({
      status: 422,
      code: 'query.invalid_rules',
    });
  });

  it('answers in the published shapes', async () => {
    const fixtures = [
      { ...base, request: { ...base.request, body: { groupBy: { property: 'n' } } } },
      {
        ...base,
        request: {
          ...base.request,
          path: '/api/v1/workspaces/{workspace}/query/aggregate',
          body: { aggregate: { function: 'sum', property: 'n' } },
        },
      },
    ];
    const schemas = [workspaceQueryResultsSchema, workspaceAggregateSchema];
    for (const [i, fixture] of fixtures.entries()) {
      const answer = (await ask(fixture)) as { body: unknown };
      expect(schemas[i]!.safeParse(answer.body).success).toBe(true);
    }
    const list = JSON.parse(
      readFileSync(join(folder, '01-smart-list-soonest.json'), 'utf8'),
    ) as Fixture;
    const answer = (await ask(list, contextSource(list))) as { body: unknown };
    expect(itemQueryResultsSchema.safeParse(answer.body).success).toBe(true);
  });
});

describe('smart lists over every readable workspace', () => {
  it('ask Core when a readable workspace is missing from the synced copy', async () => {
    const fixture = JSON.parse(
      readFileSync(join(folder, '02-smart-list-saved-sort.json'), 'utf8'),
    ) as Fixture;
    const source = contextSource(fixture, {
      workspaceIds: () => Promise.resolve([fixtureId('workspace'), fixtureId('resealed')]),
    });
    expect(await computeView(source, fixtureRequest(fixture))).toBeNull();
  });
});
