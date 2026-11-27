import { describe, expect, it } from 'vitest';
import { executePostMessage, parseAddressee } from './messages.ts';
import type { Session } from '../session.ts';

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

describe('posting to a pet', () => {
  const login = { authKind: 'interactive' } as Session;

  it('is refused on a browser-approved login, which Core treats as a person', async () => {
    await expect(executePostMessage(login, ID, { text: 'hi', to: [`pet:${ID}`] })).rejects.toThrow(
      'needs an access token',
    );
  });
});
