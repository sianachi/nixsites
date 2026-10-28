/** The caller's own workspace groups and pins, as `GET/PUT /api/v1/me/workspace-arrangement` carry them. */

import { z } from 'zod';

const workspaceGroupSchema = z.object({
  id: z.uuid(),
  name: z.string().trim().min(1).max(80),
  workspaceIds: z.array(z.uuid()).max(200),
  conversationItemIds: z.array(z.uuid()).max(200).optional(),
  lastDestinationWorkspaceId: z.uuid().nullable().optional(),
  lastDestinationParentId: z.uuid().nullable().optional(),
});

export const workspaceArrangementInputSchema = z.object({
  groups: z.array(workspaceGroupSchema).max(50),
  pinnedWorkspaceIds: z.array(z.uuid()).max(200),
});

export const workspaceArrangementResponseSchema = z.object({
  revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  groups: z.array(workspaceGroupSchema),
  pinnedWorkspaceIds: z.array(z.uuid()),
});

export type WorkspaceGroup = z.infer<typeof workspaceGroupSchema>;
export type WorkspaceArrangementInput = z.infer<typeof workspaceArrangementInputSchema>;
export type WorkspaceArrangementResponse = z.infer<typeof workspaceArrangementResponseSchema>;
