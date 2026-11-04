import { describe, expect, it } from 'vitest';

import { parseRoles } from './roles.ts';

describe('parseRoles', () => {
  it('defaults to every role', () => {
    expect(parseRoles(undefined)).toEqual(['collab', 'companion', 'sites-worker']);
    expect(parseRoles(' ')).toEqual(['collab', 'companion', 'sites-worker']);
  });

  it('parses a trimmed list and drops repeats', () => {
    expect(parseRoles('companion, collab,companion')).toEqual(['companion', 'collab']);
  });

  it('rejects an unknown role', () => {
    expect(() => parseRoles('collab,bogus')).toThrow(/bogus/);
  });
});
