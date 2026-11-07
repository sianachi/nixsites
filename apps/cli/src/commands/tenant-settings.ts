/**
 * `nixctl tenant settings get|set`: the organization's switches for remote MCP and public links.
 *
 * Tenant administrators only, and human-only: Core refuses access tokens on these routes, so this
 * works with a browser-approved login and is deliberately not an MCP tool.
 */

import { tenantSettings } from '@nix/api-client';
import { resolveSession, type SessionDeps } from './shared.ts';
import { printResult, type OutputOptions } from '../output.ts';
import type { Session } from '../session.ts';

export interface TenantSettingsFlags {
  readonly mcp?: string | undefined;
  readonly publicLinks?: string | undefined;
}

function parseOnOff(value: string | undefined, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === 'on') return true;
  if (value === 'off') return false;
  throw new Error(`${name} takes on or off, not '${value}'.`);
}

/** Turns `--mcp` and `--public-links` into the request body; at least one is required. */
export function parseTenantSettingsFlags(
  flags: TenantSettingsFlags,
): tenantSettings.TenantSettingsInput {
  const mcpEnabled = parseOnOff(flags.mcp, '--mcp');
  const publicLinksEnabled = parseOnOff(flags.publicLinks, '--public-links');
  if (mcpEnabled === undefined && publicLinksEnabled === undefined) {
    throw new Error('Give --mcp on|off, --public-links on|off, or both.');
  }
  return {
    ...(mcpEnabled === undefined ? {} : { mcpEnabled }),
    ...(publicLinksEnabled === undefined ? {} : { publicLinksEnabled }),
  };
}

export async function executeGetTenantSettings(
  session: Session,
): Promise<tenantSettings.TenantSettings> {
  return session.client.query(tenantSettings.getTenantSettings());
}

export async function executeSetTenantSettings(
  session: Session,
  flags: TenantSettingsFlags,
): Promise<tenantSettings.TenantSettings> {
  return session.client.execute(tenantSettings.setTenantSettings(parseTenantSettingsFlags(flags)));
}

export async function getTenantSettings(
  profileName: string | undefined,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const session = await resolveSession(profileName, deps);
  printResult(await executeGetTenantSettings(session), output);
}

export async function setTenantSettings(
  profileName: string | undefined,
  flags: TenantSettingsFlags,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  // Validate before any network or sign-in work.
  parseTenantSettingsFlags(flags);
  const session = await resolveSession(profileName, deps);
  printResult(await executeSetTenantSettings(session, flags), output);
}
