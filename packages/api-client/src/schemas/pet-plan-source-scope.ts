import { z } from 'zod';

export const sourceScopeSchema = z.object({
  kind: z.enum(['workspace', 'selected', 'subtree']),
  itemIds: z.array(z.uuid()).max(100).nullish(),
  readOnlyWorkspaceIds: z.array(z.uuid()).max(20).nullish(),
});
