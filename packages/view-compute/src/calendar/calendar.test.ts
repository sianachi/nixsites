import { describe, expect, it } from 'vitest';

import {
  type Fixture,
  type FixtureItem,
  fixtureItems,
  fixtureRequest,
  fixtureSource,
} from '../fixture.test-helper';
import { computeView } from '../index';

// Cases Core cannot be seeded into through its API (unreadable rules, withheld locked metadata,
// absent query parameters), so they are not golden fixtures.
const container: FixtureItem = {
  key: 'cal',
  parent: null,
  type: 'page',
  title: 'Tasks',
  views: { views: [{ id: 'c', name: 'Cal', kind: 'calendar', dateProperty: 'due_date' }] },
};

function read(items: FixtureItem[], query: string, edit?: (fixture: Fixture) => void) {
  const fixture: Fixture = {
    name: 'case',
    now: '2026-03-01T00:00:00Z',
    items,
    request: { method: 'GET', path: `/api/v1/workspaces/{workspace}/calendar${query}` },
    expected: { status: 200, body: null },
  };
  edit?.(fixture);
  return computeView(fixtureSource(fixture), fixtureRequest(fixture));
}

const window = '?from=2026-03-01&to=2026-03-31';
const child = (key: string, extra: Partial<FixtureItem>): FixtureItem => ({
  key,
  parent: 'cal',
  type: 'page',
  title: key,
  ...extra,
});

describe('workspace calendar edge cases', () => {
  it('refuses a missing bound as Core does', async () => {
    expect(await read([container], '?from=2026-03-01')).toMatchObject({
      status: 400,
      code: 'calendar.invalid_window',
      detail: "Both 'from' and 'to' are required, as yyyy-MM-dd.",
    });
  });

  it('cannot tell an empty workspace from one that is not synced', async () => {
    expect(await read([], window)).toBeNull();
  });

  it('reports a rule this build cannot read', async () => {
    const answer = await read(
      [
        container,
        child('bad', {
          properties: { due_date: '2026-03-02' },
          recurrence: { freq: 'daily', interval: 1, weekdays: ['mo'] },
        }),
      ],
      window,
    );
    expect(answer).toMatchObject({
      status: 200,
      body: { unplaceable: [{ reason: 'unreadable_rule' }], entries: [{ generated: false }] },
    });
  });

  it('answers null rather than guess at a locked container with children', async () => {
    const fixture: Fixture = {
      name: 'locked',
      now: '2026-03-01T00:00:00Z',
      items: [container, child('kid', { properties: { due_date: '2026-03-02' } })],
      request: { method: 'GET', path: `/api/v1/workspaces/{workspace}/calendar${window}` },
      expected: { status: 200, body: null },
    };
    const items = fixtureItems(fixture).map((item) => ({
      ...item,
      locked: item.parentId === null,
    }));
    const source = { ...fixtureSource(fixture), workspaceItems: () => Promise.resolve(items) };
    expect(await computeView(source, fixtureRequest(fixture))).toBeNull();
  });

  it('answers null when daily notes could be on the calendar', async () => {
    expect(
      await read([container, child('day', { properties: { $daily: '2026-03-05' } })], window),
    ).toBeNull();
  });
});
