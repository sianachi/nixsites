import type { MirrorReader } from '../mirror-fetch';
import type { PlannedWrite } from '../mirror-writes';

type PlanViewWrite = (
  store: MirrorReader,
  method: string,
  path: string,
  body: unknown,
) => Promise<PlannedWrite | null>;

/**
 * Offline habit writes (check-in PUT/DELETE, settings and status PUT) all need a connection.
 *
 * Core's handlers write child items and property sets, but only under the reserved `$habit_`
 * keys, which `CreateItem` and `SetItemProperties` refuse unless the habit handler itself
 * dispatches them (`HabitWrite`). The replay endpoint takes the plain create/rename/move/
 * archive/properties kinds, so a queued item write carrying a `$habit_` key would be refused on
 * reconnect after the phone had already shown it as done. Queuing the original habit request
 * needs a new outbox kind (see the lane report); until it exists, null is the honest answer.
 */
export const planHabitWrite: PlanViewWrite = () => Promise.resolve(null);
