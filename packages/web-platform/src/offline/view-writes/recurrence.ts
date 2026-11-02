import type { MirrorReader } from '../mirror-fetch';
import type { PlannedWrite } from '../mirror-writes';

type PlanViewWrite = (
  store: MirrorReader,
  method: string,
  path: string,
  body: unknown,
) => Promise<PlannedWrite | null>;

/** Offline recurrence writes as queued item writes; null when this one needs a connection. */
export const planRecurrenceWrite: PlanViewWrite = () => Promise.resolve(null);
