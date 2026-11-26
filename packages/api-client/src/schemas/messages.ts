import { z } from 'zod';

/** One addressee, as stored with a message. The name is as it was when the message was posted. */
export const messageRecipientSchema = z.object({
  id: z.uuid(),
  kind: z.enum(['person', 'pet']),
  name: z.string(),
});

/** Who wrote a message: a person, with the access token they used if any, or one of their pets. */
export const messageAuthorSchema = z.object({
  id: z.uuid(),
  kind: z.enum(['person', 'pet']),
  name: z.string(),
  via: z.string().optional(),
});

export const messageSchema = z.object({
  text: z.string(),
  author: messageAuthorSchema,
  to: z.array(messageRecipientSchema),
});

export const messageAddresseeSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  kind: z.enum(['person', 'pet']),
});

export const messageDirectorySchema = z.object({ addressees: z.array(messageAddresseeSchema) });

export type MessageRecipient = z.infer<typeof messageRecipientSchema>;
export type MessageAuthor = z.infer<typeof messageAuthorSchema>;
export type Message = z.infer<typeof messageSchema>;
export type MessageAddressee = z.infer<typeof messageAddresseeSchema>;
export type MessageDirectory = z.infer<typeof messageDirectorySchema>;

/** The item kind of a message. Mirrors `MessageItem.Type` in Core. */
export const MESSAGE_ITEM_TYPE = 'message';

/** The longest message text Core accepts. */
export const MESSAGE_MAX_LENGTH = 16_000;

/**
 * Reads the message an item of type `message` carries, or null when it is not one or its server-owned
 * `$message` property is missing or unreadable (an older client or a damaged row never throws here).
 */
export function readMessage(item: {
  readonly type: string;
  readonly properties: Readonly<Record<string, unknown>>;
}): Message | null {
  if (item.type !== MESSAGE_ITEM_TYPE) return null;
  const raw = item.properties.$message;
  if (typeof raw !== 'string') return null;
  try {
    const parsed = messageSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
