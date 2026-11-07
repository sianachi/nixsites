import { createNixClient } from '@nix/api-client';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { ApiClientOverrideProvider } from '@nix/web-platform/api/api-client-provider';
import { onNotice, type Notice } from '@nix/web-foundation/lib/notices';
import { TenantSwitches } from '@nix/web-settings/settings/administrators/tenant-switches';

interface Stored {
  mcpEnabled: boolean;
  publicLinksEnabled: boolean;
  mcpAvailable: boolean;
  publicLinksAvailable: boolean;
}

const notices: Notice[] = [];
onNotice((notice) => notices.push(notice));
afterEach(() => {
  notices.length = 0;
});

function setup(stored: Stored, refuse = false): unknown[] {
  const puts: unknown[] = [];
  const client = createNixClient({
    baseUrl: 'http://nix.invalid',
    cache: { staleAfterMs: 0 },
    tokens: {
      getAccessToken: () => Promise.resolve(null),
      refreshAccessToken: () => Promise.resolve(null),
    },
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : null;
      const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
      if (method === 'PUT') {
        const text = typeof init?.body === 'string' ? init.body : await request?.clone().text();
        const sent = JSON.parse(text ?? 'null') as Partial<Stored>;
        puts.push(sent);
        if (refuse) {
          return Response.json(
            {
              type: 'about:blank',
              title: 'No',
              status: 403,
              code: 'test.refused',
              detail: 'Only administrators.',
            },
            { status: 403, headers: { 'content-type': 'application/problem+json' } },
          );
        }
        Object.assign(stored, sent);
      }
      return Response.json(stored);
    },
  });
  render(
    <ApiClientOverrideProvider client={client}>
      <TenantSwitches />
    </ApiClientOverrideProvider>,
  );
  return puts;
}

const ALL: Stored = {
  mcpEnabled: true,
  publicLinksEnabled: false,
  mcpAvailable: true,
  publicLinksAvailable: true,
};

describe('the tenant switches', () => {
  it('shows the stored state', async () => {
    setup({ ...ALL });
    expect(await screen.findByRole('checkbox', { name: 'MCP for agents' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Public links' })).not.toBeChecked();
  });

  it('disables a switch the install turned off, and says why', async () => {
    setup({ ...ALL, publicLinksAvailable: false });
    expect(await screen.findByText('This install has public links turned off.')).toBeVisible();
    expect(screen.getByRole('checkbox', { name: 'Public links' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'MCP for agents' })).toBeEnabled();
  });

  it('sends only the field that changed', async () => {
    const user = userEvent.setup();
    const puts = setup({ ...ALL });
    await user.click(await screen.findByRole('checkbox', { name: 'Public links' }));

    await waitFor(() => {
      expect(screen.getByRole('checkbox', { name: 'Public links' })).toBeChecked();
    });
    expect(puts).toEqual([{ publicLinksEnabled: true }]);
    expect(notices.at(-1)?.message).toBe('Public links can be created.');
  });

  it('reports a refusal as a notice and keeps the stored state', async () => {
    const user = userEvent.setup();
    setup({ ...ALL }, true);
    await user.click(await screen.findByRole('checkbox', { name: 'MCP for agents' }));

    await waitFor(() => {
      expect(notices.at(-1)?.message).toBe('Only administrators.');
    });
    expect(screen.getByRole('checkbox', { name: 'MCP for agents' })).toBeChecked();
  });
});
