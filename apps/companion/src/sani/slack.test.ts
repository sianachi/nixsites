import { describe, expect, it, vi } from 'vitest';
import { slackActions } from './slack.ts';

const [readThread, reply, postUpdate] = slackActions;
const channelId = 'C123ABC456';
const otherChannelId = 'C456ABC123';
const threadTs = '1712345678.000100';
const replyTs = '1712345679.000200';
const anotherThreadTs = '1712345680.000300';
const nextCursor = 'c2xhY2stbmV4dA==';
const accessToken = 'slack-fixture-token';

function input(args: unknown, fetch: typeof globalThis.fetch) {
  return {
    executionId: '8a9c3bc7-2503-4201-b5a9-1d693f5eed34',
    resourceId: channelId,
    accessToken,
    args,
    fetch,
    signal: new AbortController().signal,
  };
}

function checkRequest(
  url: Parameters<typeof globalThis.fetch>[0],
  options: RequestInit | undefined,
  method: string,
) {
  expect(options?.method ?? 'GET').toBe(method);
  expect(options?.redirect).toBe('error');
  expect(new Headers(options?.headers).get('authorization')).toBe(`Bearer ${accessToken}`);
  if (url instanceof Request) throw new Error('Fixture expects a connector URL.');
  return new URL(url);
}

describe('Slack selected threads', () => {
  it('queries the granted channel with a bounded page and returns only the thread text', async () => {
    const text = 'a'.repeat(2000);
    const fetch = vi.fn<typeof globalThis.fetch>((url, options) => {
      expect(checkRequest(url, options, 'GET').toString()).toBe(
        `https://slack.com/api/conversations.replies?channel=${channelId}&ts=${threadTs}&limit=10`,
      );
      return Promise.resolve(
        Response.json({
          ok: true,
          messages: [
            {
              ts: threadTs,
              text: 'Decision',
              user: 'U123ABC456',
              attachments: [{ body: 'Attachment content' }],
            },
            { ts: replyTs, thread_ts: threadTs, text },
          ],
          response_metadata: { next_cursor: nextCursor },
        }),
      );
    });

    const result = await readThread.execute(input({ threadTs }, fetch));
    expect(result).toMatchObject({
      channelId,
      threadTs,
      messages: [
        { messageTs: threadTs, text: 'Decision', truncated: false },
        { messageTs: replyTs, text: text.slice(0, 1000), truncated: true },
      ],
      hasMore: true,
    });
    expect(result.nextCursor).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('continues the same thread without requiring the parent message on every page', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>((url, options) => {
      const query = checkRequest(url, options, 'GET').searchParams;
      expect(query.get('channel')).toBe(channelId);
      expect(query.get('ts')).toBe(threadTs);
      if (query.get('cursor') === null) {
        return Promise.resolve(
          Response.json({
            ok: true,
            messages: [{ ts: threadTs, text: 'First page' }],
            response_metadata: { next_cursor: nextCursor },
          }),
        );
      }
      expect(query.get('cursor')).toBe(nextCursor);
      return Promise.resolve(
        Response.json({
          ok: true,
          messages: [{ ts: replyTs, thread_ts: threadTs, text: 'Follow-up' }],
          response_metadata: { next_cursor: '' },
        }),
      );
    });

    const first = await readThread.execute(input({ threadTs }, fetch));
    if (!first.nextCursor) throw new Error('Expected a signed page cursor.');
    const page = { threadTs, cursor: first.nextCursor };
    await expect(
      readThread.execute(input({ ...page, threadTs: anotherThreadTs }, fetch)),
    ).rejects.toThrow('The Slack page belongs to a different thread');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await readThread.execute(input(page, fetch))).toEqual({
      channelId,
      threadTs,
      messages: [{ messageTs: replyTs, text: 'Follow-up', truncated: false }],
      hasMore: false,
    });
  });

  it.each([
    { ts: replyTs, thread_ts: anotherThreadTs, text: 'Another thread' },
    { ts: replyTs, thread_ts: threadTs, channel: otherChannelId, text: 'Another channel' },
  ])('refuses messages outside the approved thread scope', async (message) => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        Response.json({ ok: true, messages: [{ ts: threadTs, text: 'Root' }, message] }),
      );
    await expect(readThread.execute(input({ threadTs }, fetch))).rejects.toThrow(
      'outside the requested thread',
    );
  });

  it('refuses a caller-supplied channel or a channel name before making a request', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(
      readThread.execute(input({ threadTs, channel: otherChannelId }, fetch)),
    ).rejects.toThrow();
    await expect(
      readThread.execute({ ...input({ threadTs }, fetch), resourceId: '#general' }),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('Slack reviewed posts', () => {
  it.each([
    { action: reply, args: { threadTs }, thread: { thread_ts: threadTs, reply_broadcast: false } },
    { action: postUpdate, args: {}, thread: {} },
  ])(
    'posts plaintext through $action.id to the granted destination',
    async ({ action, args, thread }) => {
      const fetch = vi.fn<typeof globalThis.fetch>((url, options) => {
        expect(checkRequest(url, options, 'POST').toString()).toBe(
          'https://slack.com/api/chat.postMessage',
        );
        expect(new Headers(options?.headers).get('content-type')).toContain('application/json');
        if (typeof options?.body !== 'string') throw new Error('Fixture expects a JSON body.');
        expect(JSON.parse(options.body)).toEqual({
          channel: channelId,
          text: '&lt;!channel&gt; &amp; update',
          ...thread,
          mrkdwn: false,
          parse: 'none',
          unfurl_links: false,
          unfurl_media: false,
          unfurl_app_links: false,
        });
        return Promise.resolve(
          Response.json({
            ok: true,
            channel: channelId,
            ts: replyTs,
            message: { ts: replyTs, ...thread },
          }),
        );
      });

      expect(await action.execute(input({ text: '<!channel> & update', ...args }, fetch))).toEqual({
        channelId,
        messageTs: replyTs,
        ...args,
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    { ok: false, error: 'Provider response is private' },
    {
      ok: true,
      channel: otherChannelId,
      ts: replyTs,
      message: { ts: replyTs, thread_ts: threadTs },
    },
    {
      ok: true,
      channel: channelId,
      ts: replyTs,
      message: { ts: replyTs, thread_ts: anotherThreadTs },
    },
    { ok: true, channel: channelId, ts: replyTs, message: { ts: replyTs } },
  ])(
    'withholds a receipt when Slack does not confirm the approved channel and thread',
    async (result) => {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(result));
      await expect(
        reply.execute(input({ threadTs, text: 'Reviewed reply' }, fetch)),
      ).rejects.toThrow('Slack did not confirm the approved message destination.');
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );
});
