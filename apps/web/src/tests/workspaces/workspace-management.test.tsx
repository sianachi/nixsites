import { screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../../app';
import {
  STUB_WORKSPACE,
  stubCoreApi,
  type StubInvitation,
  type StubMember,
  type StubWorkspace,
} from '../api-stub';
import { renderAt, signedIn } from '../render-with-router';
import { requestUrl } from '../request-url';

const OWNER_ID = '44444444-bbbb-4bbb-8bbb-444444444444';
const EDITOR_ID = '55555555-bbbb-4bbb-8bbb-555555555555';
const INVITATION_ID = '88888888-bbbb-4bbb-8bbb-888888888888';
const members: readonly StubMember[] = [
  {
    subjectType: 'principal',
    subjectId: OWNER_ID,
    subjectDisplayName: 'Protected owner',
    role: 'owner',
    grantedAt: '2026-01-05T09:00:00+00:00',
    canChangeRole: false,
    canRemove: false,
    assignableRoles: [],
  },
  {
    subjectType: 'principal',
    subjectId: EDITOR_ID,
    subjectDisplayName: 'Working editor',
    role: 'editor',
    grantedAt: '2026-03-12T09:00:00+00:00',
    canChangeRole: true,
    canRemove: true,
    assignableRoles: ['editor', 'viewer'],
  },
];
const EDITOR_MEMBER: StubMember = {
  subjectType: 'principal',
  subjectId: EDITOR_ID,
  subjectDisplayName: 'Working editor',
  role: 'editor',
  grantedAt: '2026-03-12T09:00:00+00:00',
  canChangeRole: true,
  canRemove: true,
  assignableRoles: ['editor', 'viewer'],
};

const SHARED: StubWorkspace = {
  ...STUB_WORKSPACE,
  id: '00000000-0000-4000-8000-000000000002',
  name: 'Shared research',
  kind: 'shared',
  canLeave: true,
  canUseDailyNotes: false,
};

const PENDING: StubWorkspace = {
  ...SHARED,
  canRename: false,
  canManageMembers: false,
  canLeave: false,
  pendingInvitationId: INVITATION_ID,
};

const PENDING_INVITATION: StubInvitation = {
  id: INVITATION_ID,
  emailNormalized: 'test@example.test',
  targetPrincipalId: '1b1b1b1b-1111-4111-8111-1b1b1b1b1b1b',
  role: 'editor',
  status: 'pending',
  invitedByPrincipalId: OWNER_ID,
  invitedAt: '2026-08-30T09:00:00.000Z',
  acceptedAt: null,
  acceptedByPrincipalId: null,
  revokedAt: null,
};

beforeEach(() => {
  signedIn();
});

function workspaceButton(name: string): HTMLElement {
  void name;
  return screen.getByRole('button', { name: 'Workspace menu' });
}

async function switchWorkspace(user: UserEvent, to: string): Promise<void> {
  await user.click(screen.getByRole('button', { name: 'Workspace menu' }));
  await user.click(
    within(screen.getByRole('region', { name: 'Workspaces' })).getByRole('link', { name: to }),
  );
}

describe('workspace management', () => {
  it('uses server-decided row capabilities for protected owner controls', async () => {
    stubCoreApi({ members });
    renderAt(<App />, '/settings');

    const protectedRole = await screen.findByRole('combobox', { name: 'Role for Protected owner' });
    expect(protectedRole).toBeDisabled();
    expect(
      screen.queryByRole('button', { name: 'Remove Protected owner' }),
    ).not.toBeInTheDocument();

    const editorRole = screen.getByRole('combobox', { name: 'Role for Working editor' });
    expect(editorRole).toBeEnabled();
    expect(within(editorRole).queryByRole('option', { name: 'Owner' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove Working editor' })).toBeEnabled();
  });

  it('selects an existing user, sends an invitation and keeps it visible', async () => {
    const user = userEvent.setup();
    stubCoreApi({ members });
    renderAt(<App />, '/settings');

    await screen.findByText(/see nothing in this workspace until they accept/i);
    await waitFor(() => {
      expect(fetchCalls().some((call) => call.url.includes('/invitees'))).toBe(true);
    });
    await user.selectOptions(
      await screen.findByRole('combobox', { name: 'Person' }),
      '77777777-bbbb-4bbb-8bbb-777777777777',
    );
    await user.selectOptions(screen.getByRole('combobox', { name: 'Role' }), 'viewer');
    await user.click(screen.getByRole('button', { name: 'Invite' }));

    await waitFor(() => {
      expect(
        fetchCalls().filter((call) => call.method === 'POST' && call.url.endsWith('/invitations')),
      ).toHaveLength(1);
      expect(
        fetchCalls().filter((call) => call.method === 'GET' && call.url.includes('/invitations'))
          .length,
      ).toBeGreaterThan(1);
    });
    expect(await screen.findByText('new.person@example.com')).toBeVisible();
    expect(await screen.findByText('New Person')).toBeVisible();
    expect(screen.getByText('pending')).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Revoke invitation for new.person@example.com' }),
    ).toBeVisible();
  });

  it('loads people beyond the first page and searches by name or email', async () => {
    const user = userEvent.setup();
    const people = Array.from({ length: 65 }, (_, index) => ({
      principalId: `77777777-bbbb-4bbb-8bbb-${String(index).padStart(12, '0')}`,
      displayName: `Person ${String(index)}`,
      email: `person${String(index)}@example.test`,
    }));
    stubCoreApi({ invitees: people });
    renderAt(<App />, '/settings');

    const person = await screen.findByRole('combobox', { name: 'Person' });
    await waitFor(() => {
      expect(
        within(person).getByRole('option', { name: 'Person 64 (person64@example.test)' }),
      ).toBeVisible();
    });
    expect(
      fetchCalls().some((call) => new URL(call.url, location.origin).searchParams.has('cursor')),
    ).toBe(true);
    await user.selectOptions(person, people[0]?.principalId ?? '');
    await user.type(
      screen.getByRole('searchbox', { name: 'Search people by name or email' }),
      'PERSON64@',
    );
    await waitFor(() => {
      expect(
        within(screen.getByRole('combobox', { name: 'Person' })).getAllByRole('option'),
      ).toHaveLength(2);
    });
    expect(screen.getByRole('button', { name: 'Invite' })).toBeDisabled();
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Person' }),
      people[64]?.principalId ?? '',
    );
    expect(screen.getByRole('button', { name: 'Invite' })).toBeEnabled();
  });

  it('keeps partial invitees usable and announces a later page failure without claiming completeness', async () => {
    const people = Array.from({ length: 65 }, (_, index) => ({
      principalId: `77777777-bbbb-4bbb-8bbb-${String(index).padStart(12, '0')}`,
      displayName: `Person ${String(index)}`,
      email: `person${String(index)}@example.test`,
    }));
    stubCoreApi({ invitees: people });
    const fallbackFetch = fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(requestUrl(input), location.origin);
        if (url.pathname.endsWith('/invitees') && url.searchParams.has('cursor')) {
          return Promise.resolve(
            new Response(JSON.stringify({ title: 'Unavailable', status: 503 }), {
              status: 503,
              headers: { 'content-type': 'application/problem+json' },
            }),
          );
        }
        return fallbackFetch(input, init);
      }),
    );
    renderAt(<App />, '/settings');

    expect(
      await screen.findByText(/The list is incomplete; some people may be missing/i),
    ).toBeVisible();
    expect(screen.getByRole('combobox', { name: 'Person' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Refresh people' })).toBeEnabled();
    expect(screen.queryByText(/No people are available/i)).not.toBeInTheDocument();
  });

  it('shows people who cannot be invited with Core-provided reasons', async () => {
    stubCoreApi({
      invitees: [
        {
          principalId: OWNER_ID,
          displayName: 'Existing member',
          email: 'member@example.test',
          canInvite: false,
          cannotInviteReason: 'already_has_access',
        },
        {
          principalId: EDITOR_ID,
          displayName: 'Unverified person',
          email: 'unverified@example.test',
          canInvite: false,
          cannotInviteReason: 'email_unverified',
        },
        {
          principalId: INVITATION_ID,
          displayName: 'Invited person',
          email: 'invited@example.test',
          canInvite: false,
          cannotInviteReason: 'invitation_pending',
        },
        {
          principalId: '99999999-bbbb-4bbb-8bbb-999999999999',
          displayName: 'No email person',
          email: null,
          canInvite: false,
          cannotInviteReason: 'email_missing',
        },
      ],
    });
    renderAt(<App />, '/settings');
    const people = await screen.findByRole('combobox', { name: 'Person' });
    expect(
      within(people).getByRole('option', { name: /Existing member.*Already has access/ }),
    ).toBeDisabled();
    expect(
      within(people).getByRole('option', { name: /Unverified person.*Email not verified/ }),
    ).toBeDisabled();
    expect(
      within(people).getByRole('option', { name: /Invited person.*Invitation pending/ }),
    ).toBeDisabled();
    expect(
      within(people).getByRole('option', { name: /No email person.*No email address/ }),
    ).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Invite' })).toBeDisabled();
  });

  it('explains an empty eligible directory and lets the user refresh after someone signs in', async () => {
    stubCoreApi({ invitees: [] });
    renderAt(<App />, '/settings');

    expect(await screen.findByText(/They must sign in to Nix in this organization/i)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Refresh people' })).toBeEnabled();
    expect(
      screen.queryByText(/Everyone who can be invited already has access/i),
    ).not.toBeInTheDocument();
  });

  it('does not offer owner for a personal-workspace invitation', async () => {
    stubCoreApi();
    renderAt(<App />, '/settings');

    const role = await screen.findByRole('combobox', { name: 'Role' });
    expect(within(role).queryByRole('option', { name: 'Owner' })).not.toBeInTheDocument();
    expect(within(role).getByRole('option', { name: 'Editor' })).toBeInTheDocument();
    expect(within(role).getByRole('option', { name: 'Viewer' })).toBeInTheDocument();
  });

  it('creates a shared workspace and opens it', async () => {
    const user = userEvent.setup();
    stubCoreApi();
    renderAt(<App />, '/settings');

    await user.type(
      await screen.findByRole('textbox', { name: 'New workspace name' }),
      'Project Atlas',
    );
    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(
        fetchCalls().filter(
          (call) => call.method === 'POST' && call.url.endsWith('/api/v1/workspaces'),
        ),
      ).toHaveLength(1);
      expect(workspaceButton('Project Atlas')).toBeVisible();
    });
  });

  it('leaves a shared workspace and returns to an accessible workspace', async () => {
    const user = userEvent.setup();
    stubCoreApi({ workspaces: [STUB_WORKSPACE, SHARED] });
    renderAt(<App />, `/w/${SHARED.id}/settings`);

    await user.click(await screen.findByRole('button', { name: 'Leave workspace' }));
    const confirmation = await screen.findByRole('dialog', { name: 'Leave workspace?' });
    await user.click(within(confirmation).getByRole('button', { name: 'Leave workspace' }));

    await waitFor(() => {
      expect(workspaceButton(STUB_WORKSPACE.name)).toBeVisible();
    });
    await user.click(workspaceButton(STUB_WORKSPACE.name));
    expect(
      within(screen.getByRole('region', { name: 'Workspaces' })).queryByRole('link', {
        name: SHARED.name,
      }),
    ).not.toBeInTheDocument();
  });

  it('archives a workspace before it can be permanently deleted', async () => {
    const user = userEvent.setup();
    stubCoreApi({ workspaces: [STUB_WORKSPACE, SHARED] });
    renderAt(<App />, '/settings');

    await user.click(await screen.findByRole('button', { name: 'Archive workspace' }));
    const dialog = await screen.findByRole('dialog', { name: 'Archive workspace?' });
    await user.click(within(dialog).getByRole('button', { name: 'Archive workspace' }));

    expect(await screen.findByRole('heading', { name: 'Archived workspaces' })).toBeVisible();
    expect(screen.getByText(STUB_WORKSPACE.name)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Restore workspace' })).toBeVisible();
    expect(
      fetchCalls().some((call) => call.url.endsWith(`/workspaces/${STUB_WORKSPACE.id}/archive`)),
    ).toBe(true);
  });

  it('shows an invited user only the invitation until they accept it', async () => {
    const user = userEvent.setup();
    stubCoreApi({ workspaces: [STUB_WORKSPACE, PENDING], invitations: [PENDING_INVITATION] });
    renderAt(<App />, `/w/${PENDING.id}`);

    expect(
      await screen.findByRole('complementary', { name: 'Workspace invitation' }),
    ).toHaveTextContent(/You were invited/i);
    expect(screen.queryByRole('main')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Accept' }));

    await waitFor(() => {
      expect(
        screen.queryByRole('complementary', { name: 'Workspace invitation' }),
      ).not.toBeInTheDocument();
    });
    expect(workspaceButton(PENDING.name)).toBeVisible();
  });

  it('lets the invited user decline and removes the invited workspace', async () => {
    const user = userEvent.setup();
    stubCoreApi({ workspaces: [STUB_WORKSPACE, PENDING], invitations: [PENDING_INVITATION] });
    renderAt(<App />, `/w/${PENDING.id}`);

    await user.click(await screen.findByRole('button', { name: 'Decline' }));

    await waitFor(() => {
      expect(workspaceButton(STUB_WORKSPACE.name)).toBeVisible();
    });
    await user.click(workspaceButton(STUB_WORKSPACE.name));
    expect(
      within(screen.getByRole('region', { name: 'Workspaces' })).queryByRole('link', {
        name: PENDING.name,
      }),
    ).not.toBeInTheDocument();
  });

  it('keeps a failed leave confirmation open, focused and announced', async () => {
    const user = userEvent.setup();
    stubCoreApi({ workspaces: [STUB_WORKSPACE, SHARED], leaveFails: true });
    renderAt(<App />, `/w/${SHARED.id}/settings`);

    await user.click(await screen.findByRole('button', { name: 'Leave workspace' }));
    const dialog = await screen.findByRole('dialog', { name: 'Leave workspace?' });
    const leave = within(dialog).getByRole('button', { name: 'Leave workspace' });
    leave.focus();
    await user.click(leave);

    expect(dialog).toBeVisible();
    expect(leave).toHaveFocus();
    expect(await screen.findByRole('alert')).toHaveTextContent('The workspace could not be left.');
    expect(workspaceButton(SHARED.name)).toBeVisible();
  });

  it('renders a permission-filtered workspace without management controls', async () => {
    stubCoreApi({
      workspaces: [{ ...STUB_WORKSPACE, canManageMembers: false, canRename: false }],
    });
    renderAt(<App />, '/settings');

    expect(await screen.findByText(/cannot manage its members/i)).toBeVisible();
    expect(screen.queryByRole('textbox', { name: 'Workspace name' })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Person' })).not.toBeInTheDocument();
  });

  it('keeps member and invitation failures independent', async () => {
    stubCoreApi({ members, invitationsFail: true });
    renderAt(<App />, '/settings');

    expect(await screen.findByText('Working editor')).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Invitations could not be loaded' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible();
    expect(screen.queryByText('No invitation history yet.')).not.toBeInTheDocument();
  });

  it('shows a legacy commenter without offering that role as a new assignment', async () => {
    stubCoreApi({
      members: [
        {
          ...EDITOR_MEMBER,
          subjectDisplayName: 'Legacy commenter',
          role: 'commenter',
          assignableRoles: ['editor', 'viewer'],
        },
      ],
    });
    renderAt(<App />, '/settings');

    const role = await screen.findByRole('combobox', { name: 'Role for Legacy commenter' });
    expect(within(role).getByRole('option', { name: 'Commenter (legacy)' })).toBeDisabled();
    // The invite form renders from its own request, so it can arrive after the member list.
    expect(await screen.findByRole('combobox', { name: 'Role' })).not.toContainHTML('commenter');
  });

  it('remounts workspace-owned form, notice and confirmation state on a switch', async () => {
    const user = userEvent.setup();
    stubCoreApi({ workspaces: [STUB_WORKSPACE, SHARED], members });
    renderAt(<App />, '/settings');

    const rename = await screen.findByRole('textbox', { name: 'Workspace name' });
    await user.clear(rename);
    await user.type(rename, 'Unsaved personal name');
    await user.selectOptions(
      await screen.findByRole('combobox', { name: 'Person' }),
      '77777777-bbbb-4bbb-8bbb-777777777777',
    );
    await user.click(screen.getByRole('button', { name: 'Invite' }));
    expect(await screen.findByText(/New Person was invited/i)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Remove Working editor' }));
    expect(await screen.findByRole('dialog', { name: 'Remove Working editor?' })).toBeVisible();

    await switchWorkspace(user, SHARED.name);

    await waitFor(() => {
      expect(workspaceButton(SHARED.name)).toBeVisible();
    });
    expect(
      screen.queryByRole('dialog', { name: 'Remove Working editor?' }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: 'Settings' }));
    expect(await screen.findByRole('textbox', { name: 'Workspace name' })).toHaveValue(SHARED.name);
    const people = await screen.findByRole('combobox', { name: 'Person' });
    expect(people).toHaveValue('');
    expect(
      within(people).getByRole('option', { name: /New Person.*Invitation pending/ }),
    ).toBeDisabled();
    expect(screen.queryByText(/New Person was invited/i)).not.toBeInTheDocument();
  });

  it('keeps a failed removal confirmation open and reports the refusal live', async () => {
    const user = userEvent.setup();
    stubCoreApi({ members, memberMutationFails: true });
    renderAt(<App />, '/settings');

    await user.click(await screen.findByRole('button', { name: 'Remove Working editor' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove Working editor?' });
    await user.click(within(dialog).getByRole('button', { name: 'Remove member' }));

    expect(dialog).toBeVisible();
    expect(await screen.findByRole('alert')).toHaveTextContent('The member could not be removed.');
  });

  it('keeps the incomplete-list warning after locally creating a workspace', async () => {
    const user = userEvent.setup();
    stubCoreApi({ workspaces: [STUB_WORKSPACE, SHARED], workspacesPartial: true });
    renderAt(<App />, '/settings');

    await waitFor(() => {
      expect(document.body).toHaveTextContent(/list may be incomplete/i);
    });
    await user.type(screen.getByRole('textbox', { name: 'New workspace name' }), 'Local project');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(workspaceButton('Local project')).toBeVisible();
    });
    await waitFor(() => {
      expect(document.body).toHaveTextContent(/list may be incomplete/i);
    });
  });

  it('does not let a delayed workspace refresh erase a workspace created while it was loading', async () => {
    const user = userEvent.setup();
    stubCoreApi();
    const fallbackFetch = fetch;
    let listRequests = 0;
    const refresh = { finish: null as ((response: Response) => void) | null };
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : null;
        const url = requestUrl(input);
        const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
        if (method === 'GET' && new URL(url, location.origin).pathname === '/api/v1/workspaces') {
          listRequests += 1;
          if (listRequests === 2) {
            return new Promise<Response>((resolve) => {
              refresh.finish = resolve;
            });
          }
        }
        return fallbackFetch(input, init);
      }),
    );
    renderAt(<App />, '/settings');

    const rename = await screen.findByRole('textbox', { name: 'Workspace name' });
    await user.clear(rename);
    await user.type(rename, 'Renamed personal workspace');
    await user.click(screen.getByRole('button', { name: 'Rename' }));
    await waitFor(() => {
      expect(refresh.finish).not.toBeNull();
    });

    await user.type(
      screen.getByRole('textbox', { name: 'New workspace name' }),
      'New local project',
    );
    await user.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => {
      expect(workspaceButton('New local project')).toBeVisible();
    });

    refresh.finish?.(
      new Response(JSON.stringify({ items: [STUB_WORKSPACE], nextCursor: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await waitFor(() => {
      expect(workspaceButton('New local project')).toBeVisible();
    });
  });

  it('keeps a stale list behind a local rename, then accepts a later authoritative name and capability', async () => {
    const user = userEvent.setup();
    stubCoreApi({ workspaces: [STUB_WORKSPACE, SHARED] });
    const fallbackFetch = fetch;
    let listRequests = 0;
    const deferred = new Map<number, (response: Response) => void>();
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : null;
        const url = requestUrl(input);
        const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
        if (method === 'GET' && new URL(url, location.origin).pathname === '/api/v1/workspaces') {
          listRequests += 1;
          if (listRequests === 2 || listRequests === 3) {
            return new Promise<Response>((resolve) => {
              deferred.set(listRequests, resolve);
            });
          }
        }
        return fallbackFetch(input, init);
      }),
    );
    renderAt(<App />, '/settings');

    const rename = await screen.findByRole('textbox', { name: 'Workspace name' });
    await user.clear(rename);
    await user.type(rename, 'Locally renamed');
    await user.click(screen.getByRole('button', { name: 'Rename' }));
    await waitFor(() => {
      expect(deferred.has(2)).toBe(true);
    });
    deferred.get(2)?.(
      new Response(JSON.stringify({ items: [STUB_WORKSPACE, SHARED], nextCursor: null }), {
        headers: { 'content-type': 'application/json' },
      }),
    );
    await waitFor(() => {
      expect(workspaceButton('Locally renamed')).toBeVisible();
    });

    await switchWorkspace(user, SHARED.name);
    await user.click(await screen.findByRole('link', { name: 'Settings' }));
    await user.click(await screen.findByRole('button', { name: 'Leave workspace' }));
    await user.click(
      within(await screen.findByRole('dialog', { name: 'Leave workspace?' })).getByRole('button', {
        name: 'Leave workspace',
      }),
    );
    await waitFor(() => {
      expect(deferred.has(3)).toBe(true);
    });
    deferred.get(3)?.(
      new Response(
        JSON.stringify({
          items: [
            {
              ...STUB_WORKSPACE,
              name: 'Authoritative workspace',
              canRename: false,
              canManageMembers: false,
            },
          ],
          nextCursor: null,
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
    );

    await waitFor(() => {
      expect(workspaceButton('Authoritative workspace')).toBeVisible();
    });
    await user.click(screen.getByRole('link', { name: 'Settings' }));
    expect(await screen.findByText(/cannot manage its members/i)).toBeVisible();
    expect(screen.queryByRole('textbox', { name: 'Workspace name' })).not.toBeInTheDocument();
  });
});

function fetchCalls(): readonly { readonly url: string; readonly method: string }[] {
  return (
    fetch as unknown as { mock: { calls: [RequestInfo | URL, RequestInit | undefined][] } }
  ).mock.calls.map(([input, init]) => ({
    url: requestUrl(input),
    method: (init?.method ?? 'GET').toUpperCase(),
  }));
}
