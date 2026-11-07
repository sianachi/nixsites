/** The signed-in caller, as `GET /api/v1/me` returns it. */

import { z } from 'zod';
import type { CurrentPrincipalContract } from '../contracts.js';

export const currentPrincipalSchema = z.object({
  id: z.uuid(),
  tenantId: z.uuid(),
  displayName: z.string(),
  email: z.string().nullable(),
  isTenantAdministrator: z.boolean(),
  /** Deployment features the shell may offer; defaulted so an older Core answers without them. */
  features: z
    .object({
      sites: z.boolean().default(false),
      mcpUrl: z.string().nullable().default(null),
      /** Listed in `Nix:Sites:Operators`: may read instance-wide data such as backup status. */
      operator: z.boolean().default(false),
      /** May decide first publishes: configured, granted in Settings, or an administrator when none is configured. */
      siteApprover: z.boolean().default(false),
      /** Public links work here: the install allows them and the organization has not turned them off. */
      publicLinks: z.boolean().default(false),
      /** The organization's own MCP switch (a null `mcpUrl` alone cannot tell off from not offered). */
      mcpEnabled: z.boolean().default(true),
    })
    .default({
      sites: false,
      mcpUrl: null,
      operator: false,
      siteApprover: false,
      publicLinks: false,
      mcpEnabled: true,
    }),
});

export type CurrentPrincipal = z.infer<typeof currentPrincipalSchema>;

const _currentPrincipalContract =
  currentPrincipalSchema satisfies z.ZodType<CurrentPrincipalContract>;
void _currentPrincipalContract;
