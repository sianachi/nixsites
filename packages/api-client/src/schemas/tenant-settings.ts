import { z } from 'zod';

/** `*Available` is the deployment's allowance; `*Enabled` is the tenant's own choice. */
export const tenantSettingsSchema = z.object({
  mcpEnabled: z.boolean(),
  publicLinksEnabled: z.boolean(),
  mcpAvailable: z.boolean(),
  publicLinksAvailable: z.boolean(),
});

export type TenantSettings = z.infer<typeof tenantSettingsSchema>;
