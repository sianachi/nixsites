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
      /** Public links are usable: allowed by the deployment and switched on by the tenant. */
      publicLinks: z.boolean().default(false),
      /** Listed in `Nix:Sites:Operators`: may read instance-wide data such as backup status. */
      operator: z.boolean().default(false),
      /** May decide first publishes: configured, granted in Settings, or an administrator when none is configured. */
      siteApprover: z.boolean().default(false),
    })
    .default({
      sites: false,
      mcpUrl: null,
      publicLinks: false,
      operator: false,
      siteApprover: false,
    }),
});

export type CurrentPrincipal = z.infer<typeof currentPrincipalSchema>;

const _currentPrincipalContract =
  currentPrincipalSchema satisfies z.ZodType<CurrentPrincipalContract>;
void _currentPrincipalContract;
