import {
  defineCommand,
  defineQuery,
  type CommandEndpoint,
  type QueryEndpoint,
} from '../endpoints.js';
import {
  messageDirectorySchema,
  messagePetStateSchema,
  messagePetStatesSchema,
  postedMessageSchema,
  type MessageDirectory,
  type MessagePetState,
  type MessagePetStates,
  type PostedMessage,
} from '../schemas/messages.js';

export interface PostMessageInput {
  readonly text: string;
  /** Explicit addressees: people who can read the item, or your own pets. The text is never parsed. */
  readonly to?: readonly { readonly id: string; readonly kind: 'person' | 'pet' }[];
}

const itemPath = (itemId: string) => `/api/v1/items/${encodeURIComponent(itemId)}`;

/**
 * Posts a message under an item you can write to, or a reply under a message. The author is the
 * caller (and the token's name when the call carries one). A message that addresses a pet needs the
 * app, or a token with the pets:send scope under the workspace's "agents may address pets" switch;
 * the answer says where each addressed pet's turn stands and carries the poster's pet budget.
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

/** Who a message under this item can address: your pets (in the app) and people who can read it. */
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
