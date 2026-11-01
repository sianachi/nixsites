import { describe, expect, it, vi } from 'vitest';

import { empty, failed, loading, partial, ready } from '../../lib/async-status';

describe('async status constructors', () => {
  it('failed omits retry when no callback is given', () => {
    const result = failed('t', 'd');
    expect('retry' in result).toBe(false);
    expect(result).toEqual({ kind: 'error', title: 't', detail: 'd' });
  });

  it('failed keeps the retry reference', () => {
    const fn = vi.fn();
    expect(failed('t', 'd', fn).retry).toBe(fn);
  });

  it('the other constructors carry their kind and fields', () => {
    expect(loading('items')).toEqual({ kind: 'loading', label: 'items' });
    expect(empty('t', 'd')).toEqual({ kind: 'empty', title: 't', detail: 'd' });
    expect(partial(1, 'indexing')).toEqual({ kind: 'partial', value: 1, pending: 'indexing' });
    expect(ready(2)).toEqual({ kind: 'ready', value: 2 });
  });
});
