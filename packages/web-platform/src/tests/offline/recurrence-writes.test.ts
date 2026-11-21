import type { MirrorItem } from '@nix/sync-core/mirror';
import { describe, expect, it } from 'vitest';

import type { MirrorReader } from '../../offline/mirror-fetch';
import { planViewWrite } from '../../offline/view-writes';

const ITEM = '0194f0aa-0000-7000-8000-000000000001';
const path = `/api/v1/items/${ITEM}/recurrence/completions`;
const task = (over: Partial<MirrorItem> = {}) =>
  ({
    id: ITEM,
    revision: '3',
    lifecycleState: 'active',
    locked: false,
    canWrite: true,
    recurrence: {
      freq: 'daily',
      interval: 1,
      completedThrough: '2026-03-01',
      completed: ['2026-03-04'],
    },
    ...over,
  }) as MirrorItem;
const store = (item: MirrorItem | undefined) =>
  ({
    readItems: () => Promise.resolve(item === undefined ? [] : [item]),
  }) as unknown as MirrorReader;

describe('offline recurrence writes', () => {
  it('queues a completion as the request and answers with the rule it leaves', async () => {
    const planned = await planViewWrite(store(task()), 'POST', path, { occurredOn: '2026-03-02' });
    expect(planned).toMatchObject({
      kind: 'request',
      itemId: ITEM,
      method: 'POST',
      path,
      body: { occurredOn: '2026-03-02' },
      answer: {
        status: 200,
        body: {
          occurredOn: '2026-03-02',
          rule: {
            freq: 'daily',
            completedThrough: '2026-03-01',
            completed: ['2026-03-02', '2026-03-04'],
          },
        },
      },
    });
  });

  it.each([
    ['an item with no rule', task({ recurrence: null })],
    ['an item waiting to be created', task({ revision: '0' })],
    ['a locked item', task({ locked: true })],
    ['a missing item', undefined],
  ])('does not queue for %s', async (_name, item) => {
    expect(await planViewWrite(store(item), 'POST', path, { occurredOn: '2026-03-02' })).toBeNull();
  });

  it('leaves a malformed day and setting a rule to a connection', async () => {
    expect(await planViewWrite(store(task()), 'POST', path, { occurredOn: 'soon' })).toBeNull();
    expect(
      await planViewWrite(store(task()), 'PUT', `/api/v1/items/${ITEM}/recurrence`, {
        freq: 'daily',
        interval: 1,
      }),
    ).toBeNull();
  });
});
