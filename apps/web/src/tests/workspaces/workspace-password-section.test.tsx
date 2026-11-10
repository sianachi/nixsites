import { createNixClient } from '@nix/api-client';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiClientOverrideProvider } from '@nix/web-platform/api/api-client-provider';
import { STUB_WORKSPACE } from '@nix/web-foundation/testing/api-stub';
import { requestUrl } from '@nix/web-foundation/testing/request-url';
import { WorkspacePasswordSection } from '@nix/web-workspaces/workspaces/settings/workspace-password-section';

const updated = vi.fn();
let current: Record<string, unknown> = {};
vi.mock('@nix/web-workspaces/workspaces/workspace-context', () => ({
  useWorkspace: () => ({ workspace: current, workspaceUpdated: updated, reload: vi.fn() }),
}));

function client() {
  return createNixClient({
    baseUrl: 'http://localhost',
    tokens: {
      getAccessToken: () => Promise.resolve('token'),
      refreshAccessToken: () => Promise.resolve(null),
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  updated.mockClear();
});

function stubFetch(requests: { method: string; path: string; body: unknown }[]): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : null;
      const url = new URL(requestUrl(input));
      const method = request?.method ?? init?.method ?? 'GET';
      const text = request === null ? init?.body : await request.clone().text();
      requests.push({
        method,
        path: url.pathname,
        body: typeof text === 'string' && text.length > 0 ? (JSON.parse(text) as unknown) : null,
      });
      return method === 'GET'
        ? Response.json({ ...current, passwordProtected: true })
        : new Response(null, { status: 204 });
    }),
  );
}

describe('the workspace password section', () => {
  it('lets an owner set a password and says it cannot be recovered', async () => {
    current = { ...STUB_WORKSPACE, canManageMembers: true, passwordProtected: false };
    const requests: { method: string; path: string; body: unknown }[] = [];
    stubFetch(requests);
    const user = userEvent.setup();
    render(
      <ApiClientOverrideProvider client={client()}>
        <WorkspacePasswordSection />
      </ApiClientOverrideProvider>,
    );

    expect(screen.getByText(/cannot be\s+recovered/i)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Lock now' })).not.toBeInTheDocument();
    await user.type(screen.getByLabelText('New password'), 'long enough');
    await user.click(screen.getByRole('button', { name: 'Set password' }));

    await waitFor(() => {
      expect(requests[0]).toMatchObject({
        method: 'PUT',
        path: `/api/v1/workspaces/${STUB_WORKSPACE.id}/password`,
        body: { password: 'long enough' },
      });
    });
    await waitFor(() => {
      expect(updated).toHaveBeenCalled();
    });
  });

  it('asks an owner for the current password to change or remove it, and shows the join link', async () => {
    current = {
      ...STUB_WORKSPACE,
      canManageMembers: true,
      passwordProtected: true,
      unlockedUntil: '2099-01-01T00:00:00Z',
    };
    const requests: { method: string; path: string; body: unknown }[] = [];
    stubFetch(requests);
    const user = userEvent.setup();
    render(
      <ApiClientOverrideProvider client={client()}>
        <WorkspacePasswordSection />
      </ApiClientOverrideProvider>,
    );

    expect(screen.getByLabelText('Join link')).toHaveValue(
      `${window.location.origin}/join/${STUB_WORKSPACE.id}`,
    );
    const change = screen.getByRole('form', { name: 'Change password' });
    await user.type(within(change).getByLabelText('Current password'), 'old one');
    await user.type(screen.getByLabelText('New password'), 'new one!');
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    await waitFor(() => {
      expect(requests[0]?.body).toEqual({ password: 'new one!', currentPassword: 'old one' });
    });

    const remove = screen.getByRole('form', { name: 'Remove password' });
    await user.type(within(remove).getByLabelText('Current password'), 'new one!');
    await user.click(screen.getByRole('button', { name: 'Remove password' }));
    await waitFor(() => {
      expect(requests.some((request) => request.path.endsWith('/password/remove'))).toBe(true);
    });
  });

  it('gives a member who is not an owner only the way to lock the workspace again', async () => {
    current = {
      ...STUB_WORKSPACE,
      canManageMembers: false,
      passwordProtected: true,
      unlockedUntil: '2099-01-01T00:00:00Z',
    };
    const requests: { method: string; path: string; body: unknown }[] = [];
    stubFetch(requests);
    const user = userEvent.setup();
    render(
      <ApiClientOverrideProvider client={client()}>
        <WorkspacePasswordSection />
      </ApiClientOverrideProvider>,
    );

    expect(screen.queryByLabelText('New password')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Join link')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Lock now' }));
    await waitFor(() => {
      expect(requests[0]).toMatchObject({
        method: 'DELETE',
        path: `/api/v1/workspaces/${STUB_WORKSPACE.id}/unlock`,
      });
    });
  });

  it('renders nothing for a member of a workspace that has no password', () => {
    current = { ...STUB_WORKSPACE, canManageMembers: false, passwordProtected: false };
    const { container } = render(
      <ApiClientOverrideProvider client={client()}>
        <WorkspacePasswordSection />
      </ApiClientOverrideProvider>,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
