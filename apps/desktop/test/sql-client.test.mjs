import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';

import { SqlClient } from '../src/sql-client.mjs';

class FakeChild extends EventEmitter {
  sent = [];
  killed = false;
  postMessage(message) {
    this.sent.push(message);
  }
  kill() {
    this.killed = true;
  }
}

function client(stallMs = 40) {
  const children = [];
  const sql = new SqlClient({
    stallMs,
    spawn: () => {
      children.push(new FakeChild());
      return children.at(-1);
    },
  });
  return { sql, children };
}
const wait = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

test('replies go to the request that asked, and an error rejects', async () => {
  const { sql, children } = client(10_000);
  const first = sql.handle('https://a', { op: 'x' });
  const second = sql.handle('https://b', { op: 'y' });
  const [one, two] = children[0].sent;
  assert.deepEqual([one.origin, two.origin], ['https://a', 'https://b']);
  children[0].emit('message', { id: two.id, error: 'nope' });
  children[0].emit('message', { id: one.id, value: 'ok' });
  assert.equal(await first, 'ok');
  await assert.rejects(second, /nope/);
  assert.equal(children.length, 1);
  sql.close();
});

test('a process that stops beating is killed, its requests fail and the next one starts afresh', async () => {
  const { sql, children } = client();
  const stuck = sql.handle('https://a', { op: 'x' });
  await assert.rejects(stuck, /stopped responding/);
  assert.equal(children[0].killed, true);
  const next = sql.handle('https://a', { op: 'y' });
  assert.equal(children.length, 2);
  children[1].emit('message', { id: children[1].sent[0].id, value: 'ok' });
  assert.equal(await next, 'ok');
  sql.close();
});

test('a beating process is left alone however long a request waits', async () => {
  const { sql, children } = client();
  const slow = sql.handle('https://a', { op: 'x' });
  for (let beat = 0; beat < 6; beat += 1) {
    await wait(20);
    children[0].emit('message', { beat: true });
  }
  assert.equal(children[0].killed, false);
  children[0].emit('message', { id: children[0].sent[0].id, value: 'done' });
  assert.equal(await slow, 'done');
  sql.close();
});

test('a process that dies fails what was in flight, and only the current one counts', async () => {
  const { sql, children } = client(10_000);
  const lost = sql.handle('https://a', { op: 'x' });
  children[0].emit('exit');
  await assert.rejects(lost, /stopped responding/);
  const next = sql.handle('https://a', { op: 'y' });
  children[0].emit('exit');
  children[1].emit('message', { id: children[1].sent[0].id, value: 'ok' });
  assert.equal(await next, 'ok');
  sql.close();
});
