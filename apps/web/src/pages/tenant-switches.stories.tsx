import { createNixClient } from '@nix/api-client';
import { useMemo, type ReactNode } from 'react';

import { ApiClientOverrideProvider } from '@nix/web-platform/api/api-client-provider';
import { TenantSwitches } from '@nix/web-settings/settings/administrators/tenant-switches';

export default { title: 'Nix/Settings/Tenant switches', parameters: { layout: 'padded' } };

function Example({ publicLinksAvailable }: { readonly publicLinksAvailable: boolean }): ReactNode {
  const client = useMemo(
    () =>
      createNixClient({
        baseUrl: 'http://nix.invalid',
        cache: { staleAfterMs: 0 },
        tokens: {
          getAccessToken: () => Promise.resolve(null),
          refreshAccessToken: () => Promise.resolve(null),
        },
        fetch: () =>
          Promise.resolve(
            Response.json({
              mcpEnabled: true,
              publicLinksEnabled: publicLinksAvailable,
              mcpAvailable: true,
              publicLinksAvailable,
            }),
          ),
      }),
    [publicLinksAvailable],
  );
  return (
    <ApiClientOverrideProvider client={client}>
      <TenantSwitches />
    </ApiClientOverrideProvider>
  );
}

export const Available = { render: (): ReactNode => <Example publicLinksAvailable /> };
export const PublicLinksOffInThisInstall = {
  render: (): ReactNode => <Example publicLinksAvailable={false} />,
};
export const DarkAvailable = { ...Available, globals: { ground: 'dark' } };
