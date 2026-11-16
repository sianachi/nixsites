import {
  defineCommand,
  defineQuery,
  type CommandEndpoint,
  type QueryEndpoint,
} from '../endpoints.js';
import {
  conversationSchema,
  conversationMessagesSchema,
  type Conversation,
  type ConversationMessages,
  type CreateConversationInput,
} from '../schemas/conversations.js';

const key = (itemId: string) => ['conversations', itemId] as const;
const path = (itemId: string) => `/api/v1/conversations/${encodeURIComponent(itemId)}`;
export const create = (
  workspaceId: string,
  input: CreateConversationInput,
): CommandEndpoint<Conversation> =>
  defineCommand({
    operation: 'conversations.create',
    method: 'POST',
    path: `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/conversations`,
    body: input,
    schema: conversationSchema,
    invalidates: [['workspaces', workspaceId]],
  });
export const importTranscript = (
  workspaceId: string,
  input: CreateConversationInput,
): CommandEndpoint<Conversation> =>
  defineCommand({
    operation: 'conversations.import',
    method: 'POST',
    path: `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/conversations/import`,
    body: input,
    schema: conversationSchema,
    invalidates: [['workspaces', workspaceId]],
  });
export const conversation = (itemId: string): QueryEndpoint<Conversation> =>
  defineQuery({
    operation: 'conversations.get',
    path: path(itemId),
    schema: conversationSchema,
    cacheKey: key(itemId),
  });
export const messages = (
  itemId: string,
  options: { readonly cursor?: string; readonly limit?: number } = {},
): QueryEndpoint<ConversationMessages> =>
  defineQuery({
    operation: 'conversations.messages',
    path: `${path(itemId)}/messages`,
    schema: conversationMessagesSchema,
    query: { cursor: options.cursor, limit: options.limit ?? 50 },
    cacheKey: [...key(itemId), 'messages', options.cursor ?? ''],
  });
export const watch = (itemId: string, after: number): QueryEndpoint<Conversation> =>
  defineQuery({
    operation: 'conversations.watch',
    retain: false,
    path: `${path(itemId)}/watch`,
    query: { after },
    schema: conversationSchema,
    cacheKey: [...key(itemId), 'watch', String(after)],
  });
export const send = (
  itemId: string,
  input: { readonly requestId: string; readonly text: string; readonly model?: string },
): CommandEndpoint<Conversation> =>
  defineCommand({
    operation: 'conversations.send',
    method: 'POST',
    path: `${path(itemId)}/turns`,
    body: input,
    schema: conversationSchema,
    invalidates: [key(itemId)],
  });
export const cancel = (itemId: string): CommandEndpoint<Conversation> =>
  defineCommand({
    operation: 'conversations.cancel',
    method: 'POST',
    path: `${path(itemId)}/cancel`,
    body: {},
    schema: conversationSchema,
    invalidates: [key(itemId)],
  });
export const sources = (
  itemId: string,
  sourceWorkspaceIds: readonly string[],
  expectedRevision: number,
): CommandEndpoint<Conversation> =>
  defineCommand({
    operation: 'conversations.sources',
    method: 'PUT',
    path: `${path(itemId)}/sources`,
    body: { sourceWorkspaceIds, expectedRevision },
    schema: conversationSchema,
    invalidates: [key(itemId)],
  });

export const configure = (
  itemId: string,
  input: { readonly sourceWorkspaceIds: readonly string[]; readonly petId: string },
): CommandEndpoint<Conversation> =>
  defineCommand({
    operation: 'conversations.configure',
    method: 'POST',
    path: `${path(itemId)}/configure`,
    body: input,
    schema: conversationSchema,
    invalidates: [key(itemId)],
  });
