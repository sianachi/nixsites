import type { Role } from './roles.ts';

export interface Running {
  stop: () => Promise<void>;
}

export type Starters = Record<Role, () => Promise<Running>>;

/** Time every started role gets to stop before the process exits anyway. */
export const SHUTDOWN_BUDGET_MS = 10_000;

/**
 * Stops every role at once and waits for all of them to settle, so one rejected or hung stop
 * never leaves a sibling running. Resolves to the failures; a role past the budget counts as one.
 */
export async function stopAll(
  running: Running[],
  budgetMs: number = SHUTDOWN_BUDGET_MS,
): Promise<unknown[]> {
  let timer: NodeJS.Timeout | undefined;
  const budget = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), budgetMs);
  });
  const settled = Promise.allSettled(running.map((role) => role.stop()));
  const outcome = await Promise.race([settled, budget]);
  clearTimeout(timer);
  if (outcome === 'timeout') return [new Error(`Roles did not stop within ${budgetMs} ms.`)];
  return outcome.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
}

/** Starts roles in order; when one fails, stops the ones already started, then rethrows. */
export async function startRoles(
  roles: Role[],
  starters: Starters,
  budgetMs?: number,
): Promise<Running[]> {
  const running: Running[] = [];
  try {
    for (const role of roles) running.push(await starters[role]());
  } catch (cause) {
    await stopAll(running, budgetMs);
    throw cause;
  }
  return running;
}

/** Local readiness route for each role; collab has no dependency probe, so it uses liveness. */
export const READINESS_PATHS: Record<Role, { port: number; path: string }> = {
  collab: { port: 8100, path: '/healthz' },
  companion: { port: 8302, path: '/readyz' },
  'sites-worker': { port: 8301, path: '/readyz' },
};

/** True when every configured role answers its readiness route with a 2xx. */
export async function rolesReady(
  roles: Role[],
  probe: (role: Role) => Promise<boolean>,
): Promise<boolean> {
  const results = await Promise.all(roles.map((role) => probe(role).catch(() => false)));
  return results.every(Boolean);
}
