import { describe, expect, it } from 'vitest';
import { parseAddressee } from './messages.ts';

const ID = '33333333-3333-4333-8333-333333333333';

describe('message addressees', () => {
  it('reads person:<id> and pet:<id>', () => {
    expect(parseAddressee(`pet:${ID}`)).toEqual({ id: ID, kind: 'pet' });
    expect(parseAddressee(`person:${ID}`)).toEqual({ id: ID, kind: 'person' });
  });

  it('refuses anything else', () => {
    expect(() => parseAddressee(ID)).toThrow('person:<id> or pet:<id>');
    expect(() => parseAddressee('robot:' + ID)).toThrow();
    expect(() => parseAddressee('pet:nope')).toThrow();
  });
});
