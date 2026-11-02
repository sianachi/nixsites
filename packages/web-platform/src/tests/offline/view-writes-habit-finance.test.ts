import { describe, expect, it } from 'vitest';

import type { MirrorReader } from '../../offline/mirror-fetch';
import { planFinanceWrite } from '../../offline/view-writes/finance';
import { planHabitWrite } from '../../offline/view-writes/habit';

const ID = '0192f6e0-0000-7000-8000-000000000001';
const OTHER = '0192f6e0-0000-7000-8000-000000000002';
// Neither planner reads the mirror: a write it cannot queue safely never touches it.
const store = {} as MirrorReader;

describe('habit and finance writes offline', () => {
  const habit: [string, string, unknown][] = [
    ['PUT', `/api/v1/items/${ID}/habit/check-ins/2026-03-01`, { completed: true, quantity: null }],
    ['DELETE', `/api/v1/items/${ID}/habit/check-ins/2026-03-01`, undefined],
    ['PUT', `/api/v1/items/${ID}/habit`, { frequency: 'daily' }],
    ['PUT', `/api/v1/items/${ID}/habit/status`, { status: 'paused' }],
  ];
  const finance: [string, string, unknown][] = [
    ['POST', `/api/v1/items/${ID}/finance/transactions`, { description: 'Tea', amount: -2 }],
    ['PUT', `/api/v1/items/${ID}/finance/transactions/${OTHER}`, { description: 'Tea' }],
    ['DELETE', `/api/v1/items/${ID}/finance/transactions/${OTHER}`, undefined],
    ['POST', `/api/v1/items/${ID}/finance/accounts`, { name: 'Bank' }],
    ['PUT', `/api/v1/items/${ID}/finance/accounts/${OTHER}`, { name: 'Bank' }],
    ['POST', `/api/v1/items/${ID}/finance/lines`, { name: 'Rent' }],
    ['PUT', `/api/v1/items/${ID}/finance/lines/${OTHER}`, { name: 'Rent' }],
    ['POST', `/api/v1/items/${ID}/finance/lines/${OTHER}/months/2026-03/actual`, { amount: 5 }],
    ['PUT', `/api/v1/items/${ID}/finance/months/2026-03`, { closed: true }],
    ['PUT', `/api/v1/items/${ID}/finance`, { currency: 'GBP' }],
  ];

  it.each(habit)(
    'leaves habit %s %s to a connection: the item write would be refused on replay',
    async (method, path, body) => {
      expect(await planHabitWrite(store, method, path, body)).toBeNull();
    },
  );

  it.each(finance)(
    'leaves finance %s %s to a connection: the item write would be refused on replay',
    async (method, path, body) => {
      expect(await planFinanceWrite(store, method, path, body)).toBeNull();
    },
  );
});
