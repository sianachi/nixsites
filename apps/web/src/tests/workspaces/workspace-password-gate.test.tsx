import { createNixClient } from '@nix/api-client';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiClientOverrideProvider } from '@nix/web-platform/api/api-client-provider';
import { STUB_WORKSPACE } from '@nix/web-foundation/testing/api-stub';
import { requestUrl } from '@nix/web-foundation/testing/request-url';
import { JoinWorkspacePage } from '@nix/web-workspaces/workspaces/join-workspace-page';
import { AccessibleWorkspacesProvider } from '@nix/web-workspaces/workspaces/workspace-context';
import { ArchivedWorkspacesPage } from '@nix/web-workspaces/workspaces/archived-workspaces-page';
import { WorkspaceGate } from '@nix/web-workspaces/workspaces/workspace-gate';
import { WorkspaceUnlockScreen } from '@nix/web-workspaces/workspaces/workspace-unlock-screen';

const WORKSPACE_ID = STUB_WORKSPACE.id;

function client() {
  return createNixClient({
    baseUrl: 'http://localhost',
    tokens: {
      getAccessToken: () => Promise.resolve('token'),
      refreshAccessToken: () => Promise.resolve(null),
    },
  });
}

function problem(status: number, code: string, detail: string): Response {
  return new Response(JSON.stringify({ status, code, title: 'Request refused', detail }), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the workspace unlock screen', () => {
  it('names the workspace, asks for the password, and shows a refusal on the field', async () => {
    const user = userEvent.setup();
    const onUnlock = vi
      .fn<(password: string) => Promise<string | null>>()
      .mockResolvedValueOnce('That password is not right.')
      .mockResolvedValueOnce(null);
    render(<WorkspaceUnlockScreen name="Vault" onUnlock={onUnlock} />);

    expect(screen.getByRole('heading', { name: 'Vault is locked' })).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Unlock' }));
    expect(await screen.findByText('Enter the password.')).toBeVisible();
    expect(onUnlock).not.toHaveBeenCalled();

    const field = screen.getByLabelText('Workspace password');
    await user.type(field, 'wrong one{Enter}');
    expect(await screen.findByText('That password is not right.')).toBeVisible();
    expect(field).toHaveFocus();
    expect(field).toHaveValue('');

    await user.type(field, 'right one{Enter}');
    expect(onUnlock).toHaveBeenLastCalledWith('right one');
  });

  it('says why a workspace that was open has closed', () => {
    render(
      <WorkspaceUnlockScreen
        name="Vault"
        reason="expired"
        onUnlock={() => Promise.resolve(null)}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent(/locked again after 15 minutes/i);
  });
});

describe('the workspace gate with a password', () => {
  it('mounts nothing of a closed workspace, then opens it once Core accepts the password', async () => {
    const user = userEvent.setup();
    const closed = { ...STUB_WORKSPACE, name: 'Vault', passwordProtected: true };
    const open = {
      ...STUB_WORKSPACE,
      name: 'Vault',
      passwordProtected: true,
      unlockedUntil: new Date(Date.now() + 15 * 60_000).toISOString(),
    };
    let unlocked = false;
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : null;
        const url = new URL(requestUrl(input));
        const method = request?.method ?? init?.method ?? 'GET';
        calls.push(`${method} ${url.pathname}`);
        if (url.pathname.endsWith('/unlock') && method === 'POST') {
          return Promise.resolve(
            unlocked
              ? Response.json({ unlockedUntil: open.unlockedUntil })
              : problem(
                  403,
                  'workspaces.wrong_password',
                  'That password does not open this workspace.',
                ),
          );
        }
        if (url.pathname === '/api/v1/workspaces') {
          return Promise.resolve(
            Response.json({ items: [unlocked ? open : closed], nextCursor: null }),
          );
        }
        if (url.pathname === `/api/v1/workspaces/${WORKSPACE_ID}`) {
          return Promise.resolve(Response.json(open));
        }
        return Promise.resolve(problem(404, 'items.not_found', 'No item is visible.'));
      }),
    );

    render(
      <ApiClientOverrideProvider client={client()}>
        <MemoryRouter initialEntries={[`/w/${WORKSPACE_ID}`]}>
          <Routes>
            <Route element={<AccessibleWorkspacesProvider />}>
              <Route
                path="/w/:workspaceId"
                element={
                  <WorkspaceGate>
                    <p>Workspace content</p>
                  </WorkspaceGate>
                }
              />
            </Route>
          </Routes>
        </MemoryRouter>
      </ApiClientOverrideProvider>,
    );

    expect(await screen.findByRole('heading', { name: 'Vault is locked' })).toBeVisible();
    expect(screen.queryByText('Workspace content')).not.toBeInTheDocument();

    const field = screen.getByLabelText('Workspace password');
    await user.type(field, 'wrong one{Enter}');
    expect(await screen.findByText('That password is not right.')).toBeVisible();
    expect(screen.queryByText('Workspace content')).not.toBeInTheDocument();

    unlocked = true;
    await user.type(field, 'right one{Enter}');
    expect(await screen.findByText('Workspace content')).toBeVisible();

    // The only requests a closed workspace made were the list and the unlock itself.
    expect(calls.filter((call) => call.includes('/items') || call.includes('/sync'))).toEqual([]);
  });

  it('shows a throttled password as the reason, not a wrong one', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : null;
        const url = new URL(requestUrl(input));
        const method = request?.method ?? init?.method ?? 'GET';
        if (url.pathname.endsWith('/unlock') && method === 'POST') {
          return Promise.resolve(
            problem(
              429,
              'workspaces.too_many_attempts',
              'Too many wrong passwords. Try again in 2 minute(s).',
            ),
          );
        }
        return Promise.resolve(
          Response.json({
            items: [{ ...STUB_WORKSPACE, name: 'Vault', passwordProtected: true }],
            nextCursor: null,
          }),
        );
      }),
    );
    render(
      <ApiClientOverrideProvider client={client()}>
        <MemoryRouter initialEntries={[`/w/${WORKSPACE_ID}`]}>
          <Routes>
            <Route element={<AccessibleWorkspacesProvider />}>
              <Route
                path="/w/:workspaceId"
                element={
                  <WorkspaceGate>
                    <p>Workspace content</p>
                  </WorkspaceGate>
                }
              />
            </Route>
          </Routes>
        </MemoryRouter>
      </ApiClientOverrideProvider>,
    );

    await user.type(await screen.findByLabelText('Workspace password'), 'guess{Enter}');
    expect(await screen.findByText(/try again in 2 minute/i)).toBeVisible();
  });
});

describe('the join page', () => {
  it('shows no workspace details, refuses with the one message, and goes in on success', async () => {
    const user = userEvent.setup();
    let accepted = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          accepted
            ? Response.json({ unlockedUntil: new Date(Date.now() + 60_000).toISOString() })
            : problem(
                403,
                'workspaces.join_refused',
                'That link and password do not open a workspace.',
              ),
        ),
      ),
    );
    render(
      <ApiClientOverrideProvider client={client()}>
        <MemoryRouter initialEntries={[`/join/${WORKSPACE_ID}`]}>
          <Routes>
            <Route path="/join/:workspaceId" element={<JoinWorkspacePage />} />
            <Route path="/w/:workspaceId" element={<p>Inside the workspace</p>} />
          </Routes>
        </MemoryRouter>
      </ApiClientOverrideProvider>,
    );

    expect(screen.getByRole('heading', { name: 'Join a workspace' })).toBeVisible();
    expect(screen.queryByText(STUB_WORKSPACE.name)).not.toBeInTheDocument();

    const field = screen.getByLabelText('Workspace password');
    await user.type(field, 'wrong one{Enter}');
    expect(await screen.findByText(/did not open a workspace/i)).toBeVisible();
    expect(field).toHaveFocus();

    accepted = true;
    await user.type(field, 'right one{Enter}');
    await waitFor(() => {
      expect(screen.getByText('Inside the workspace')).toBeVisible();
    });
  });

  it('does not call Core for a link that is not an identifier', async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    render(
      <ApiClientOverrideProvider client={client()}>
        <MemoryRouter initialEntries={['/join/not-an-id']}>
          <Routes>
            <Route path="/join/:workspaceId" element={<JoinWorkspacePage />} />
          </Routes>
        </MemoryRouter>
      </ApiClientOverrideProvider>,
    );

    await user.type(screen.getByLabelText('Workspace password'), 'anything{Enter}');
    expect(await screen.findByText(/did not open a workspace/i)).toBeVisible();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('the archived workspaces page with a password', () => {
  it('asks for the password instead of offering buttons that would be refused', async () => {
    const user = userEvent.setup();
    const archived = {
      ...STUB_WORKSPACE,
      name: 'Old vault',
      lifecycleState: 'archived',
      archivedAt: '2026-10-01T00:00:00Z',
      passwordProtected: true,
    };
    const open = { ...archived, unlockedUntil: new Date(Date.now() + 60_000).toISOString() };
    let unlocked = false;
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : null;
        const url = new URL(requestUrl(input));
        const method = request?.method ?? init?.method ?? 'GET';
        if (url.pathname.endsWith('/unlock') && method === 'POST') {
          unlocked = true;
          return Promise.resolve(Response.json({ unlockedUntil: open.unlockedUntil }));
        }
        if (url.pathname === `/api/v1/workspaces/${WORKSPACE_ID}`) {
          return Promise.resolve(Response.json(open));
        }
        return Promise.resolve(
          Response.json({ items: [unlocked ? open : archived], nextCursor: null }),
        );
      }),
    );
    render(
      <ApiClientOverrideProvider client={client()}>
        <MemoryRouter initialEntries={['/archived']}>
          <Routes>
            <Route element={<AccessibleWorkspacesProvider />}>
              <Route path="/archived" element={<ArchivedWorkspacesPage />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </ApiClientOverrideProvider>,
    );

    expect(await screen.findByRole('button', { name: 'Unlock to manage' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Restore workspace' })).not.toBeInTheDocument();
    await user.type(screen.getByLabelText('Workspace password'), 'right one{Enter}');
    expect(await screen.findByRole('button', { name: 'Restore workspace' })).toBeVisible();
  });
});
