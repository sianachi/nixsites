import {
  defineCommand,
  defineQuery,
  type CommandEndpoint,
  type QueryEndpoint,
} from '../endpoints.js';
import { itemSchema, type Item } from '../schemas/item.js';
import { messageDirectorySchema, type MessageDirectory } from '../schemas/messages.js';

export interface PostMessageInput {
  readonly text: string;
  /** Explicit addressees: people who can read the item, or your own pets. The text is never parsed. */
  readonly to?: readonly { readonly id: string; readonly kind: 'person' | 'pet' }[];
}

const itemPath = (itemId: string) => `/api/v1/items/${encodeURIComponent(itemId)}`;

/**
 * Posts a message under an item you can write to, or a reply under a message. The author is the
 * caller (and the token's name when the call carries one). A message that addresses a pet needs the app.
 */
export const post = (
  workspaceId: string,
  parentId: string,
  input: PostMessageInput,
): CommandEndpoint<Item> =>
  defineCommand<Item>({
    operation: 'messages.post',
    method: 'POST',
    path: `${itemPath(parentId)}/messages`,
    body: { text: input.text, to: input.to ?? [] },
    schema: itemSchema,
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
