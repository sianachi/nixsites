import { describe, expect, it } from 'vitest';

import { add, edit, list, remove, reply, setAnchor, setResolved, watch } from './comments.js';

const ITEM = '11111111-1111-4111-8111-111111111111';
const THREAD = '33333333-3333-4333-8333-333333333333';
const base = `/api/v1/items/${ITEM}/comments`;

describe('the comments resource', () => {
  it('reads and watches one note, the watch carrying the last revision', () => {
    expect(list(ITEM)).toMatchObject({ kind: 'query', path: base });
    expect(watch(ITEM, 7)).toMatchObject({ path: `${base}/watch`, query: { revision: 7 } });
  });

  it('writes address the collection, a thread, or one comment', () => {
    expect(add(ITEM, { body: 'hi' })).toMatchObject({ method: 'POST', path: base });
    expect(reply(ITEM, THREAD, { body: 'yes' })).toMatchObject({
      method: 'POST',
      path: `${base}/${THREAD}/replies`,
    });
    expect(edit(ITEM, THREAD, 'new')).toMatchObject({
      method: 'PATCH',
      path: `${base}/${THREAD}`,
      body: { body: 'new' },
    });
    expect(setAnchor(ITEM, THREAD, 'a', 'b')).toMatchObject({
      method: 'PUT',
      path: `${base}/${THREAD}/anchor`,
      body: { start: 'a', end: 'b' },
    });
    expect(setResolved(ITEM, THREAD, true)).toMatchObject({
      method: 'PUT',
      path: `${base}/${THREAD}/resolved`,
      body: { resolved: true },
    });
    expect(remove(ITEM, THREAD)).toMatchObject({ method: 'DELETE', path: `${base}/${THREAD}` });
  });
});
