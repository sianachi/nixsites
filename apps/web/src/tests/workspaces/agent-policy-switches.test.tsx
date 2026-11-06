import { createNixClient } from '@nix/api-client';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ApiClientOverrideProvider } from '@nix/web-platform/api/api-client-provider';
import { STUB_WORKSPACE } from '@nix/web-foundation/testing/api-stub';
import { SharingSwitches } from '@nix/web-workspaces/workspaces/settings/sharing-switches';

const updated = vi.fn();
vi.mock('@nix/web-workspaces/workspaces/workspace-context', () => ({
  useWorkspace: () => ({
    workspace: { ...STUB_WORKSPACE, canRename: true, agentsMayApprove: true },
    workspaceUpdated: updated,
  }),
}));

describe('agent policy switches', () => {
  it('sends one switch at a time to the agent policy route, leaving the other alone', async () => {
    const requests: { url: string; body: unknown }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : input.toString();
        requests.push({ url, body: JSON.parse(String(init?.body)) as unknown });
        return Promise.resolve(
          Response.json({ ...STUB_WORKSPACE, agentsMayCreatePublicLinks: true }),
        );
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
        <SharingSwitches />
      </ApiClientOverrideProvider>,
    );

    expect(
      screen.getByRole('checkbox', { name: 'Agents may approve file versions' }),
    ).toBeChecked();
    const links = screen.getByRole('checkbox', { name: 'Agents may create public links' });
    expect(links).not.toBeChecked();

    await userEvent.click(links);
    await waitFor(() => {
      expect(requests).toHaveLength(1);
    });
    expect(requests[0]?.url).toContain(`/workspaces/${STUB_WORKSPACE.id}/agent-policy`);
    expect(requests[0]?.body).toEqual({ agentsMayApprove: null, agentsMayCreatePublicLinks: true });
    await waitFor(() => {
      expect(updated).toHaveBeenCalled();
    });
  });
});
