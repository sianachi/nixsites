import {
  isCanceledError,
  isNixApiError,
  tenantSettings,
  type TenantSettings,
} from '@nix/api-client';
import { Checkbox, Text } from '@nix/ui';
import { useEffect, useState, type ReactElement } from 'react';

import { useApiClient } from '@nix/web-platform/api/api-client-provider';
import { publishNotice } from '@nix/web-foundation/lib/notices';
import { SettingsSection } from '../shared/settings-section';

type Change = { mcpEnabled: boolean } | { publicLinksEnabled: boolean };

/** Whether this tenant offers MCP and public links at all. Tenant administrators only. */
export function TenantSwitches(): ReactElement {
  const client = useApiClient();
  const [stored, setStored] = useState<TenantSettings | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    client
      .query(tenantSettings.getTenantSettings(), {
        signal: controller.signal,
        forceRefresh: true,
      })
      .then(setStored, (reason: unknown) => {
        if (!isCanceledError(reason)) setLoadFailed(true);
      });
    return () => {
      controller.abort();
    };
  }, [client]);

  async function save(change: Change, done: string): Promise<void> {
    setSaving(true);
    try {
      setStored(await client.execute(tenantSettings.setTenantSettings(change)));
      publishNotice({ key: 'tenant-settings', message: done });
    } catch (reason) {
      if (isCanceledError(reason)) return;
      publishNotice({
        key: 'tenant-settings',
        message: isNixApiError(reason)
          ? (reason.detail ?? 'The setting could not be saved.')
          : 'The setting could not be saved.',
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingsSection title="Agents and sharing" summary="What this tenant offers to everyone in it">
      {loadFailed ? (
        <Text variant="note" tone="muted" role="status">
          The tenant settings could not be loaded.
        </Text>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-3">
        <Checkbox
          label="MCP for agents"
          checked={stored?.mcpEnabled === true}
          disabled={stored === null || !stored.mcpAvailable || saving}
          onChange={(event) => {
            const on = event.currentTarget.checked;
            void save(
              { mcpEnabled: on },
              on ? 'Agents can connect over MCP.' : 'MCP is off for this tenant.',
            );
          }}
        />
        {stored !== null && !stored.mcpAvailable ? (
          <Text variant="note" tone="muted">
            This install has MCP turned off.
          </Text>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-x-3">
        <Checkbox
          label="Public links"
          checked={stored?.publicLinksEnabled === true}
          disabled={stored === null || !stored.publicLinksAvailable || saving}
          onChange={(event) => {
            const on = event.currentTarget.checked;
            void save(
              { publicLinksEnabled: on },
              on ? 'Public links can be created.' : 'Public links are off for this tenant.',
            );
          }}
        />
        {stored !== null && !stored.publicLinksAvailable ? (
          <Text variant="note" tone="muted">
            This install has public links turned off.
          </Text>
        ) : null}
      </div>
    </SettingsSection>
  );
}
