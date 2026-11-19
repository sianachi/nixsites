import { z } from 'zod';
import type { ConnectorAction } from './connector.ts';
import {
  graphId,
  graphJson,
  graphPageSize,
  graphSegment,
  microsoftLink,
  withGraphQuery,
  writeJson,
  type GraphInput,
} from './microsoft.shared.ts';

const listArgs = z.strictObject({ limit: graphPageSize });
const threadArgs = z.strictObject({ messageId: graphId, replyLimit: graphPageSize });
const postText = z
  .string()
  .max(8_000)
  .refine((value) => value.trim().length > 0);
const postArgs = z.strictObject({ text: postText });
const revision = z.string().min(1).max(512);
const replyArgs = z.strictObject({
  messageId: graphId,
  expectedRevision: revision,
  text: postText,
});
const channelGrant = z.tuple([z.uuid(), graphId]);
type Channel = z.infer<typeof channelGrant>;

const teamsMessage = z.object({
  id: graphId,
  replyToId: graphId.nullish(),
  etag: revision.nullish(),
  body: z.object({ contentType: z.enum(['text', 'html']), content: z.string() }).nullish(),
  createdDateTime: z.iso.datetime({ offset: true }).nullish(),
  webUrl: z.string().nullish(),
  from: z.object({ user: z.object({ displayName: z.string().nullish() }).nullish() }).nullish(),
  channelIdentity: z.object({ teamId: z.uuid(), channelId: graphId }).nullish(),
});
const messageList = z.object({
  value: z.array(teamsMessage).max(100),
  '@odata.nextLink': z.string().optional(),
});
const teamsHosts = ['teams.microsoft.com', 'teams.cloud.microsoft'];

function messagesPath(channel: Channel): string {
  return `/teams/${graphSegment(channel[0])}/channels/${graphSegment(channel[1])}/messages`;
}

function messageProjection(
  message: z.infer<typeof teamsMessage>,
  channel: Channel,
  textLimit = 4_000,
) {
  const identity = message.channelIdentity;
  if (
    identity &&
    (identity.teamId.toLowerCase() !== channel[0].toLowerCase() ||
      identity.channelId !== channel[1])
  ) {
    throw new Error('Teams message is outside the selected channel.');
  }
  const content = message.body?.content.slice(0, textLimit) ?? '';
  return {
    id: message.id,
    replyToId: message.replyToId ?? null,
    revision: message.etag ?? null,
    text: message.body?.contentType === 'html' ? content.replace(/<[^>]*>/gu, ' ') : content,
    createdAt: message.createdDateTime ?? null,
    author: message.from?.user?.displayName?.slice(0, 200) ?? null,
    url: microsoftLink(message.webUrl ?? undefined, teamsHosts),
  };
}

async function readThread(input: GraphInput, channel: Channel, messageId: string) {
  const path = `${messagesPath(channel)}/${graphSegment(messageId)}`;
  const message = teamsMessage.parse(await graphJson(input, path));
  if (message.id !== messageId || message.replyToId) {
    throw new Error('Teams returned a different thread.');
  }
  return messageProjection(message, channel);
}

async function sendMessage(input: GraphInput, channel: Channel, text: string, replyToId?: string) {
  const messages = messagesPath(channel);
  const path = replyToId ? `${messages}/${graphSegment(replyToId)}/replies` : messages;
  const message = teamsMessage.parse(
    await graphJson(
      input,
      path,
      writeJson('POST', { body: { contentType: 'text', content: text } }),
    ),
  );
  const receipt = messageProjection(message, channel);
  if (receipt.replyToId !== (replyToId ?? null)) {
    throw new Error('Teams could not confirm the reviewed destination.');
  }
  return { id: receipt.id, replyToId: receipt.replyToId, url: receipt.url };
}

export const teamsActions: readonly ConnectorAction[] = [
  {
    id: 'teams.list-threads',
    kind: 'read',
    resourceKind: 'channel',
    description: 'List recent threads in the selected Microsoft Teams channel.',
    args: listArgs,
    async execute(input: GraphInput): Promise<unknown> {
      const { limit = 10 } = listArgs.parse(input.args);
      const channel = channelGrant.parse(input.resourceId.split('/'));
      const path = withGraphQuery(messagesPath(channel), { $top: String(limit) });
      const result = messageList.parse(await graphJson(input, path));
      return {
        threads: result.value
          .slice(0, limit)
          .map((message) => messageProjection(message, channel, 640)),
        truncated: result['@odata.nextLink'] !== undefined || result.value.length > limit,
      };
    },
  },
  {
    id: 'teams.get-thread',
    kind: 'read',
    resourceKind: 'channel',
    description: 'Read a thread, its current revision, and a bounded set of its replies.',
    args: threadArgs,
    async execute(input: GraphInput): Promise<unknown> {
      const { messageId, replyLimit = 10 } = threadArgs.parse(input.args);
      const channel = channelGrant.parse(input.resourceId.split('/'));
      const thread = await readThread(input, channel, messageId);
      const path = withGraphQuery(`${messagesPath(channel)}/${graphSegment(messageId)}/replies`, {
        $top: String(replyLimit),
      });
      const result = messageList.parse(await graphJson(input, path));
      const replies = result.value.slice(0, replyLimit).map((message) => {
        if (message.replyToId !== messageId) throw new Error('Teams returned a different reply.');
        return messageProjection(message, channel, 1_024);
      });
      return {
        thread,
        replies,
        truncated: result['@odata.nextLink'] !== undefined || result.value.length > replyLimit,
      };
    },
  },
  {
    id: 'teams.post-message',
    kind: 'write',
    resourceKind: 'channel',
    description: 'Post the reviewed text to the selected Microsoft Teams channel.',
    args: postArgs,
    async execute(input: GraphInput): Promise<unknown> {
      const { text } = postArgs.parse(input.args);
      const channel = channelGrant.parse(input.resourceId.split('/'));
      return sendMessage(input, channel, text);
    },
  },
  {
    id: 'teams.post-reply',
    kind: 'write',
    resourceKind: 'channel',
    description: 'Reply to the reviewed thread in the selected Microsoft Teams channel.',
    args: replyArgs,
    async execute(input: GraphInput): Promise<unknown> {
      const { messageId, expectedRevision, text } = replyArgs.parse(input.args);
      const channel = channelGrant.parse(input.resourceId.split('/'));
      const thread = await readThread(input, channel, messageId);
      if (thread.revision !== expectedRevision) {
        throw new Error('The Teams thread changed after review.');
      }
      return sendMessage(input, channel, text, messageId);
    },
  },
];
