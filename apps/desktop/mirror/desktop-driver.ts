import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { createWebkitSqliteDriver } from '../../../packages/sync-sqlite/src/webkit-driver.js';
import type { SqliteDriver } from '../../../packages/sync-sqlite/src/driver.js';
// @ts-expect-error plain .mjs without types
import { SqlStores } from '../src/sql-store.mjs';

/**
 * Stands in for `createNodeSqliteDriver` when the sync-sqlite suites run through the desktop store:
 * the same mirror code, but every statement goes through `nixStore` requests into `SqlStores`.
 * Each database path gets its own origin and base directory, so reopening a path reopens its file.
 */
export function createNodeSqliteDriver(path: string): SqliteDriver {
  const origin = `http://${createHash('sha256').update(path).digest('hex').slice(0, 16)}.localhost`;
  const stores = new SqlStores({ baseDir: dirname(path) });
  return createWebkitSqliteDriver((request) => stores.handle(origin, request));
}
