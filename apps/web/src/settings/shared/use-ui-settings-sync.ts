import { useEffect } from 'react';

import { useApiClient } from '@nix/web-platform/api/api-client-provider';
import { hydrateUiSettings } from '@nix/web-foundation/lib/ui-settings-sync';

/** Reads the account's synced interface settings once the shell knows who is signed in. */
export function useUiSettingsSync(principalId: string | undefined): void {
  const client = useApiClient();
  useEffect(() => {
    if (principalId !== undefined) void hydrateUiSettings(client, principalId);
  }, [client, principalId]);
}
