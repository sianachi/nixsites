import { z } from 'zod';
import type { ConnectorAction } from './connector.ts';
import {
  graphId,
  graphJson,
  graphPageSize,
  graphResponse,
  graphSegment,
  microsoftLink,
  withGraphQuery,
  writeJson,
  type GraphInput,
} from './microsoft.shared.ts';

const messageListArgs = z.strictObject({ limit: graphPageSize });
const messageArgs = z.strictObject({ messageId: graphId });
const cursorSchema = z.string().min(1).max(8_192);
const deltaArgs = z.strictObject({ cursor: cursorSchema.optional() });
const addressSchema = z.email().max(320);
const replyArgs = z.strictObject({
  messageId: graphId,
  expectedChangeKey: graphId,
  to: z
    .array(addressSchema)
    .min(1)
    .max(25)
    .refine((addresses) => new Set(addresses).size === addresses.length),
  text: z
    .string()
    .max(8_000)
    .refine((value) => value.trim().length > 0),
});

const recipient = z.object({ emailAddress: z.object({ address: z.string().max(320) }) });
const messageSummary = z.object({
  id: graphId,
  parentFolderId: graphId,
  subject: z.string().nullish(),
  from: recipient.nullish(),
  conversationId: graphId.nullish(),
  receivedDateTime: z.iso.datetime({ offset: true }).nullish(),
  webLink: z.string().nullish(),
});
const messageDetail = messageSummary.extend({
  changeKey: graphId,
  replyTo: z.array(recipient).max(25).optional(),
  uniqueBody: z.object({ contentType: z.string(), content: z.string() }).nullish(),
});
const deltaLink = z.object({
  '@odata.nextLink': cursorSchema.optional(),
  '@odata.deltaLink': cursorSchema.optional(),
  value: z.array(z.unknown()).max(100),
});
const removedRecord = z.object({ '@removed': z.object({}) });
const messages = z.object({
  value: z.array(messageSummary).max(100),
  '@odata.nextLink': z.string().optional(),
});

const summaryFields = 'id,parentFolderId,subject,from,conversationId,receivedDateTime,webLink';
const detailFields = `${summaryFields},changeKey,replyTo,uniqueBody`;
const outlookHosts = ['outlook.office.com', 'outlook.office365.com', 'outlook.live.com'];

function messagesPath(input: GraphInput): string {
  return `/me/mailFolders/${graphSegment(input.resourceId)}/messages`;
}

function messageProjection(message: z.infer<typeof messageSummary>, folderId: string) {
  if (message.parentFolderId !== folderId) {
    throw new Error('Outlook message is outside the selected folder.');
  }
  return {
    id: message.id,
    subject: message.subject?.slice(0, 500) ?? '',
    from: addressSchema.safeParse(message.from?.emailAddress.address).data ?? null,
    receivedAt: message.receivedDateTime ?? null,
    conversationId: message.conversationId ?? null,
    url: microsoftLink(message.webLink ?? undefined, outlookHosts),
  };
}

async function readMessage(
  input: GraphInput,
  messageId: string,
): Promise<z.infer<typeof messageDetail>> {
  const path = withGraphQuery(`${messagesPath(input)}/${graphSegment(messageId)}`, {
    $select: detailFields,
  });
  const result = messageDetail.parse(
    await graphJson(input, path, { headers: { prefer: 'outlook.body-content-type="text"' } }),
  );
  if (result.id !== messageId || result.parentFolderId !== input.resourceId) {
    throw new Error('Outlook message is outside the selected folder.');
  }
  return result;
}

function replyAddresses(message: z.infer<typeof messageDetail>): string[] {
  const recipients = message.replyTo?.length ? message.replyTo : message.from ? [message.from] : [];
  return [
    ...new Set(recipients.map(({ emailAddress }) => addressSchema.parse(emailAddress.address))),
  ];
}

function checkedDeltaPath(input: GraphInput, cursor: string): string {
  const url = URL.parse(cursor);
  const route = url?.pathname.match(/^\/v1\.0\/me\/mailFolders\/([^/]+)\/messages\/delta$/iu);
  const parameters = url && [...url.searchParams.entries()];
  if (
    url?.origin !== 'https://graph.microsoft.com' ||
    !route?.[1] ||
    decodeURIComponent(route[1]) !== input.resourceId ||
    url.username ||
    url.password ||
    url.hash ||
    parameters?.length !== 1 ||
    !parameters.every(([key, token]) => ['$skiptoken', '$deltatoken'].includes(key) && token)
  ) {
    throw new Error('Outlook cursor is outside the selected folder.');
  }
  return `${messagesPath(input)}/delta${url.search}`;
}

export const outlookMailActions: readonly ConnectorAction[] = [
  {
    id: 'outlook-mail.list-messages',
    kind: 'read',
    resourceKind: 'folder',
    description: 'Read recent message summaries in the selected Outlook folder.',
    args: messageListArgs,
    async execute(input: GraphInput): Promise<unknown> {
      const { limit = 15 } = messageListArgs.parse(input.args);
      const path = withGraphQuery(messagesPath(input), {
        $top: String(limit),
        $orderby: 'receivedDateTime desc',
        $select: summaryFields,
      });
      const result = messages.parse(await graphJson(input, path));
      return {
        messages: result.value
          .slice(0, limit)
          .map((message) => messageProjection(message, input.resourceId)),
        truncated: result['@odata.nextLink'] !== undefined || result.value.length > limit,
      };
    },
  },
  {
    id: 'outlook-mail.get-message',
    kind: 'read',
    resourceKind: 'folder',
    description: 'Read an Outlook message and the exact current reply recipients and revision.',
    args: messageArgs,
    async execute(input: GraphInput): Promise<unknown> {
      const { messageId } = messageArgs.parse(input.args);
      const message = await readMessage(input, messageId);
      const body = message.uniqueBody;
      return {
        ...messageProjection(message, input.resourceId),
        text: body?.contentType.toLowerCase() === 'text' ? body.content.slice(0, 12_000) : null,
        changeKey: message.changeKey,
        replyTo: replyAddresses(message),
      };
    },
  },
  {
    id: 'outlook-mail.poll-folder',
    kind: 'read',
    resourceKind: 'folder',
    description: 'Read one page of Outlook folder changes and return the continuation cursor.',
    args: deltaArgs,
    async execute(input: GraphInput): Promise<unknown> {
      const { cursor } = deltaArgs.parse(input.args);
      const path = cursor
        ? checkedDeltaPath(input, cursor)
        : withGraphQuery(`${messagesPath(input)}/delta`, {
            $select: summaryFields,
            $top: '20',
            changeType: 'created',
          });
      const result = deltaLink.parse(
        await graphJson(input, path, {
          headers: { 'content-type': 'application/json', prefer: 'odata.maxpagesize=20' },
        }),
      );
      const next = result['@odata.nextLink'] ?? result['@odata.deltaLink'];
      if (!next) throw new Error('Outlook did not return the next folder cursor.');
      checkedDeltaPath(input, next);
      return {
        messages: result.value.flatMap((entry) => {
          if (removedRecord.safeParse(entry).success) return [];
          const parsed = messageSummary.safeParse(entry);
          return parsed.success ? [messageProjection(parsed.data, input.resourceId)] : [];
        }),
        cursor: next,
        hasMore: result['@odata.nextLink'] !== undefined,
      };
    },
  },
  {
    id: 'outlook-mail.send-reply',
    kind: 'write',
    resourceKind: 'folder',
    description: 'Send the reviewed reply text to the reviewed recipients of the selected message.',
    args: replyArgs,
    async execute(input: GraphInput): Promise<unknown> {
      const { messageId, expectedChangeKey, to, text } = replyArgs.parse(input.args);
      const current = await readMessage(input, messageId);
      const addresses = replyAddresses(current).sort();
      if (
        current.changeKey !== expectedChangeKey ||
        addresses.length !== to.length ||
        [...to].sort().some((address, index) => address !== addresses[index])
      ) {
        throw new Error('Outlook reply recipients or source revision changed after review.');
      }
      const path = `${messagesPath(input)}/${graphSegment(messageId)}/reply`;
      const response = await graphResponse(
        input,
        path,
        writeJson('POST', {
          message: {
            toRecipients: to.map((address) => ({ emailAddress: { address } })),
            body: { contentType: 'text', content: text },
          },
        }),
      );
      await response.body?.cancel();
      return { accepted: true, messageId };
    },
  },
];
