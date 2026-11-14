import { createNixClient } from '@nix/api-client';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ApiClientOverrideProvider } from '@nix/web-platform/api/api-client-provider';
import { STUB_WORKSPACE } from '@nix/web-foundation/testing/api-stub';
import { ItemDefaultsSwitches } from '@nix/web-workspaces/workspaces/settings/item-defaults-switches';

let canRename = true;
vi.mock('@nix/web-workspaces/workspaces/workspace-context', () => ({
  useWorkspace: () => ({ workspace: { ...STUB_WORKSPACE, canRename } }),
}));

function renderSwitches(): { requests: { method: string; body: unknown }[] } {
  const requests: { method: string; body: unknown }[] = [];
  const stored = { comments: false, suggesting: false, reviewStates: false, fullWidth: false };
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const method = (
        init?.method ?? (input instanceof Request ? input.method : 'GET')
      ).toUpperCase();
      if (method !== 'GET') {
        const body = JSON.parse(typeof init?.body === 'string' ? init.body : 'null') as Record<
          string,
          unknown
        >;
        requests.push({ method, body });
        for (const [key, value] of Object.entries(body)) {
          if (typeof value === 'boolean') Object.assign(stored, { [key]: value });
        }
      }
      return Promise.resolve(Response.json(stored));
    }),
  );
  const client = createNixClient({
    baseUrl: 'http://localhost',
    tokens: {
      getAccessToken: () => Promise.resolve('token'),
      refreshAccessToken: () => Promise.resolve(null),
    },
  });
  render(
    <ApiClientOverrideProvider client={client}>
      <ItemDefaultsSwitches />
    </ApiClientOverrideProvider>,
  );
  return { requests };
}

describe('workspace item defaults', () => {
  it('shows every default off and sends one switch at a time', async () => {
    canRename = true;
    const { requests } = renderSwitches();

    const comments = await screen.findByRole('checkbox', { name: 'Comments' });
    await waitFor(() => {
      expect(comments).toBeEnabled();
    });
    expect(screen.getByRole('checkbox', { name: 'File review states' })).not.toBeChecked();

    await userEvent.click(comments);

    await waitFor(() => {
      expect(requests).toHaveLength(1);
    });
    expect(requests[0]).toEqual({
      method: 'PUT',
      body: { comments: true, suggesting: null, reviewStates: null, fullWidth: null },
    });
    await waitFor(() => {
      expect(screen.getByRole('checkbox', { name: 'Comments' })).toBeChecked();
    });
  });

  it('leaves the switches to owners', async () => {
    canRename = false;
    renderSwitches();

    expect(await screen.findByRole('checkbox', { name: 'Full width' })).toBeDisabled();
  });
});
