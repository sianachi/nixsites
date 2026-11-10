import { describe, expect, it } from 'vitest';

import type { MirrorReader } from '../../offline/mirror-fetch';
import { planHabitWrite } from '../../offline/view-writes/habit';

const ID = '0192f6e0-0000-7000-8000-000000000001';
// Neither planner reads the mirror: a write it cannot queue safely never touches it.
const store = {} as MirrorReader;

describe('habit writes offline', () => {
  const habit: [string, string, unknown][] = [
    ['PUT', `/api/v1/items/${ID}/habit/check-ins/2026-03-01`, { completed: true, quantity: null }],
    ['DELETE', `/api/v1/items/${ID}/habit/check-ins/2026-03-01`, undefined],
    ['PUT', `/api/v1/items/${ID}/habit`, { frequency: 'daily' }],
    ['PUT', `/api/v1/items/${ID}/habit/status`, { status: 'paused' }],
  ];
  it.each(habit)(
    'leaves habit %s %s to a connection: the item write would be refused on replay',
    async (method, path, body) => {
      expect(await planHabitWrite(store, method, path, body)).toBeNull();
    },
  );
});
