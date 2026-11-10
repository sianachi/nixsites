import type { MirrorReader } from './mirror-fetch';
import type { PlannedWrite } from './mirror-writes';
import { planHabitWrite } from './view-writes/habit';
import { planRecurrenceWrite } from './view-writes/recurrence';

/**
 * Writes made from computed views (habit check-ins, recurrence completions),
 * planned as the item writes Core would make, so offline edits show in the recalculated views.
 */
export async function planViewWrite(
  store: MirrorReader,
  method: string,
  path: string,
  body: unknown,
): Promise<PlannedWrite | null> {
  for (const plan of [planHabitWrite, planRecurrenceWrite]) {
    const planned = await plan(store, method, path, body);
    if (planned !== null) return planned;
  }
  return null;
}
