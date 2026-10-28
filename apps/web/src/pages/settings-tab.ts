import { useSearchParams } from 'react-router';
import { z } from 'zod';

/**
 * The URL-state parameter for the settings screen's active tab, following the convention in
 * `packages/web-platform/src/routing/url-state.ts`: one Zod schema per parameter, and a reader that returns a valid
 * value or null. Navigation itself is links, so there is no writer.
 */
export const SettingsTabSchema = z.enum([
  'workspace',
  'editor',
  'preferences',
  'notifications',
  'daily-notes',
  'pets',
  'integrations',
  'access-tokens',
  'mcp',
  'api',
  'backups',
  'site-approvals',
  'administrators',
]);

export type SettingsTab = z.infer<typeof SettingsTabSchema>;

export const SETTINGS_TAB_PARAM = 'tab';

export const DEFAULT_SETTINGS_TAB: SettingsTab = 'workspace';

/** Retired tab ids that still arrive in old links, and the section that now holds them. */
const RENAMED: Readonly<Record<string, SettingsTab>> = { publishing: 'preferences' };

/** Parses one raw search-parameter value; null when absent or unrecognised. */
export function parseSettingsTab(raw: string | null): SettingsTab | null {
  if (raw === null) {
    return null;
  }
  const renamed = RENAMED[raw];
  if (renamed !== undefined) {
    return renamed;
  }
  const result = SettingsTabSchema.safeParse(raw);
  if (result.success) {
    return result.data;
  }
  console.warn(`Ignoring unrecognised "${SETTINGS_TAB_PARAM}" search parameter:`, raw);
  return null;
}

/** The section the address asks for, or null when it names none (the phone list view). */
export function useSettingsTab(): { readonly requested: SettingsTab | null } {
  const [searchParams] = useSearchParams();
  return { requested: parseSettingsTab(searchParams.get(SETTINGS_TAB_PARAM)) };
}
