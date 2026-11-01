import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  createWebkitSqliteDriver,
  fileDelete,
  fileDownload,
  fileGet,
  usage,
  wipe,
  windowNixStorePost,
  type NixStorePost,
} from './webkit-driver.js';

type Wire = null | number | string | { $b64: string };
const dec = (v: Wire): null | number | string | Uint8Array =>
  v !== null && typeof v === 'object' ? new Uint8Array(Buffer.from(v.$b64, 'base64')) : v;
const enc = (v: unknown): Wire =>
  v instanceof Uint8Array ? { $b64: Buffer.from(v).toString('base64') } : (v as Wire);

/** A fake native handler backed by node:sqlite that follows the protocol table. */
function fakeNative() {
  const db = new DatabaseSync(':memory:');
  const log: string[] = [];
  let tx: string | null = null;
  const post: NixStorePost = (request) => {
    log.push(request.op);
    switch (request.op) {
      case 'begin':
        tx = 'tx1';
        db.exec('BEGIN');
        return Promise.resolve({ tx });
      case 'execute': {
        if (request.tx !== undefined && request.tx !== tx)
          return Promise.reject(new Error('unknown transaction'));
        try {
          const rows = db
            .prepare(request.sql)
            .all(...((request.params ?? []).map(dec) as never[]))
            .map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, enc(v)])));
          return Promise.resolve({ rows });
        } catch (error) {
          return Promise.reject(new Error(String(error))); // native error string
        }
      }
      case 'commit':
        db.exec('COMMIT');
        tx = null;
        return Promise.resolve({});
      case 'rollback':
        db.exec('ROLLBACK');
        tx = null;
        return Promise.resolve({});
      case 'batch':
        for (const s of request.statements)
          for (const row of s.params) db.prepare(s.sql).run(...(row.map(dec) as never[]));
        return Promise.resolve({});
      case 'fileDownload':
        return Promise.resolve({ bytes: 42 });
      case 'fileGet':
        return Promise.resolve({ data: request.key === 'hit' ? 'AQID' : null });
      case 'usage':
        return Promise.resolve({ databaseBytes: 1, fileBytes: 2 });
      default:
        return Promise.resolve({});
    }
  };
  return { post, log, db };
}

describe('webkit nixStore driver', () => {
  it('round-trips blobs and plain values through execute and batch', async () => {
    const { post } = fakeNative();
    const c = createWebkitSqliteDriver(post).open();
    await c.execute('CREATE TABLE t (id INTEGER, name TEXT, data BLOB)');
    await c.executeBatch([
      {
        sql: 'INSERT INTO t VALUES (?,?,?)',
        parameters: [
          [1, 'a', new Uint8Array([0, 255, 7])],
          [2, null, new Uint8Array(0)],
        ],
      },
    ]);
    const rows = await c.execute('SELECT * FROM t ORDER BY id');
    expect(rows[0]).toEqual({ id: 1, name: 'a', data: new Uint8Array([0, 255, 7]) });
    expect(rows[1]).toMatchObject({ id: 2, name: null });
  });

  it('commits a transaction and tags its executes with the tx id', async () => {
    const { post, log } = fakeNative();
    const c = createWebkitSqliteDriver(post).open();
    await c.execute('CREATE TABLE t (id INTEGER)');
    const sent: unknown[] = [];
    const spy: NixStorePost = (r) => (sent.push(r), post(r));
    const c2 = createWebkitSqliteDriver(spy).open();
    const out = await c2.transaction(async (tx) => {
      await tx.execute('INSERT INTO t VALUES (1)');
      return 'done';
    });
    expect(out).toBe('done');
    expect(sent).toMatchObject([
      { op: 'begin' },
      { op: 'execute', tx: 'tx1' },
      { op: 'commit', tx: 'tx1' },
    ]);
    expect(log.at(-1)).toBe('commit');
    expect(await c.execute('SELECT count(*) AS n FROM t')).toEqual([{ n: 1 }]);
  });

  it('rolls back and rethrows when the work throws', async () => {
    const { post, log } = fakeNative();
    const c = createWebkitSqliteDriver(post).open();
    await c.execute('CREATE TABLE t (id INTEGER)');
    await expect(
      c.transaction(async (tx) => {
        await tx.execute('INSERT INTO t VALUES (1)');
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(log.at(-1)).toBe('rollback');
    expect(await c.execute('SELECT count(*) AS n FROM t')).toEqual([{ n: 0 }]);
  });

  it('surfaces a rejected reply as an Error', async () => {
    const c = createWebkitSqliteDriver(() => Promise.reject(new Error('refused'))).open();
    await expect(c.execute('SELECT 1')).rejects.toThrow('refused');
    await expect(c.transaction(() => Promise.resolve(1))).rejects.toThrow('refused');
  });

  it('wraps a non-Error rejection from the real handler into an Error', async () => {
    (globalThis as { webkit?: unknown }).webkit = {
      messageHandlers: {
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- WebKit rejects with a string
        nixStore: { postMessage: () => Promise.reject('origin not allowed') },
      },
    };
    try {
      await expect(windowNixStorePost()({ op: 'usage' })).rejects.toThrow('origin not allowed');
    } finally {
      delete (globalThis as { webkit?: unknown }).webkit;
    }
    expect(() => windowNixStorePost()).toThrow('not available');
  });

  it('exposes typed file helpers', async () => {
    const { post } = fakeNative();
    expect(await fileDownload('k', 'https://x/y', post)).toBe(42);
    expect(await fileGet('hit', post)).toEqual(new Uint8Array([1, 2, 3]));
    expect(await fileGet('miss', post)).toBeNull();
    expect(await usage(post)).toEqual({ databaseBytes: 1, fileBytes: 2 });
    await fileDelete('k', post);
    await wipe(post);
  });
});
