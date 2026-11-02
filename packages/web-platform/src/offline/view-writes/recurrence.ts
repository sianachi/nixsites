import type { MirrorReader } from '../mirror-fetch';
import type { PlannedWrite } from '../mirror-writes';

type PlanViewWrite = (
  store: MirrorReader,
  method: string,
  path: string,
  body: unknown,
) => Promise<PlannedWrite | null>;

/**
 * Offline recurrence writes as queued item writes; null when this one needs a connection.
 *
 * shortcut: a completion rewrites the item's `recurrence` column (the rule's `completed` list and
 * `completedThrough` watermark), which is not a property, and the replay outbox has no operation
 * that carries it, so every recurrence write stays online-only. Upgrade by adding a
 * `recurrence-complete { itemId, occurredOn }` operation to the outbox and Core's replay endpoint.
 */
export const planRecurrenceWrite: PlanViewWrite = () => Promise.resolve(null);
