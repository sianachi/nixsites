import { describe, expect, it } from 'vitest';

import { cn } from './cn';

describe('cn', () => {
  it('lets a later class win within the same utility group', () => {
    expect(cn('mt-2', 'mt-4')).toBe('mt-4');
  });

  it('drops falsy inputs and honours conditional objects', () => {
    expect(cn('a', false, undefined, null, { 'p-2': true, 'p-4': false })).toBe('a p-2');
  });

  it('keeps unrelated classes', () => {
    expect(cn('px-2', 'py-4')).toBe('px-2 py-4');
  });
});
