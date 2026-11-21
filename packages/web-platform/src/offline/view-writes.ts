import type { MirrorReader } from './mirror-fetch';
import type { PlannedWrite } from './mirror-writes';
import { planHabitWrite } from './view-writes/habit';
import { planRecurrenceWrite } from './view-writes/recurrence';
import { planStructureWrite } from './view-writes/structure';

/**
 * Writes made from computed views (habit check-ins, recurrence completions), planned as the
 * request itself for replay, so offline edits show in the recalculated views.
 */
export async function planViewWrite(
  store: MirrorReader,
  method: string,
  path: string,
  body: unknown,
  read: (path: string) => Promise<unknown> = () => Promise.resolve(null),
): Promise<PlannedWrite | null> {
  for (const plan of [planHabitWrite, planRecurrenceWrite, planStructureWrite]) {
    const planned = await plan(store, method, path, body, read);
    if (planned !== null) return planned;
  }
  return null;
}
