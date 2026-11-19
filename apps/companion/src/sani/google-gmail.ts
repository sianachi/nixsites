import { z } from 'zod';

import type { ConnectorAction } from './connector.ts';
import {
  GoogleResponseError,
  decodePageToken,
  encodePageToken,
  googleId,
  googleJson,
  googleJsonBody,
  googlePageToken,
  googlePageCursor,
  type GoogleCall,
} from './google-http.ts';

const mailbox = 'https://gmail.googleapis.com/gmail/v1/users/me/';
const selectedLabel = 'gmail-label';
const historyId = z.string().regex(/^\d{1,25}$/u);
const textLimit = 16_000;
const messageRef = z.object({ id: googleId, threadId: googleId });
const headers = z.array(z.object({ name: z.string().max(72), value: z.string().max(8192) }));
const messageRevision = messageRef.extend({
  historyId,
  labelIds: z.array(googleId).max(512).default([]),
});
const messageHeaders = messageRevision.extend({
  payload: z.object({ headers: headers.max(128) }),
});
const subjectLine = z
  .string()
  .min(1)
  .max(160)
  .regex(/^\P{Cc}+$/u);
const email = z.email().max(254);
const page = z.strictObject({
  pageToken: googlePageCursor.optional(),
  pageSize: z.number().int().min(1).max(50).default(25),
});
const readMessage = z.strictObject({ messageId: googleId });
const listChanges = page.extend({ after: historyId });
const sendReply = z.strictObject({
  messageId: googleId,
  historyId,
  to: email,
  subject: subjectLine,
  body: z
    .string()
    .min(1)
    .max(textLimit)
    .refine((body) => !/\p{Cc}/u.test(body.replace(/[\t\r\n]/gu, ''))),
});

interface MessagePart {
  mimeType?: string | undefined;
  filename?: string | undefined;
  body?: { data?: string | undefined } | undefined;
  parts?: MessagePart[] | undefined;
}

const leafPart = z.object({
  mimeType: z.string().max(250).optional(),
  filename: z.string().max(1024).optional(),
  body: z
    .object({
      data: z
        .string()
        .regex(/^[\w-]+={0,2}$/u)
        .max(524_288)
        .optional(),
    })
    .optional(),
});
const messagePart = leafPart.extend({
  parts: z
    .array(leafPart.extend({ parts: z.array(leafPart).max(100).optional() }))
    .max(100)
    .optional(),
});

function inLabel<T extends z.infer<typeof messageRevision>>(
  call: GoogleCall,
  id: string,
  message: T,
): T {
  if (message.id !== id || !message.labelIds.includes(googleId.parse(call.resourceId))) {
    throw new Error('The Gmail message is outside the connected label.');
  }
  return message;
}

async function selectedMessage(call: GoogleCall, id: string) {
  const url = new URL(`messages/${id}`, mailbox);
  url.searchParams.set('format', 'metadata');
  url.searchParams.set('fields', 'id,threadId,historyId,labelIds,payload(headers)');
  for (const name of ['From', 'Reply-To', 'Subject', 'Message-ID']) {
    url.searchParams.append('metadataHeaders', name);
  }
  return inLabel(call, id, await googleJson(call, url, messageHeaders));
}

function header(values: z.infer<typeof headers>, name: string): string | undefined {
  const matched = values.filter((value) => value.name.toLowerCase() === name);
  if (matched.length > 1) throw new Error('The Gmail message has ambiguous headers.');
  return matched[0]?.value;
}

function address(value: string | undefined): string | undefined {
  if (value === undefined || /\p{Cc}/u.test(value)) return undefined;
  const bracketed = /^(?:"(?:[^"\\]|\\.)*"|[^<>",;]+)?\s*<([^<>]+)>\s*$/u.exec(value);
  return email.safeParse((bracketed?.[1] ?? value).trim()).data;
}

function replyTo(values: z.infer<typeof headers>): string | undefined {
  return address(header(values, 'reply-to') ?? header(values, 'from'));
}

function replySubject(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return subjectLine.safeParse(/^re:/iu.test(value) ? value : `Re: ${value}`).data;
}

function textPart(part: MessagePart | undefined): string | undefined {
  if (part?.filename) return undefined;
  if (part?.mimeType?.toLowerCase() === 'text/plain' && part.body?.data) {
    return Buffer.from(part.body.data, 'base64url').toString('utf8').slice(0, textLimit);
  }
  for (const child of part?.parts ?? []) {
    const found = textPart(child);
    if (found !== undefined) return found;
  }
  return undefined;
}

function encodedSubject(subject: string): string {
  if (/^[ -~]+$/u.test(subject)) return subject;
  const words: string[] = [];
  let chunk = '';
  for (const character of subject) {
    if (Buffer.byteLength(chunk + character) > 42) {
      words.push(chunk);
      chunk = '';
    }
    chunk += character;
  }
  return [...words, chunk]
    .map((word) => `=?UTF-8?B?${Buffer.from(word).toString('base64')}?=`)
    .join('\r\n ');
}

function replyRaw(args: z.infer<typeof sendReply>, reference: string): string {
  const body = Buffer.from(args.body.replace(/\r\n|\r|\n/gu, '\r\n')).toString('base64');
  return Buffer.from(
    [
      `To: ${args.to}`,
      `Subject: ${encodedSubject(args.subject)}`,
      `In-Reply-To: ${reference}`,
      `References: ${reference}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      ...(body.match(/.{1,76}/gu) ?? []),
    ].join('\r\n'),
  ).toString('base64url');
}

export const gmailActions: readonly ConnectorAction[] = [
  {
    id: 'gmail.list-messages',
    kind: 'read',
    resourceKind: selectedLabel,
    description: 'List one page of messages in the connected Gmail label.',
    args: page,
    async execute(call: GoogleCall): Promise<unknown> {
      const { pageToken, pageSize } = page.parse(call.args);
      const labelId = googleId.parse(call.resourceId);
      const selector = ['messages', pageSize];
      const cursor = decodePageToken(call, selector, pageToken);
      const url = new URL('messages', mailbox);
      url.searchParams.set('labelIds', labelId);
      url.searchParams.set('maxResults', String(pageSize));
      url.searchParams.set('fields', 'messages(id,threadId),nextPageToken');
      if (labelId === 'TRASH' || labelId === 'SPAM')
        url.searchParams.set('includeSpamTrash', 'true');
      if (cursor !== undefined) url.searchParams.set('pageToken', cursor);
      const result = await googleJson(
        call,
        url,
        z.object({
          messages: z.array(messageRef).max(50).default([]),
          nextPageToken: googlePageToken.optional(),
        }),
      );
      return { ...result, nextPageToken: encodePageToken(call, selector, result.nextPageToken) };
    },
  },
  {
    id: 'gmail.get-message',
    kind: 'read',
    resourceKind: selectedLabel,
    description: 'Read one selected Gmail message and inspect the recipient for a reply.',
    args: readMessage,
    async execute(call: GoogleCall): Promise<unknown> {
      const { messageId } = readMessage.parse(call.args);
      const metadata = await selectedMessage(call, messageId);
      const url = new URL(`messages/${messageId}`, mailbox);
      url.searchParams.set('format', 'full');
      url.searchParams.set(
        'fields',
        'id,threadId,historyId,labelIds,snippet,payload(mimeType,filename,body(data),parts(mimeType,filename,body(data),parts(mimeType,filename,body(data))))',
      );
      const message = inLabel(
        call,
        messageId,
        await googleJson(
          call,
          url,
          messageRevision.extend({
            snippet: z.string().max(8192).optional(),
            payload: messagePart.optional(),
          }),
        ),
      );
      if (message.historyId !== metadata.historyId || message.threadId !== metadata.threadId) {
        throw new Error('The Gmail message changed during the read.');
      }
      const values = metadata.payload.headers;
      const plainText = textPart(message.payload);
      return {
        id: message.id,
        threadId: message.threadId,
        historyId: message.historyId,
        subject: header(values, 'subject')?.slice(0, 512),
        from: address(header(values, 'from')),
        replyTo: replyTo(values),
        replySubject: replySubject(header(values, 'subject')),
        body: plainText ?? message.snippet ?? '',
        bodySource: plainText !== undefined ? 'plain-text' : 'snippet',
      };
    },
  },
  {
    id: 'gmail.checkpoint',
    kind: 'read',
    resourceKind: selectedLabel,
    description: 'Read the current Gmail history cursor when setting up a label watch.',
    args: z.strictObject({}),
    async execute(call: GoogleCall): Promise<unknown> {
      z.strictObject({}).parse(call.args);
      const label = googleId.parse(call.resourceId);
      const url = new URL(`labels/${label}`, mailbox);
      url.searchParams.set('fields', 'id');
      const found = await googleJson(call, url, z.object({ id: googleId }));
      if (found.id !== label) throw new Error('The connected Gmail label is unavailable.');
      const profile = new URL('profile', mailbox);
      profile.searchParams.set('fields', 'historyId');
      return googleJson(call, profile, z.object({ historyId }));
    },
  },
  {
    id: 'gmail.list-changes',
    kind: 'read',
    resourceKind: selectedLabel,
    description: 'Find messages added to the connected Gmail label since a saved checkpoint.',
    args: listChanges,
    async execute(call: GoogleCall): Promise<unknown> {
      const { after, pageSize, pageToken } = listChanges.parse(call.args);
      const label = googleId.parse(call.resourceId);
      const selector = ['history', after, pageSize];
      const cursor = decodePageToken(call, selector, pageToken);
      const url = new URL('history', mailbox);
      url.searchParams.set('labelId', label);
      url.searchParams.set('startHistoryId', after);
      url.searchParams.set('maxResults', String(pageSize));
      url.searchParams.append('historyTypes', 'messageAdded');
      url.searchParams.append('historyTypes', 'labelAdded');
      url.searchParams.set(
        'fields',
        'historyId,nextPageToken,history(messagesAdded(message(id,threadId)),labelsAdded(labelIds,message(id,threadId)))',
      );
      if (cursor !== undefined) url.searchParams.set('pageToken', cursor);
      try {
        const result = await googleJson(
          call,
          url,
          z.object({
            historyId,
            nextPageToken: googlePageToken.optional(),
            history: z
              .array(
                z.object({
                  messagesAdded: z
                    .array(z.object({ message: messageRef }))
                    .max(100)
                    .default([]),
                  labelsAdded: z
                    .array(z.object({ message: messageRef, labelIds: z.array(googleId).max(512) }))
                    .max(100)
                    .default([]),
                }),
              )
              .max(50)
              .default([]),
          }),
        );
        const messages = new Map<string, z.infer<typeof messageRef>>();
        for (const event of result.history) {
          for (const { message } of event.messagesAdded) messages.set(message.id, message);
          for (const assignment of event.labelsAdded) {
            if (assignment.labelIds.includes(label))
              messages.set(assignment.message.id, assignment.message);
          }
        }
        if (messages.size > 100)
          throw new Error('Gmail returned too many changes. Retry with a smaller page.');
        return {
          status: 'ready',
          messages: [...messages.values()],
          historyId: result.nextPageToken === undefined ? result.historyId : after,
          nextPageToken: encodePageToken(call, selector, result.nextPageToken),
        };
      } catch (error) {
        if (error instanceof GoogleResponseError && error.status === 404) {
          return { status: 'resync_required' };
        }
        throw error;
      }
    },
  },
  {
    id: 'gmail.send-reply',
    kind: 'write',
    resourceKind: selectedLabel,
    description: 'Send the reviewed Gmail reply to its exact recipient in the connected label.',
    args: sendReply,
    async execute(call: GoogleCall): Promise<unknown> {
      const args = sendReply.parse(call.args);
      const current = await selectedMessage(call, args.messageId);
      const values = current.payload.headers;
      const recipient = replyTo(values);
      const reference = header(values, 'message-id');
      if (
        current.historyId !== args.historyId ||
        recipient?.toLowerCase() !== args.to.toLowerCase() ||
        replySubject(header(values, 'subject')) !== args.subject ||
        reference === undefined ||
        reference.length > 255 ||
        !/^<[^<>\s\p{Cc}]+@[^<>\s\p{Cc}]+>$/u.test(reference)
      ) {
        throw new Error('The Gmail reply source changed or cannot be safely addressed.');
      }
      const url = new URL('messages/send', mailbox);
      url.searchParams.set('fields', 'id,threadId');
      const sent = await googleJson(
        call,
        url,
        messageRef,
        googleJsonBody('POST', { threadId: current.threadId, raw: replyRaw(args, reference) }),
      );
      if (sent.threadId !== current.threadId)
        throw new Error('Gmail returned an unexpected reply receipt.');
      return { id: sent.id, threadId: sent.threadId, to: args.to };
    },
  },
];
