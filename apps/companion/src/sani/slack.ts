import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { ConnectorAction } from './connector.ts';
import { providerJson } from './provider-json.ts';

const channel = z
  .string()
  .regex(/^[CG][A-Z0-9]{8,31}$/)
  .refine(exact);
const timestamp = z
  .string()
  .regex(/^\d{1,16}\.\d{6}$/)
  .refine(exact);
const cursor = z.string().min(1).max(1024).regex(/^\S+$/).refine(exact);
const pageCursor = z
  .string()
  .max(1450)
  .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/)
  .refine(exact);
const postText = z
  .string()
  .max(4000)
  .refine((text) => text.trim().length > 0);
const threadPageSize = 10;
const snippetLength = 1000;

const readArgs = z.strictObject({ threadTs: timestamp, cursor: pageCursor.optional() });
const replyArgs = z.strictObject({ threadTs: timestamp, text: postText });
const updateArgs = z.strictObject({ text: postText });

const threadResponse = z.object({
  ok: z.literal(true),
  messages: z
    .array(
      z.object({
        channel: channel.optional(),
        ts: timestamp,
        thread_ts: timestamp.optional(),
        text: z.string(),
      }),
    )
    .min(1)
    .max(threadPageSize),
  has_more: z.boolean().optional(),
  response_metadata: z.object({ next_cursor: z.union([cursor, z.literal('')]) }).optional(),
});

const postResponse = z.object({
  ok: z.literal(true),
  channel,
  ts: timestamp,
  message: z.object({ ts: timestamp, thread_ts: timestamp.optional() }),
});

type ActionInput = Parameters<ConnectorAction['execute']>[0];

function exact(value: string): boolean {
  return value.trim() === value;
}

function pageMac(input: ActionInput, threadTs: string, contents: string): Buffer {
  return createHmac('sha256', input.accessToken)
    .update(JSON.stringify(['slack-page', input.resourceId, threadTs, contents]))
    .digest();
}

function encodeCursor(input: ActionInput, threadTs: string, token: string): string {
  const contents = Buffer.from(token).toString('base64url');
  return `${contents}.${pageMac(input, threadTs, contents).toString('base64url')}`;
}

function decodeCursor(input: ActionInput, threadTs: string, value: string): string {
  const separator = value.indexOf('.');
  const contents = value.slice(0, separator);
  const mac = Buffer.from(value.slice(separator + 1), 'base64url');
  const expected = pageMac(input, threadTs, contents);
  if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) {
    throw new Error('The Slack page belongs to a different thread or needs to be refreshed.');
  }
  return cursor.parse(Buffer.from(contents, 'base64url').toString());
}

async function postMessage(input: ActionInput, text: string, threadTs?: string) {
  const channelId = channel.parse(input.resourceId);
  // Slack reserves these characters for formatting, including explicit notification mentions.
  const escaped = text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const response = postResponse.safeParse(
    await providerJson(input, new URL('https://slack.com/api/chat.postMessage'), {
      method: 'POST',
      body: {
        channel: channelId,
        text: escaped,
        ...(threadTs === undefined ? {} : { thread_ts: threadTs, reply_broadcast: false }),
        mrkdwn: false,
        parse: 'none',
        unfurl_links: false,
        unfurl_media: false,
        unfurl_app_links: false,
      },
    }),
  );
  if (
    !response.success ||
    response.data.channel !== channelId ||
    response.data.message.ts !== response.data.ts ||
    (threadTs === undefined
      ? response.data.message.thread_ts !== undefined &&
        response.data.message.thread_ts !== response.data.ts
      : response.data.message.thread_ts !== threadTs || response.data.ts === threadTs)
  ) {
    throw new Error('Slack did not confirm the approved message destination.');
  }
  return {
    channelId,
    messageTs: response.data.ts,
    ...(threadTs === undefined ? {} : { threadTs }),
  };
}

export const slackActions = [
  {
    id: 'slack.read_thread',
    kind: 'read',
    resourceKind: 'channel',
    description: 'Read a page of plain text from a thread in the connected Slack channel.',
    args: readArgs,
    async execute(input) {
      const channelId = channel.parse(input.resourceId);
      const { threadTs, cursor: nextPage } = readArgs.parse(input.args);
      const url = new URL('https://slack.com/api/conversations.replies');
      url.searchParams.set('channel', channelId);
      url.searchParams.set('ts', threadTs);
      url.searchParams.set('limit', String(threadPageSize));
      if (nextPage !== undefined)
        url.searchParams.set('cursor', decodeCursor(input, threadTs, nextPage));

      const response = threadResponse.safeParse(await providerJson(input, url));
      if (!response.success) throw new Error('Slack did not return a readable thread.');
      const { messages, response_metadata: metadata } = response.data;
      if (
        (nextPage === undefined && messages[0]?.ts !== threadTs) ||
        messages.some(
          (message) =>
            (message.channel !== undefined && message.channel !== channelId) ||
            (message.ts === threadTs
              ? message.thread_ts !== undefined && message.thread_ts !== threadTs
              : message.thread_ts !== threadTs),
        )
      ) {
        throw new Error('Slack returned messages outside the requested thread.');
      }
      const nextCursor = metadata?.next_cursor === '' ? undefined : metadata?.next_cursor;
      return {
        channelId,
        threadTs,
        messages: messages.map(({ ts, text }) => ({
          messageTs: ts,
          text: text.slice(0, snippetLength),
          truncated: text.length > snippetLength,
        })),
        hasMore: response.data.has_more === true || nextCursor !== undefined,
        ...(nextCursor === undefined
          ? {}
          : { nextCursor: encodeCursor(input, threadTs, nextCursor) }),
      };
    },
  },
  {
    id: 'slack.reply',
    kind: 'write',
    resourceKind: 'channel',
    description: 'Post a reviewed plain-text reply to an exact Slack thread.',
    args: replyArgs,
    execute(input) {
      const { text, threadTs } = replyArgs.parse(input.args);
      return postMessage(input, text, threadTs);
    },
  },
  {
    id: 'slack.post_update',
    kind: 'write',
    resourceKind: 'channel',
    description: 'Post a reviewed plain-text update to the connected Slack channel.',
    args: updateArgs,
    execute(input) {
      const { text } = updateArgs.parse(input.args);
      return postMessage(input, text);
    },
  },
] as const satisfies readonly ConnectorAction[];
