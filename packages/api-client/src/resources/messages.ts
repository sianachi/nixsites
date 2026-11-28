import {
  defineCommand,
  defineQuery,
  type CommandEndpoint,
  type QueryEndpoint,
} from '../endpoints.js';
import {
  markMessagesReadSchema,
  messageDirectorySchema,
  messageInboxSchema,
  messagePetStateSchema,
  messagePetStatesSchema,
  postedMessageSchema,
  type MarkMessagesRead,
  type MessageDirectory,
  type MessageInbox,
  type MessagePetState,
  type MessagePetStates,
  type PostedMessage,
} from '../schemas/messages.js';

export interface PostMessageInput {
  readonly text: string;
  /** Explicit addressees: people who can read the item, your own pets, or your own agent tokens. The text is never parsed. */
  readonly to?: readonly { readonly id: string; readonly kind: 'person' | 'pet' | 'agent' }[];
}

const itemPath = (itemId: string) => `/api/v1/items/${encodeURIComponent(itemId)}`;

/**
 * Posts a message under an item you can write to, or a reply under a message. The author is the
 * caller (and the token's name when the call carries one). A message that addresses a pet or an agent
 * needs the app, or a token with the agents scope; a pet also needs the workspace's "agents may address
 * pets" switch. The answer says where each addressed pet's turn stands and carries the poster's pet budget.
 */
export const post = (
  workspaceId: string,
  parentId: string,
  input: PostMessageInput,
): CommandEndpoint<PostedMessage> =>
  defineCommand<PostedMessage>({
    operation: 'messages.post',
    method: 'POST',
    path: `${itemPath(parentId)}/messages`,
    body: { text: input.text, to: input.to ?? [] },
    schema: postedMessageSchema,
    invalidates: [
      ['items', parentId],
      ['workspaces', workspaceId, 'items'],
    ],
  });

/** Who a message under this item can address: your pets and agents (in the app, or for an agents token) and people who can read it. */
export const directory = (itemId: string, query?: string): QueryEndpoint<MessageDirectory> =>
  defineQuery({
    operation: 'messages.directory',
    path: `${itemPath(itemId)}/message-directory`,
    schema: messageDirectorySchema,
    cacheKey: ['items', itemId, 'message-directory', query ?? ''],
    ...(query ? { query: { query } } : {}),
  });

/** Where each pet the message addressed stands; only the pets' owner sees any. */
export const petTurns = (messageId: string): QueryEndpoint<MessagePetStates> =>
  defineQuery({
    operation: 'messages.petTurns',
    path: `${itemPath(messageId)}/pet-turns`,
    schema: messagePetStatesSchema,
    cacheKey: ['items', messageId, 'pet-turns'],
  });

const decide = (
  messageId: string,
  petId: string,
  verb: 'approve' | 'dismiss',
): CommandEndpoint<MessagePetState> =>
  defineCommand<MessagePetState>({
    operation: `messages.${verb}PetTurn`,
    method: 'POST',
    path: `${itemPath(messageId)}/pet-turns/${encodeURIComponent(petId)}/${verb}`,
    schema: messagePetStateSchema,
    invalidates: [['items', messageId, 'pet-turns']],
  });

/** The pet's owner starts a waiting turn. The app only. */
export const approvePetTurn = (
  messageId: string,
  petId: string,
): CommandEndpoint<MessagePetState> => decide(messageId, petId, 'approve');

/** The pet's owner declines a waiting turn. The app only. */
export const dismissPetTurn = (
  messageId: string,
  petId: string,
): CommandEndpoint<MessagePetState> => decide(messageId, petId, 'dismiss');

/** The calling agent token's unread messages, newest first. Only a token with the agents scope has an inbox. */
export const inbox = (page?: {
  readonly after?: string;
  readonly limit?: number;
}): QueryEndpoint<MessageInbox> =>
  defineQuery({
    operation: 'messages.inbox',
    path: '/api/v1/me/message-inbox',
    schema: messageInboxSchema,
    cacheKey: ['me', 'message-inbox', page?.after ?? '', String(page?.limit ?? 0)],
    ...(page?.after || page?.limit
      ? {
          query: {
            ...(page.after ? { after: page.after } : {}),
            ...(page.limit ? { limit: String(page.limit) } : {}),
          },
        }
      : {}),
  });

/** Marks messages read in the calling agent token's inbox. */
export const markRead = (messageIds: readonly string[]): CommandEndpoint<MarkMessagesRead> =>
  defineCommand<MarkMessagesRead>({
    operation: 'messages.markRead',
    method: 'POST',
    path: '/api/v1/me/message-inbox/read',
    body: { messageIds },
    schema: markMessagesReadSchema,
    invalidates: [['me', 'message-inbox']],
  });
