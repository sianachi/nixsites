import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { Stores } from '../src/store.mjs';

// Addresses for the fake hosts below; the names that say so answer as private networks do.
const ADDRESSES = {
  'intranet.example': ['10.0.0.5'],
  'mixed.example': ['93.184.216.34', '192.168.1.1'],
  'lan.example': ['192.168.1.20'],
  's3.lan.example': ['192.168.1.21'],
};
const resolveHost = async (host) => ADDRESSES[host] ?? ['93.184.216.34'];
const A = 'https://a.example';
const B = 'https://b.example';
let dir;
let opened;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nix-desktop-store-'));
  opened = [];
});
afterEach(() => {
  for (const stores of opened) stores.close();
  rmSync(dir, { recursive: true, force: true });
});

function open(options = {}) {
  const stores = new Stores({ baseDir: dir, resolveHost, ...options });
  opened.push(stores);
  return stores;
}
const sql = (stores, text, params, origin = A, tx) =>
  stores.handle(origin, { op: 'execute', sql: text, params, ...(tx === undefined ? {} : { tx }) });
const rows = async (stores, text, params, origin) => (await sql(stores, text, params, origin)).rows;

test('values round trip, integers stay integers and blobs stay base64', async () => {
  const stores = open();
  await sql(stores, 'CREATE TABLE t(a, b, c, d, e)');
  const blob = Buffer.from([0, 1, 2, 255]).toString('base64');
  await sql(stores, 'INSERT INTO t VALUES (?,?,?,?,?)', [null, 42, 1.5, 'héllo', { $b64: blob }]);
  const [row] = await rows(
    stores,
    "SELECT a, b, c, d, e, typeof(b) AS kind, b || '' AS text FROM t",
  );
  assert.deepEqual(
    { ...row },
    {
      a: null,
      b: 42,
      c: 1.5,
      d: 'héllo',
      e: { $b64: blob },
      kind: 'integer',
      text: '42',
    },
  );
});

test('a value too large for a double does not throw', async () => {
  const [{ n }] = await rows(open(), 'SELECT 9007199254740993 AS n');
  assert.equal(typeof n, 'number');
});

test('bad parameters and blobs are refused', async () => {
  const stores = open();
  await assert.rejects(sql(stores, 'SELECT ?', [{ $b64: 'not base64!' }]), /Bad blob/);
  await assert.rejects(sql(stores, 'SELECT ?', [{ other: 1 }]), /Unsupported/);
  await assert.rejects(sql(stores, 'SELECT ?', 'x'), /must be an array/);
  await assert.rejects(stores.handle(A, { op: 'nope' }), /Unknown op/);
  await assert.rejects(stores.handle(A, null), /Bad request/);
});

test('two statements in one request are refused, not half run', async () => {
  const stores = open();
  await sql(stores, 'CREATE TABLE t(a);');
  await assert.rejects(
    sql(stores, 'INSERT INTO t VALUES (1); INSERT INTO t VALUES (2)'),
    /One statement/,
  );
  assert.equal((await rows(stores, 'SELECT count(*) AS n FROM t'))[0].n, 0);
  // A trigger's body is one statement.
  await sql(
    stores,
    'CREATE TRIGGER g AFTER INSERT ON t BEGIN DELETE FROM t WHERE a=0; SELECT 1; END',
  );
});

for (const [name, text] of [
  ['ATTACH', "ATTACH ':memory:' AS other"],
  ['DETACH', 'DETACH other'],
  ['VACUUM INTO', 'VACUUM INTO'],
  ['BEGIN', 'BEGIN'],
  ['COMMIT', 'COMMIT'],
  ['ROLLBACK', 'ROLLBACK'],
  ['SAVEPOINT', 'SAVEPOINT x'],
  ['a pragma outside the list', 'PRAGMA writable_schema=ON'],
  ['PRAGMA database_list', 'PRAGMA database_list'],
]) {
  test(`the page cannot run ${name}`, async () => {
    const stores = open();
    await sql(stores, 'CREATE TABLE t(a)');
    const target = join(dir, 'stolen.db');
    const statement = name === 'VACUUM INTO' ? `VACUUM INTO '${target}'` : text;
    await assert.rejects(sql(stores, statement));
    assert.equal(existsSync(target), false);
  });
}

test('the page can reach neither another origin nor write FTS5 shadow tables', async () => {
  const stores = open();
  await sql(stores, 'CREATE TABLE secret(a)', undefined, B);
  await sql(stores, "INSERT INTO secret VALUES ('b')", undefined, B);
  await assert.rejects(rows(stores, 'SELECT * FROM secret'), /no such table/);
  await sql(stores, 'CREATE VIRTUAL TABLE f USING fts5(a)');
  await assert.rejects(sql(stores, "INSERT INTO f_data VALUES (99, x'00')"));
});

test('the pragmas the mirror opens with run, and FTS5 works behind the gate', async () => {
  const stores = open();
  for (const pragma of [
    'foreign_keys=ON',
    'journal_mode=WAL',
    'synchronous=FULL',
    'secure_delete=ON',
  ])
    await sql(stores, `PRAGMA ${pragma}`);
  await sql(stores, 'CREATE VIRTUAL TABLE f USING fts5(item_id UNINDEXED, body)');
  const { tx } = await stores.handle(A, { op: 'begin' });
  await sql(stores, 'INSERT INTO f VALUES (?, ?)', ['1', 'hello world'], A, tx);
  await stores.handle(A, { op: 'commit', tx });
  await sql(stores, 'DROP TABLE IF EXISTS none');
  const found = await rows(stores, 'SELECT item_id FROM f WHERE f MATCH ?', ['hello']);
  assert.deepEqual(
    found.map((row) => row.item_id),
    ['1'],
  );
});

test('transactions commit, roll back and refuse a stale id', async () => {
  const stores = open();
  await sql(stores, 'CREATE TABLE t(a)');
  const first = (await stores.handle(A, { op: 'begin' })).tx;
  await sql(stores, 'INSERT INTO t VALUES (1)', undefined, A, first);
  await stores.handle(A, { op: 'rollback', tx: first });
  assert.equal((await rows(stores, 'SELECT count(*) AS n FROM t'))[0].n, 0);
  await assert.rejects(sql(stores, 'SELECT 1', undefined, A, first), /not open/);
  const second = (await stores.handle(A, { op: 'begin' })).tx;
  await sql(stores, 'INSERT INTO t VALUES (2)', undefined, A, second);
  await stores.handle(A, { op: 'commit', tx: second });
  assert.equal((await rows(stores, 'SELECT count(*) AS n FROM t'))[0].n, 1);
});

test('requests without the transaction wait for it, in order', async () => {
  const stores = open();
  await sql(stores, 'CREATE TABLE t(a)');
  const { tx } = await stores.handle(A, { op: 'begin' });
  let readerSaw = null;
  const reader = rows(stores, 'SELECT count(*) AS n FROM t').then(([{ n }]) => {
    readerSaw = n;
  });
  await sql(stores, 'INSERT INTO t VALUES (1)', undefined, A, tx);
  await new Promise((resolve) => {
    setTimeout(resolve, 20);
  });
  assert.equal(readerSaw, null);
  await stores.handle(A, { op: 'commit', tx });
  await reader;
  assert.equal(readerSaw, 1);
});

test('an idle transaction rolls back and frees the gate', async () => {
  const stores = open({ idleTimeoutMs: 30 });
  await sql(stores, 'CREATE TABLE t(a)');
  const { tx } = await stores.handle(A, { op: 'begin' });
  await sql(stores, 'INSERT INTO t VALUES (1)', undefined, A, tx);
  assert.equal((await rows(stores, 'SELECT count(*) AS n FROM t'))[0].n, 0);
  await assert.rejects(stores.handle(A, { op: 'commit', tx }), /not open/);
});

test('a failed batch rolls back everything', async () => {
  const stores = open();
  await sql(stores, 'CREATE TABLE t(a UNIQUE)');
  await assert.rejects(
    stores.handle(A, {
      op: 'batch',
      statements: [{ sql: 'INSERT INTO t VALUES (?)', params: [[1], [2], [1]] }],
    }),
  );
  assert.equal((await rows(stores, 'SELECT count(*) AS n FROM t'))[0].n, 0);
  await stores.handle(A, {
    op: 'batch',
    statements: [{ sql: 'INSERT INTO t VALUES (?)', params: [[1], [2]] }],
  });
  assert.equal((await rows(stores, 'SELECT count(*) AS n FROM t'))[0].n, 2);
});

const served = (body, init) => new Response(body, init);

test('a download stores the bytes, reports the digest and is reused', async () => {
  let calls = 0;
  let seen;
  const stores = open({
    fetch: (url, init) => {
      calls += 1;
      seen = init;
      return Promise.resolve(served('hello'));
    },
  });
  const expected = createHash('sha256').update('hello').digest('hex');
  const stored = await stores.handle(A, {
    op: 'fileDownload',
    key: 'k',
    url: 'https://s3.example/x',
  });
  assert.deepEqual(stored, { bytes: 5, sha256: expected });
  assert.equal(seen.credentials, 'omit');
  assert.deepEqual(
    await stores.handle(A, { op: 'fileDownload', key: 'k', url: 'https://s3.example/x' }),
    stored,
  );
  assert.equal(calls, 1);
  const { data } = await stores.handle(A, { op: 'fileGet', key: 'k' });
  assert.equal(Buffer.from(data, 'base64').toString(), 'hello');
  assert.equal((await stores.handle(A, { op: 'usage' })).fileBytes, 5);
  await stores.handle(A, { op: 'fileDelete', key: 'k' });
  assert.deepEqual(await stores.handle(A, { op: 'fileGet', key: 'k' }), { data: null });
  assert.deepEqual(await stores.handle(B, { op: 'fileGet', key: 'k' }), { data: null });
});

test('downloads refuse plain http, except a local server to its local object store', async () => {
  const fetch = () => Promise.resolve(served('x'));
  const stores = open({ fetch });
  await assert.rejects(
    stores.handle(A, { op: 'fileDownload', key: 'k', url: 'http://s3.example/x' }),
    /https/,
  );
  await assert.rejects(
    stores.handle(A, { op: 'fileDownload', key: 'k', url: 'http://localhost/x' }),
    /https/,
  );
  await assert.rejects(
    stores.handle(A, { op: 'fileDownload', key: 'k', url: 'file:///etc/passwd' }),
    /https/,
  );
  await assert.rejects(
    stores.handle('http://nix.localhost', {
      op: 'fileDownload',
      key: 'k',
      url: 'http://s3.example/x',
    }),
    /https/,
  );
  await stores.handle('http://nix.localhost', {
    op: 'fileDownload',
    key: 'k',
    url: 'http://nix.localhost/x',
  });
});

test('a redirect off https is refused and leaves nothing behind', async () => {
  const stores = open({
    fetch: () =>
      Promise.resolve(
        served(null, { status: 302, headers: { location: 'http://evil.example/x' } }),
      ),
  });
  await assert.rejects(
    stores.handle(A, { op: 'fileDownload', key: 'k', url: 'https://s3.example/x' }),
    /https/,
  );
  const filesDir = readdirSync(dir).find((name) => name.endsWith('-files'));
  assert.deepEqual(readdirSync(join(dir, filesDir)), []);
});

test('a redirect on https is followed, and an endless one gives up', async () => {
  const hops = [];
  const stores = open({
    fetch: (url) => {
      hops.push(url);
      return Promise.resolve(
        url.endsWith('/final')
          ? served('done')
          : served(null, { status: 302, headers: { location: '/final' } }),
      );
    },
  });
  await stores.handle(A, { op: 'fileDownload', key: 'k', url: 'https://s3.example/x' });
  assert.deepEqual(hops, ['https://s3.example/x', 'https://s3.example/final']);
  const looping = open({
    fetch: () => Promise.resolve(served(null, { status: 302, headers: { location: '/again' } })),
  });
  await assert.rejects(
    looping.handle(A, { op: 'fileDownload', key: 'loop', url: 'https://s3.example/x' }),
    /failed/,
  );
});

test('an error status stores nothing', async () => {
  const stores = open({ fetch: () => Promise.resolve(served('denied', { status: 403 })) });
  await assert.rejects(
    stores.handle(A, { op: 'fileDownload', key: 'k', url: 'https://s3.example/x' }),
    /failed/,
  );
  assert.deepEqual(await stores.handle(A, { op: 'fileGet', key: 'k' }), { data: null });
});

test('wipe stops downloads and deletes this origin only', async () => {
  let started;
  const begun = new Promise((resolve) => {
    started = resolve;
  });
  const stores = open({
    fetch: (_url, { signal }) => {
      started();
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(new Error('aborted'));
        });
      });
    },
  });
  await sql(stores, 'CREATE TABLE t(a)');
  await sql(stores, 'CREATE TABLE t(a)', undefined, B);
  const download = stores.handle(A, { op: 'fileDownload', key: 'k', url: 'https://s3.example/x' });
  await begun;
  await stores.handle(A, { op: 'wipe' });
  await assert.rejects(download);
  const left = readdirSync(dir).filter((name) => name.endsWith('.sqlite'));
  assert.equal(left.length, 1);
  assert.deepEqual((await stores.handle(A, { op: 'usage' })).fileBytes, 0);
  // Reopens empty, and the other origin keeps its table.
  await sql(stores, 'CREATE TABLE t(a)');
  await rows(stores, 'SELECT * FROM t', undefined, B);
});

test('wipe with a transaction open refuses whoever was waiting, so nothing is recreated', async () => {
  const stores = open();
  await sql(stores, 'CREATE TABLE t(a)');
  await stores.handle(A, { op: 'begin' });
  const waiting = sql(stores, 'CREATE TABLE after_the_wipe(a)');
  await stores.handle(A, { op: 'wipe' });
  await assert.rejects(waiting, /removed/);
  assert.deepEqual(
    await rows(stores, "SELECT name FROM sqlite_master WHERE name='after_the_wipe'"),
    [],
  );
});

for (const [name, statement] of [
  ['INSERT OR ROLLBACK', 'INSERT OR ROLLBACK INTO t VALUES (1)'],
  ['a trigger raising ROLLBACK', 'INSERT INTO r VALUES (1)'],
]) {
  test(`${name} ending the transaction cannot wedge the store`, async () => {
    const stores = open({ idleTimeoutMs: 30 });
    await sql(stores, 'CREATE TABLE t(a UNIQUE)');
    await sql(stores, 'INSERT INTO t VALUES (1)');
    await sql(stores, 'CREATE TABLE r(a)');
    await sql(stores, "CREATE TRIGGER g AFTER INSERT ON r BEGIN SELECT RAISE(ROLLBACK, 'no'); END");
    const { tx } = await stores.handle(A, { op: 'begin' });
    await assert.rejects(sql(stores, statement, undefined, A, tx));
    // The idle timer fires with SQLite's transaction already gone, and the gate still frees.
    assert.equal((await rows(stores, 'SELECT count(*) AS n FROM t'))[0].n, 1);
    const again = (await stores.handle(A, { op: 'begin' })).tx;
    await assert.rejects(sql(stores, statement, undefined, A, again));
    await stores.handle(A, { op: 'rollback', tx: again });
    await stores.handle(A, { op: 'wipe' });
    assert.deepEqual(
      readdirSync(dir).filter((file) => file.endsWith('.sqlite')),
      [],
    );
  });
}

test('the page cannot read the database path through a pragma function', async () => {
  const stores = open();
  await assert.rejects(rows(stores, 'SELECT * FROM pragma_database_list'));
  await sql(stores, 'CREATE TABLE t(a)').catch(() => undefined);
  await sql(stores, 'CREATE VIEW w AS SELECT * FROM pragma_database_list').catch(() => undefined);
  await assert.rejects(rows(stores, 'SELECT * FROM w'));
});

test('downloads refuse private addresses for a server on the internet, on every hop', async () => {
  let calls = 0;
  const counted = (response) => () => {
    calls += 1;
    return Promise.resolve(response());
  };
  const stores = open({ fetch: counted(() => served('secret')) });
  for (const url of [
    'https://intranet.example/x',
    'https://mixed.example/x',
    'https://127.0.0.1/x',
    'https://[::1]/x',
    'https://[::ffff:10.0.0.1]/x',
    'https://169.254.169.254/latest/meta-data',
  ])
    await assert.rejects(
      stores.handle(A, { op: 'fileDownload', key: url, url }),
      /private addresses/,
      url,
    );
  assert.equal(calls, 0);
  const redirecting = open({
    fetch: counted(() =>
      served(null, { status: 302, headers: { location: 'https://intranet.example/x' } }),
    ),
  });
  await assert.rejects(
    redirecting.handle(A, { op: 'fileDownload', key: 'r', url: 'https://s3.example/x' }),
    /private addresses/,
  );
  assert.equal(calls, 1);
});

test('a server on a private network may keep its object store there', async () => {
  const stores = open({ fetch: () => Promise.resolve(served('ok')) });
  await stores.handle('https://lan.example', {
    op: 'fileDownload',
    key: 'k',
    url: 'https://s3.lan.example/x',
  });
});

test('a host that will not resolve is refused', async () => {
  const stores = open({
    fetch: () => Promise.resolve(served('x')),
    resolveHost: () => Promise.reject(new Error('NXDOMAIN')),
  });
  await assert.rejects(
    stores.handle(A, { op: 'fileDownload', key: 'k', url: 'https://s3.example/x' }),
  );
});

test(
  'the store directory is private to this account',
  { skip: process.platform === 'win32' },
  async () => {
    const baseDir = join(dir, 'nested', 'nix-store');
    const stores = open({ baseDir });
    await sql(stores, 'SELECT 1');
    assert.equal(statSync(baseDir).mode & 0o777, 0o700);
  },
);
