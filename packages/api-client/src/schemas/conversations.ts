import { z } from 'zod';

export const conversationTurnSchema = z.object({
  id: z.uuid(),
  requestId: z.uuid(),
  status: z.enum(['running', 'completed', 'cancelled', 'interrupted', 'failed']),
  error: z.string().nullable(),
  text: z.string().default(''),
});
export const conversationSchema = z.object({
  itemId: z.uuid(),
  workspaceId: z.uuid(),
  title: z.string(),
  sourceWorkspaceIds: z.array(z.uuid()),
  petId: z.uuid(),
  revision: z.number().int().nonnegative(),
  canSend: z.boolean(),
  canEdit: z.boolean().default(false),
  turn: conversationTurnSchema.nullable(),
});
export const conversationMessageSchema = z.object({
  id: z.uuid(),
  role: z.enum(['user', 'assistant', 'system']),
  text: z.string(),
  seq: z.string(),
  createdAt: z.string(),
  authorId: z.uuid().nullable(),
  // The workspaces an assistant reply was answered from; absent on older replies.
  sourceWorkspaceIds: z.array(z.uuid()).nullish(),
});
export const conversationMessagesSchema = z.object({
  items: z.array(conversationMessageSchema),
  nextCursor: z.string().nullable(),
});
export const createConversationInputSchema = z.object({
  title: z.string().trim().min(1).max(240),
  parentId: z.uuid().nullable(),
  sourceWorkspaceIds: z.array(z.uuid()).min(1),
  petId: z.uuid(),
  groupId: z.uuid().optional(),
  messages: z.array(conversationMessageSchema.pick({ role: true, text: true })).optional(),
});
export type Conversation = z.infer<typeof conversationSchema>;
export type ConversationMessage = z.infer<typeof conversationMessageSchema>;
export type ConversationMessages = z.infer<typeof conversationMessagesSchema>;
export type CreateConversationInput = z.infer<typeof createConversationInputSchema>;
