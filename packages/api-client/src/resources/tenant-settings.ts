/** Tenant-wide switches for MCP and public links. Administrators write; every caller may read. */

import {
  defineCommand,
  defineQuery,
  type CommandEndpoint,
  type QueryEndpoint,
} from '../endpoints.js';
import { tenantSettingsSchema, type TenantSettings } from '../schemas/tenant-settings.js';

const settingsKey = ['tenant', 'settings'] as const;

export const getTenantSettings = (): QueryEndpoint<TenantSettings> =>
  defineQuery({
    operation: 'tenant.settings.get',
    path: '/api/v1/tenant/settings',
    schema: tenantSettingsSchema,
    cacheKey: settingsKey,
    staleAfterMs: 0,
  });

/** Sends only the fields that change. Tenant administrators only; others get 403. */
export const setTenantSettings = (input: {
  readonly mcpEnabled?: boolean;
  readonly publicLinksEnabled?: boolean;
}): CommandEndpoint<TenantSettings> =>
  defineCommand({
    operation: 'tenant.settings.set',
    method: 'PUT',
    path: '/api/v1/tenant/settings',
    schema: tenantSettingsSchema,
    body: input,
    invalidates: [['me'], settingsKey],
  });
