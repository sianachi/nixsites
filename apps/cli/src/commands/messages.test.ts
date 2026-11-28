import { describe, expect, it } from 'vitest';
import {
  executeMarkRead,
  executeMessageInbox,
  executePostMessage,
  parseAddressee,
} from './messages.ts';
import type { Session } from '../session.ts';

const ID = '33333333-3333-4333-8333-333333333333';

describe('message addressees', () => {
  it('reads person:<id>, pet:<id> and agent:<id>', () => {
    expect(parseAddressee(`agent:${ID}`)).toEqual({ id: ID, kind: 'agent' });
    expect(parseAddressee(`pet:${ID}`)).toEqual({ id: ID, kind: 'pet' });
    expect(parseAddressee(`person:${ID}`)).toEqual({ id: ID, kind: 'person' });
  });

  it('refuses anything else', () => {
    expect(() => parseAddressee(ID)).toThrow('person:<id>, pet:<id> or agent:<id>');
    expect(() => parseAddressee('robot:' + ID)).toThrow();
    expect(() => parseAddressee('pet:nope')).toThrow();
  });
});

describe('the agent inbox', () => {
  const login = { authKind: 'interactive' } as Session;
  const token = (replies: readonly unknown[]) => {
    const calls: unknown[] = [];
    return {
      calls,
      session: {
        authKind: 'token',
        client: {
          query: () => Promise.resolve(replies[0]),
          execute: (endpoint: unknown) => {
            calls.push(endpoint);
            return Promise.resolve({ marked: 1 });
          },
        },
      } as unknown as Session,
    };
  };

  it('is refused on a browser-approved login', async () => {
    await expect(executeMessageInbox(login, {})).rejects.toThrow('needs an access token');
    await expect(executeMarkRead(login, [ID])).rejects.toThrow('needs an access token');
  });

  it('marks the messages it returned as read only when asked', async () => {
    const page = { messages: [{ messageId: ID }], next: null };
    const plain = token([page]);
    expect(await executeMessageInbox(plain.session, {})).toEqual(page);
    expect(plain.calls).toHaveLength(0);

    const marking = token([page]);
    expect(await executeMessageInbox(marking.session, { markRead: true })).toEqual({
      ...page,
      marked: 1,
    });
    expect(marking.calls).toMatchObject([
      { path: '/api/v1/me/message-inbox/read', body: { messageIds: [ID] } },
    ]);

    const empty = token([{ messages: [], next: null }]);
    await executeMessageInbox(empty.session, { markRead: true });
    expect(empty.calls).toHaveLength(0);
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
