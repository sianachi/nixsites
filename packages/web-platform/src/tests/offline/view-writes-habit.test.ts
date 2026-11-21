import type { MirrorItem } from '@nix/sync-core/mirror';
import { describe, expect, it } from 'vitest';

import type { MirrorReader } from '../../offline/mirror-fetch';
import { planHabitWrite } from '../../offline/view-writes/habit';

const ID = '0192f6e0-0000-7000-8000-000000000001';
const checkIn = `/api/v1/items/${ID}/habit/check-ins/2026-03-01`;
const habit = (over: Partial<MirrorItem> = {}) =>
  ({
    id: ID,
    revision: '4',
    lifecycleState: 'active',
    locked: false,
    canWrite: true,
    ...over,
  }) as MirrorItem;
const store = (item: MirrorItem | undefined) =>
  ({
    readItems: () => Promise.resolve(item === undefined ? [] : [item]),
  }) as unknown as MirrorReader;
const view = (over: Record<string, unknown> = {}) =>
  Promise.resolve({
    status: 'active',
    timezone: 'UTC',
    occurrences: [{ scheduled: true, target: 8 }],
    ...over,
  });

describe('habit writes offline', () => {
  it('queues a check-in as the request, deriving completion from the quantity as Core does', async () => {
    const planned = await planHabitWrite(
      store(habit()),
      'PUT',
      checkIn,
      { completed: false, quantity: 9 },
      () => view(),
    );
    expect(planned).toMatchObject({
      kind: 'request',
      itemId: ID,
      method: 'PUT',
      path: checkIn,
      body: { completed: true, quantity: 9 },
      answer: { status: 200, body: { occurredOn: '2026-03-01', completed: true, quantity: 9 } },
    });
  });

  it('queues an undo without reading the habit', async () => {
    const planned = await planHabitWrite(store(habit()), 'DELETE', checkIn, undefined, () =>
      Promise.reject(new Error('not read')),
    );
    expect(planned).toMatchObject({ kind: 'request', method: 'DELETE', answer: { status: 204 } });
  });

  it.each([
    ['a paused habit', view({ status: 'paused' })],
    ['a day that is not scheduled', view({ occurrences: [{ scheduled: false, target: 8 }] })],
    ['a habit the copy cannot read', Promise.resolve(null)],
    ['a day in the future', view({ timezone: 'Pacific/Kiritimati' })],
  ])('leaves %s to Core', async (_name, answer) => {
    const path =
      _name === 'a day in the future' ? checkIn.replace('2026-03-01', '2999-01-01') : checkIn;
    expect(
      await planHabitWrite(
        store(habit()),
        'PUT',
        path,
        { completed: true, quantity: null },
        () => answer,
      ),
    ).toBeNull();
  });

  it.each([
    ['an item waiting to be created', habit({ revision: '0' })],
    ['a locked item', habit({ locked: true })],
    ['a read-only item', habit({ canWrite: false })],
    ['a missing item', undefined],
  ])('does not queue for %s', async (_name, item) => {
    expect(
      await planHabitWrite(store(item), 'DELETE', checkIn, undefined, () => view()),
    ).toBeNull();
  });

  it.each([
    ['PUT', `/api/v1/items/${ID}/habit`, { frequency: 'daily' }],
    ['PUT', `/api/v1/items/${ID}/habit/status`, { status: 'paused' }],
    ['PUT', checkIn, { completed: 'yes' }],
    ['PUT', checkIn, { completed: true, quantity: -1 }],
    ['POST', checkIn, { completed: true }],
  ])('leaves %s %s to a connection', async (method, path, body) => {
    expect(await planHabitWrite(store(habit()), method, path, body, () => view())).toBeNull();
  });
});
