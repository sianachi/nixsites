import { z } from 'zod';
import type { components } from '../generated/api.js';
import { cursorPageSchema } from './pagination.js';

const tenantRoleGrantSchema = z.object({
  subjectType: z.string(),
  subjectId: z.uuid(),
  subjectDisplayName: z.string(),
  role: z.string(),
  grantedAt: z.iso.datetime({ offset: true }),
});

export const tenantRoleGrantPageSchema = cursorPageSchema(tenantRoleGrantSchema);

export type TenantRoleGrant = z.infer<typeof tenantRoleGrantSchema>;

const _contract = tenantRoleGrantSchema satisfies z.ZodType<
  components['schemas']['RoleGrantResponse']
>;
void _contract;
