import type { MirrorReader } from '../mirror-fetch';
import type { PlannedWrite } from '../mirror-writes';

type PlanViewWrite = (
  store: MirrorReader,
  method: string,
  path: string,
  body: unknown,
) => Promise<PlannedWrite | null>;

/**
 * Offline finance writes (transactions, accounts, lines, actuals, months, settings) all need a
 * connection.
 *
 * Every finance record is an item whose properties live under the reserved `$fin_` keys, which
 * `CreateItem`, `SetItemProperties` and `RenameItem` refuse unless the finance handler dispatches
 * them (`FinanceWrite`). It also validates against the whole book under the root's lock (closed
 * months, ceilings, account/line ownership, the "actual" adjustment transaction), which the
 * replay endpoint does not run. A queued item write would be refused on reconnect after the phone
 * had shown it as saved, so the original request has to be queued instead (a new outbox kind, see
 * the lane report); until it exists, null is the honest answer.
 */
export const planFinanceWrite: PlanViewWrite = () => Promise.resolve(null);
