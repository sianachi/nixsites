import type { NixClient } from '@nix/api-client';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { ApiClientOverrideProvider } from '@nix/web-platform/api/api-client-provider';
import { WorkspaceItemTransfer } from './workspace-item-transfer';

export default { title: 'Nix/Items/Move to workspace', parameters: { layout: 'padded' } };

const client = {
  paginate: async function* () {
    await Promise.resolve();
    yield { id: '22222222-2222-4222-8222-222222222222', name: 'Shared research' };
    yield { id: '44444444-4444-4444-8444-444444444444', name: 'Personal projects' };
  },
  execute: () => Promise.reject(new Error('This preview does not change workspace data.')),
} as unknown as NixClient;

export const Destinations = {
  render: (): ReactNode => (
    <MemoryRouter>
      <ApiClientOverrideProvider client={client}>
        <WorkspaceItemTransfer
          itemId="33333333-3333-4333-8333-333333333333"
          sourceWorkspaceId="11111111-1111-4111-8111-111111111111"
          onClose={() => undefined}
          onBusyChange={() => undefined}
        />
      </ApiClientOverrideProvider>
    </MemoryRouter>
  ),
};
