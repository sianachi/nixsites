import { describe, expect, it, vi } from 'vitest';

import { outlookMailActions } from './microsoft.mail.ts';

const folderId = 'selected-folder';
const graph = `https://graph.microsoft.com/v1.0/me/mailFolders/${folderId}/messages`;
const address = 'reply-to@example.com';
const fullMessage = {
  id: 'message-one',
  parentFolderId: folderId,
  subject: 'Status update',
  receivedDateTime: '2026-11-16T12:00:00Z',
  from: { emailAddress: { address: 'sender@example.com' } },
  conversationId: 'conversation-one',
  webLink: 'https://outlook.office.com/mail/deeplink/read/message-one',
  replyTo: [{ emailAddress: { address } }],
  changeKey: 'revision-one',
  uniqueBody: { contentType: 'text', content: 'The order is ready.' },
  attachments: [{ contentBytes: 'private attachment body' }],
};
const reply = {
  messageId: fullMessage.id,
  expectedChangeKey: fullMessage.changeKey,
  to: [address],
  text: 'I will pick it up on Monday.',
};

function requestUrl(input: Parameters<typeof fetch>[0] | undefined): string {
  return typeof input === 'string'
    ? input
    : input instanceof Request
      ? input.url
      : (input?.href ?? '');
}

function fixture(...responses: Response[]) {
  const fetch = vi.fn<typeof globalThis.fetch>(() => {
    const response = responses.shift();
    return response
      ? Promise.resolve(response)
      : Promise.reject(new Error('Unexpected Microsoft Graph request.'));
  });
  return {
    fetch,
    run(operation: string, args: unknown) {
      const action = outlookMailActions.find(({ id }) => id === `outlook-mail.${operation}`);
      if (!action) throw new Error('Unknown Outlook action.');
      return action.execute({
        executionId: '42f5e7ac-5ea8-4e33-825a-14d562b8f9cc',
        resourceId: folderId,
        accessToken: 'fixture-token',
        args,
        fetch,
        signal: AbortSignal.timeout(2_000),
      });
    },
  };
}

describe('Outlook mail actions', () => {
  it('reads a selected message as text and projects only fields needed for a reply', async () => {
    const test = fixture(Response.json(fullMessage));
    await expect(test.run('get-message', { messageId: fullMessage.id })).resolves.toEqual({
      id: 'message-one',
      subject: 'Status update',
      from: 'sender@example.com',
      receivedAt: '2026-11-16T12:00:00Z',
      conversationId: 'conversation-one',
      url: 'https://outlook.office.com/mail/deeplink/read/message-one',
      text: 'The order is ready.',
      changeKey: 'revision-one',
      replyTo: [address],
    });
    const [url, init] = test.fetch.mock.calls[0] ?? [];
    expect(requestUrl(url).split('?')[0]).toBe(`${graph}/${fullMessage.id}`);
    expect(new Headers(init?.headers).get('prefer')).toBe('outlook.body-content-type="text"');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fixture-token');
  });

  it('requires the returned message to belong to the selected folder', async () => {
    const test = fixture(Response.json({ ...fullMessage, parentFolderId: 'different-folder' }));
    await expect(test.run('send-reply', reply)).rejects.toThrow('outside the selected folder');
    expect(test.fetch).toHaveBeenCalledTimes(1);
  });

  it('returns the delta cursor and rejects a continuation outside the selected folder', async () => {
    const cursor = `${graph}/delta?$deltatoken=fixture`;
    const test = fixture(
      Response.json({
        '@odata.deltaLink': cursor,
        value: [fullMessage, { '@removed': {} }, { id: fullMessage.id, isRead: true }],
      }),
      Response.json({ '@odata.deltaLink': cursor, value: [] }),
    );
    await expect(test.run('poll-folder', {})).resolves.toMatchObject({
      cursor,
      hasMore: false,
      messages: [{ id: fullMessage.id }],
    });
    await expect(test.run('poll-folder', { cursor })).resolves.toMatchObject({ messages: [] });
    expect(requestUrl(test.fetch.mock.calls[1]?.[0])).toBe(cursor);
    await expect(
      test.run('poll-folder', { cursor: cursor.replace(folderId, 'other-folder') }),
    ).rejects.toThrow('outside the selected folder');
    await expect(
      test.run('poll-folder', { cursor: cursor.replace('graph.microsoft.com', 'example.com') }),
    ).rejects.toThrow('outside the selected folder');
    expect(test.fetch).toHaveBeenCalledTimes(2);
  });

  it('sends only the exact reviewed text and current reply recipients', async () => {
    const test = fixture(Response.json(fullMessage), new Response(null, { status: 202 }));
    await expect(test.run('send-reply', reply)).resolves.toEqual({
      accepted: true,
      messageId: fullMessage.id,
    });
    const [url, init] = test.fetch.mock.calls[1] ?? [];
    expect(requestUrl(url)).toBe(`${graph}/${fullMessage.id}/reply`);
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(
      JSON.stringify({
        message: {
          toRecipients: [{ emailAddress: { address } }],
          body: { contentType: 'text', content: reply.text },
        },
      }),
    );
  });

  it('refuses to send if the reviewed recipients or source revision changed', async () => {
    const test = fixture(Response.json(fullMessage), Response.json(fullMessage));
    await expect(test.run('send-reply', { ...reply, to: ['sender@example.com'] })).rejects.toThrow(
      'changed after review',
    );
    await expect(test.run('send-reply', { ...reply, expectedChangeKey: 'stale' })).rejects.toThrow(
      'changed after review',
    );
    expect(test.fetch.mock.calls.every(([, init]) => init?.method === undefined)).toBe(true);
  });
});
