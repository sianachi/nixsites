import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, constants } from 'node:sqlite';

// The SQL half of apps/mobile/ios/NixStore. The caller has already bound `origin` to the frame that
// sent the request. In the app this runs in its own process (sql-host.mjs), which is what lets a
// runaway query be killed: nothing can interrupt SQLite from inside the process running it.

const IDLE_TIMEOUT_MS = 30_000;
/** Rows between yields in a batch, so the process's heartbeat keeps running through a long one. */
const BATCH_YIELD_ROWS = 256;

/** Pragmas the page's SQL may run (packages/sync-sqlite opens with these); every other is refused. */
const PAGE_PRAGMAS = new Set(['foreign_keys', 'journal_mode', 'synchronous', 'secure_delete']);

export class StoreError extends Error {}

export const storeId = (origin) => createHash('sha256').update(origin).digest('hex');
export const DATABASE_SUFFIXES = ['', '-wal', '-shm', '-journal'];
export const databasePath = (baseDir, origin) => join(baseDir, `${storeId(origin)}.sqlite`);

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function fromWire(value) {
  if (value === null || typeof value === 'string') return value;
  // node:sqlite binds every JS number as a double; an untyped column would then hold 42.0.
  if (typeof value === 'number') return Number.isSafeInteger(value) ? BigInt(value) : value;
  if (typeof value === 'boolean') return value ? 1n : 0n;
  if (
    typeof value === 'object' &&
    Object.keys(value).length === 1 &&
    typeof value.$b64 === 'string'
  ) {
    if (!BASE64.test(value.$b64)) throw new StoreError('Bad blob value.');
    return Buffer.from(value.$b64, 'base64');
  }
  throw new StoreError('Unsupported parameter type.');
}

function toWire(value) {
  if (typeof value === 'bigint') return Number(value);
  if (value instanceof Uint8Array) return { $b64: Buffer.from(value).toString('base64') };
  return value;
}

function values(list) {
  if (list === undefined) return [];
  if (!Array.isArray(list)) throw new StoreError('params must be an array.');
  return list.map(fromWire);
}

/** One origin's database. */
class SqlStore {
  #db = null;
  #pageSql = false;
  #activeTx = null;
  #idleTimer = null;
  #waiters = [];
  #wipes = 0;
  #baseDir;
  #path;
  #idleTimeoutMs;

  constructor(origin, { baseDir, idleTimeoutMs }) {
    this.#baseDir = baseDir;
    this.#path = databasePath(baseDir, origin);
    this.#idleTimeoutMs = idleTimeoutMs;
  }

  #open() {
    if (this.#db !== null) return this.#db;
    // Only this person's account can read the store; synced content is not encrypted beyond that.
    mkdirSync(this.#baseDir, { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(this.#path, { defensive: true });
    try {
      // Another origin's database is a file next to this one.
      db.limits.attach = 0;
      db.setAuthorizer((action, first) => {
        // Checked while stepping too: VACUUM INTO attaches its target then, outside the prepare
        // gate, and `SELECT * FROM pragma_database_list` compiles its pragma then, showing the path.
        if (action === constants.SQLITE_ATTACH || action === constants.SQLITE_DETACH)
          return constants.SQLITE_DENY;
        if (action === constants.SQLITE_PRAGMA && first?.toLowerCase() === 'database_list')
          return constants.SQLITE_DENY;
        // Only preparing is the page's SQL: what SQLite runs while stepping (FTS5's own statements,
        // which read PRAGMA data_version) is SQLite's, and the gate must not refuse it.
        if (!this.#pageSql) return constants.SQLITE_OK;
        // The store's begin/commit gate owns transactions.
        if (action === constants.SQLITE_TRANSACTION || action === constants.SQLITE_SAVEPOINT)
          return constants.SQLITE_DENY;
        if (action === constants.SQLITE_PRAGMA && !PAGE_PRAGMAS.has(first?.toLowerCase()))
          return constants.SQLITE_DENY;
        return constants.SQLITE_OK;
      });
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA foreign_keys = ON');
    } catch (error) {
      db.close();
      throw error;
    }
    this.#db = db;
    return db;
  }

  /** SQLite may have ended the transaction itself (INSERT OR ROLLBACK, RAISE(ROLLBACK), a full disk). */
  #rollbackIfOpen() {
    if (this.#db?.isTransaction === true) this.#db.exec('ROLLBACK');
  }

  #query(sql, params) {
    const db = this.#open();
    let statement;
    this.#pageSql = true;
    try {
      statement = db.prepare(sql);
    } finally {
      this.#pageSql = false;
    }
    // node:sqlite silently drops everything after the first statement, and has no way to count its
    // parameters, so several in one request are refused rather than half-run.
    if (sql.slice(statement.sourceSQL.length).trim() !== '')
      throw new StoreError('One statement per request.');
    statement.setReadBigInts(true);
    return statement
      .all(...params)
      .map((row) =>
        Object.fromEntries(Object.entries(row).map(([key, cell]) => [key, toWire(cell)])),
      );
  }

  async #awaitGateFree() {
    const wipes = this.#wipes;
    while (this.#activeTx !== null) await new Promise((resume) => this.#waiters.push(resume));
    // A statement queued before a wipe must not recreate what the wipe removed.
    if (wipes !== this.#wipes) throw new StoreError('The offline copy was removed.');
  }

  #releaseGate() {
    clearTimeout(this.#idleTimer);
    this.#activeTx = null;
    const pending = this.#waiters;
    this.#waiters = [];
    for (const resume of pending) resume();
  }

  #armIdleTimer() {
    clearTimeout(this.#idleTimer);
    this.#idleTimer = setTimeout(() => {
      this.#rollbackIfOpen();
      this.#releaseGate();
    }, this.#idleTimeoutMs);
    this.#idleTimer.unref();
  }

  #requireTx(tx) {
    if (tx !== this.#activeTx)
      throw new StoreError('Transaction is not open (it may have timed out).');
  }

  async begin() {
    await this.#awaitGateFree();
    this.#open().exec('BEGIN IMMEDIATE');
    this.#activeTx = randomUUID();
    this.#armIdleTimer();
    return this.#activeTx;
  }

  commit(tx) {
    this.#requireTx(tx);
    try {
      this.#open().exec('COMMIT');
    } catch (error) {
      this.#rollbackIfOpen();
      throw error;
    } finally {
      this.#releaseGate();
    }
  }

  rollback(tx) {
    this.#requireTx(tx);
    try {
      this.#rollbackIfOpen();
    } finally {
      this.#releaseGate();
    }
  }

  async execute(sql, params, tx) {
    if (tx !== undefined) {
      this.#requireTx(tx);
      this.#armIdleTimer();
    } else {
      await this.#awaitGateFree();
    }
    return this.#query(sql, params);
  }

  /** Each statement once per parameter row, all in one transaction; any failure rolls back all. */
  async batch(statements) {
    const tx = await this.begin();
    try {
      let rows = 0;
      for (const { sql, params } of statements)
        for (const row of params) {
          await this.execute(sql, row, tx);
          rows += 1;
          if (rows % BATCH_YIELD_ROWS === 0)
            await new Promise((resume) => {
              setImmediate(resume);
            });
        }
      this.commit(tx);
    } catch (error) {
      if (this.#activeTx === tx) this.rollback(tx);
      throw error;
    }
  }

  close() {
    this.#rollbackIfOpen();
    this.#db?.close();
    this.#db = null;
    this.#releaseGate();
  }

  /** Closes the database and deletes it. Throws if anything remains, so the caller can keep admission closed. */
  wipe() {
    this.#wipes += 1;
    this.close();
    try {
      for (const suffix of DATABASE_SUFFIXES) rmSync(this.#path + suffix, { force: true });
    } catch {
      throw new StoreError('Could not delete local data.');
    }
  }
}

/** The per-origin databases and the SQL half of the `nixStore` protocol. */
export class SqlStores {
  #stores = new Map();
  #options;

  constructor({ baseDir, idleTimeoutMs = IDLE_TIMEOUT_MS }) {
    this.#options = { baseDir, idleTimeoutMs };
  }

  #store(origin) {
    let store = this.#stores.get(origin);
    if (store === undefined) {
      store = new SqlStore(origin, this.#options);
      this.#stores.set(origin, store);
    }
    return store;
  }

  closeAll() {
    for (const store of this.#stores.values()) store.close();
  }

  async handle(origin, request) {
    const string = (key) => {
      const value = request[key];
      if (typeof value !== 'string' || value === '') throw new StoreError(`Missing ${key}.`);
      return value;
    };
    const store = this.#store(origin);
    switch (request.op) {
      case 'begin':
        return { tx: await store.begin() };
      case 'execute':
        return {
          rows: await store.execute(
            string('sql'),
            values(request.params),
            typeof request.tx === 'string' ? request.tx : undefined,
          ),
        };
      case 'commit':
        store.commit(string('tx'));
        return {};
      case 'rollback':
        store.rollback(string('tx'));
        return {};
      case 'batch': {
        if (!Array.isArray(request.statements)) throw new StoreError('Missing statements.');
        await store.batch(
          request.statements.map(({ sql, params }) => {
            if (typeof sql !== 'string' || !Array.isArray(params))
              throw new StoreError('Bad statement.');
            return { sql, params: params.map(values) };
          }),
        );
        return {};
      }
      case 'wipe':
        store.wipe();
        return {};
      default:
        throw new StoreError('Unknown op.');
    }
  }
}
