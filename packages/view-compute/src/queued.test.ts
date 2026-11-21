import { describe, expect, it } from 'vitest';

import {
  fixtureId,
  fixtureRequest,
  fixtureSource,
  idsToKeys,
  loadFixtures,
  type Fixture,
} from './fixture.test-helper';
import { computeView } from './index';
import { withQueuedRequests, type QueuedRequest } from './queued';

const find = (slice: string, name: string): Fixture => {
  const fixture = loadFixtures(slice).find((entry) => entry.name.startsWith(name));
  if (fixture === undefined) throw new Error(`No ${slice} fixture ${name}`);
  return fixture;
};

/** Reads `shown` through the queued writes, as the view the fixture's request asks for. */
async function answerWith(
  fixture: Fixture,
  shown: Fixture,
  queued: readonly QueuedRequest[],
  withChildren = false,
) {
  const base = fixtureSource(shown);
  const source = withQueuedRequests(
    withChildren
      ? {
          ...base,
          children: async (workspaceId, parentId) =>
            (await base.workspaceItems(workspaceId)).filter((item) => item.parentId === parentId),
        }
      : base,
    () => Promise.resolve(queued),
  );
  const answer = await computeView(source, fixtureRequest(fixture));
  return idsToKeys(
    answer,
    fixture.items.map((item) => item.key),
  );
}

interface HabitBody {
  body: { checkIns: { occurredOn: string; quantity: number | null }[] };
}

describe('queued habit check-ins', () => {
  const fixture = find('habit', 'habit: daily quantity target');
  const without = (key: string): Fixture => ({
    ...fixture,
    items: fixture.items.filter((item) => item.key !== key),
  });
  const request = (key: string, day: string, body: unknown, method = 'PUT'): QueuedRequest => ({
    operationId: fixtureId(key),
    itemId: fixtureId('habit'),
    method,
    path: `/api/v1/items/${fixtureId('habit')}/habit/check-ins/${day}`,
    body,
  });

  for (const children of [false, true])
    describe(children ? 'through a children lookup' : 'through the workspace list', () => {
      it('shows a queued check-in as the recorded view shows the real one', async () => {
        const put = request('c2', '2026-03-02', { completed: false, quantity: 3.5 });
        expect(await answerWith(fixture, without('c2'), [put], children)).toEqual(fixture.expected);
      });

      it('replaces the row of a day that already has a check-in', async () => {
        const put = request('x', '2026-03-03', { completed: false, quantity: 2 });
        const answer = (await answerWith(fixture, fixture, [put], children)) as HabitBody;
        const days = answer.body.checkIns.filter((row) => row.occurredOn === '2026-03-03');
        expect(days).toEqual([expect.objectContaining({ quantity: 2 })]);
      });

      it('removes a day when its undo is queued', async () => {
        const undo = request('u', '2026-03-03', undefined, 'DELETE');
        const answer = (await answerWith(fixture, fixture, [undo], children)) as HabitBody;
        expect(answer.body.checkIns.map((row) => row.occurredOn)).toEqual([
          '2026-03-01',
          '2026-03-02',
        ]);
      });
    });
});

describe('queued recurrence completions', () => {
  const fixture = find('calendar', 'completed occurrences are drawn as done');
  it('marks a queued completion done as the recorded rule does', async () => {
    const without: Fixture = {
      ...fixture,
      items: fixture.items.map((item) =>
        item.key === 't'
          ? { ...item, recurrence: { freq: 'daily', interval: 1, completedThrough: '2026-03-03' } }
          : item,
      ),
    };
    const queued: QueuedRequest = {
      operationId: fixtureId('done'),
      itemId: fixtureId('t'),
      method: 'POST',
      path: `/api/v1/items/${fixtureId('t')}/recurrence/completions`,
      body: { occurredOn: '2026-03-05' },
    };
    expect(await answerWith(fixture, without, [queued])).toEqual(fixture.expected);
    expect(await answerWith(fixture, without, [])).not.toEqual(fixture.expected);
  });
});
