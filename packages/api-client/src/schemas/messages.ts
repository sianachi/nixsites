import { z } from 'zod';

import { itemSchema } from './item.js';

/** One addressee, as stored with a message. The name is as it was when the message was posted. */
export const messageRecipientSchema = z.object({
  id: z.uuid(),
  kind: z.enum(['person', 'pet', 'agent']),
  name: z.string(),
});

/** Who wrote a message: a person, with the access token they used if any (its name and id), or one of their pets. */
export const messageAuthorSchema = z.object({
  id: z.uuid(),
  kind: z.enum(['person', 'pet']),
  name: z.string(),
  via: z.string().optional(),
  tokenId: z.uuid().optional(),
});

export const messageSchema = z.object({
  text: z.string(),
  author: messageAuthorSchema,
  to: z.array(messageRecipientSchema),
});

export const messageAddresseeSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  kind: z.enum(['person', 'pet', 'agent']),
});

export const messageDirectorySchema = z.object({ addressees: z.array(messageAddresseeSchema) });

/** Where one pet's turn for a message stands: pending (waits for its owner), working, answered, failed, declined or expired. */
export const messagePetStateSchema = z.object({
  petId: z.uuid(),
  name: z.string(),
  status: z.enum(['pending', 'working', 'answered', 'failed', 'declined', 'expired']),
  reason: z.string().nullable(),
  expiresAt: z.iso.datetime({ offset: true }).nullable(),
  /** A fact the pet wants remembered from the message, waiting for its owner to approve or dismiss it. */
  memory: z.string().nullish(),
  /** Why a failed turn could not start: `pets.no_provider_key`, or the retired `pets.sharing_required` on old rows. Unknown codes are kept, not refused. */
  code: z.string().nullish(),
});

export const messagePetStatesSchema = z.object({ pets: z.array(messagePetStateSchema) });

export const postedMessageSchema = z.object({
  message: itemSchema,
  pets: z.array(messagePetStateSchema),
  /** The poster's monthly pet budget, present when the message addressed a pet. */
  budget: z
    .object({
      limitUsd: z.number().nullable(),
      spentUsd: z.number().min(0),
      remainingUsd: z.number().min(0).nullable(),
      month: z.string(),
      timeZone: z.string(),
    })
    .nullable(),
});

/** One unread message in an agent token's inbox, with its thread's first message and the item the thread sits under. */
export const messageInboxEntrySchema = z.object({
  messageId: z.uuid(),
  threadId: z.uuid(),
  parentId: z.uuid().nullish(),
  workspaceId: z.uuid(),
  author: messageAuthorSchema,
  text: z.string(),
  createdAt: z.iso.datetime({ offset: true }),
});

export const messageInboxSchema = z.object({
  messages: z.array(messageInboxEntrySchema),
  /** Pass as `after` to read the next page; null at the end. */
  next: z.uuid().nullish(),
});

export const markMessagesReadSchema = z.object({ marked: z.number().int().min(0) });

export type MessageInbox = z.infer<typeof messageInboxSchema>;
export type MessageInboxEntry = z.infer<typeof messageInboxEntrySchema>;
export type MarkMessagesRead = z.infer<typeof markMessagesReadSchema>;
export type MessagePetState = z.infer<typeof messagePetStateSchema>;
export type MessagePetStates = z.infer<typeof messagePetStatesSchema>;
export type PostedMessage = z.infer<typeof postedMessageSchema>;
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
