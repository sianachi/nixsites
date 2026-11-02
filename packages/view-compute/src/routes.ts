import { computeCalendar } from './calendar';
import { computeChart } from './chart';
import { computeFinance } from './finance';
import { computeHabit } from './habit';
import { computeQuery } from './query';
import type { ViewRoute } from './types';

const ID = '([0-9a-fA-F-]{36})';

/** Core's computed reads, matched on the path (query string excluded). One owner per line. */
export const routes: readonly ViewRoute[] = [
  { method: 'GET', pattern: new RegExp(`^/api/v1/items/${ID}/query$`), compute: computeQuery },
  {
    method: 'POST',
    pattern: new RegExp(`^/api/v1/workspaces/${ID}/query(/aggregate)?$`),
    compute: computeQuery,
  },
  { method: 'GET', pattern: new RegExp(`^/api/v1/items/${ID}/chart$`), compute: computeChart },
  {
    method: 'GET',
    pattern: new RegExp(`^/api/v1/workspaces/${ID}/calendar$`),
    compute: computeCalendar,
  },
  { method: 'GET', pattern: new RegExp(`^/api/v1/items/${ID}/habit$`), compute: computeHabit },
  {
    method: 'GET',
    pattern: new RegExp(`^/api/v1/items/${ID}/finance(/.*)?$`),
    compute: computeFinance,
  },
];
