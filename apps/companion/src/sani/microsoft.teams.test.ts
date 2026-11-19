import { describe, expect, it, vi } from 'vitest';

import { teamsActions } from './microsoft.teams.ts';

const teamId = '9e8c8580-fb67-4158-afa3-488222411afe';
const channelId = '19:example@thread.tacv2';
const selectedChannel = `${teamId}/${channelId}`;
const graph = `https://graph.microsoft.com/v1.0/teams/${teamId}/channels/${encodeURIComponent(channelId)}/messages`;
const thread = {
  id: 'thread-one',
  body: { contentType: 'html', content: '<div>Give this a review</div>' },
  etag: 'thread-revision',
  channelIdentity: { teamId, channelId },
  webUrl: 'https://teams.microsoft.com/l/message/thread-one',
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
    run(operation: string, args: unknown, resourceId = selectedChannel) {
      const action = teamsActions.find(({ id }) => id === `teams.${operation}`);
      if (!action) throw new Error('Unknown Teams action.');
      return action.execute({
        executionId: '42f5e7ac-5ea8-4e33-825a-14d562b8f9cc',
        resourceId,
        accessToken: 'fixture-token',
        args,
        fetch,
        signal: AbortSignal.timeout(2_000),
      });
    },
  };
}

describe('Teams actions', () => {
  it('reads a selected thread and strips presentation markup from bounded results', async () => {
    const test = fixture(
      Response.json(thread),
      Response.json({
        value: [
          {
            ...thread,
            id: 'reply-one',
            replyToId: thread.id,
            body: { contentType: 'text', content: 'I will check.' },
            webUrl: 'https://untrusted.example/elsewhere',
          },
        ],
      }),
    );
    await expect(test.run('get-thread', { messageId: thread.id })).resolves.toMatchObject({
      thread: { id: thread.id, text: ' Give this a review ', revision: thread.etag },
      replies: [{ id: 'reply-one', text: 'I will check.', url: null }],
    });
    expect(requestUrl(test.fetch.mock.calls[0]?.[0])).toBe(`${graph}/${thread.id}`);
    expect(requestUrl(test.fetch.mock.calls[1]?.[0]).split('?')[0]).toBe(
      `${graph}/${thread.id}/replies`,
    );
  });

  it('rejects a response for another channel before reading or posting replies', async () => {
    const test = fixture(
      Response.json({ ...thread, channelIdentity: { teamId, channelId: 'different-channel' } }),
    );
    await expect(
      test.run('post-reply', {
        messageId: thread.id,
        expectedRevision: thread.etag,
        text: 'I can check this.',
      }),
    ).rejects.toThrow('outside the selected channel');
    expect(test.fetch).toHaveBeenCalledTimes(1);
  });

  it('posts only literal text to the reviewed thread after checking the revision', async () => {
    const test = fixture(
      Response.json(thread),
      Response.json({ id: 'reply-one', replyToId: thread.id }, { status: 201 }),
    );
    const text = '<at id="0">People</at> are available.';
    await expect(
      test.run('post-reply', { messageId: thread.id, expectedRevision: thread.etag, text }),
    ).resolves.toEqual({ id: 'reply-one', replyToId: thread.id, url: null });
    expect(requestUrl(test.fetch.mock.calls[1]?.[0])).toBe(`${graph}/${thread.id}/replies`);
    expect(test.fetch.mock.calls[1]?.[1]?.body).toBe(
      JSON.stringify({ body: { contentType: 'text', content: text } }),
    );
  });

  it('rejects stale replies and a caller-supplied replacement channel', async () => {
    const test = fixture(Response.json(thread));
    await expect(
      test.run('post-message', { text: 'Update', channelId: 'other' }),
    ).rejects.toThrow();
    await expect(
      test.run('post-reply', { messageId: thread.id, expectedRevision: 'stale', text: 'Update' }),
    ).rejects.toThrow('changed after review');
    expect(test.fetch).toHaveBeenCalledTimes(1);
  });
});
