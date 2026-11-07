/** The organization's switches for remote MCP and public links; tenant administrators only. */

import { z } from 'zod';
import {
  defineCommand,
  defineQuery,
  type CommandEndpoint,
  type QueryEndpoint,
} from '../endpoints.js';

/** `*Enabled` is the stored switch; `*Available` means the deployment allows the feature at all. */
export const tenantSettingsSchema = z.object({
  mcpEnabled: z.boolean(),
  publicLinksEnabled: z.boolean(),
  mcpAvailable: z.boolean(),
  publicLinksAvailable: z.boolean(),
});

export type TenantSettings = z.infer<typeof tenantSettingsSchema>;

/** An omitted field is unchanged. */
export interface TenantSettingsInput {
  readonly mcpEnabled?: boolean;
  readonly publicLinksEnabled?: boolean;
}

const settingsKey = ['tenant', 'settings'] as const;
const settingsPath = '/api/v1/tenant/settings';

export const getTenantSettings = (): QueryEndpoint<TenantSettings> =>
  defineQuery({
    operation: 'tenant.settings.get',
    path: settingsPath,
    schema: tenantSettingsSchema,
    cacheKey: settingsKey,
    staleAfterMs: 0,
  });

export const setTenantSettings = (input: TenantSettingsInput): CommandEndpoint<TenantSettings> =>
  defineCommand({
    operation: 'tenant.settings.set',
    method: 'PUT',
    path: settingsPath,
    schema: tenantSettingsSchema,
    body: input,
    // The response is the new state; the "me" profile carries mcpUrl and publicLinks.
    invalidates: [settingsKey, ['me']],
  });
