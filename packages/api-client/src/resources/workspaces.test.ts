import { describe, expect, it } from 'vitest';

import {
  dailyNoteSchema,
  workspaceInvitationSchema,
  workspaceInviteeSchema,
  workspaceMemberSchema,
  workspaceSchema,
} from '../schemas/index.js';

import {
  acceptInvitation,
  changeMemberRole,
  createInvitation,
  createWorkspace,
  declineInvitation,
  leaveWorkspace,
  listInvitations,
  listInvitees,
  listInviteesPage,
  listMembers,
  listAssignablePrincipalsPage,
  listWorkspaces,
  openDailyNote,
  removeMember,
  renameWorkspace,
  revokeInvitation,
  workspaceById,
} from './workspaces.js';

const WORKSPACE_ID = 'a1000000-0000-4000-8000-000000000001';
const PRINCIPAL_ID = 'a2000000-0000-4000-8000-000000000002';
const INVITATION_ID = 'a3000000-0000-4000-8000-000000000003';

describe('the workspaces resource', () => {
  it('owns workspace discovery and mutation URLs', () => {
    expect(listWorkspaces()).toMatchObject({
      path: '/api/v1/workspaces',
    });
    expect(workspaceById(WORKSPACE_ID)).toMatchObject({
      path: `/api/v1/workspaces/${WORKSPACE_ID}`,
      cacheKey: ['workspaces', WORKSPACE_ID],
    });
    expect(createWorkspace('Writing')).toMatchObject({
      method: 'POST',
      path: '/api/v1/workspaces',
      body: { name: 'Writing' },
      invalidates: [['workspaces']],
    });
    expect(renameWorkspace(WORKSPACE_ID, 'Research')).toMatchObject({
      method: 'PATCH',
      path: `/api/v1/workspaces/${WORKSPACE_ID}`,
      body: { name: 'Research' },
    });
    expect(leaveWorkspace(WORKSPACE_ID)).toMatchObject({
      method: 'POST',
      path: `/api/v1/workspaces/${WORKSPACE_ID}/leave`,
    });
  });

  it('owns member operations and their cache invalidation', () => {
    expect(listMembers(WORKSPACE_ID)).toMatchObject({
      path: `/api/v1/workspaces/${WORKSPACE_ID}/members`,
    });
    expect(changeMemberRole(WORKSPACE_ID, PRINCIPAL_ID, 'editor')).toMatchObject({
      method: 'PATCH',
      path: `/api/v1/workspaces/${WORKSPACE_ID}/members/${PRINCIPAL_ID}`,
      body: { role: 'editor' },
      invalidates: [['workspaces', WORKSPACE_ID, 'members']],
    });
    expect(removeMember(WORKSPACE_ID, PRINCIPAL_ID)).toMatchObject({
      method: 'DELETE',
      path: `/api/v1/workspaces/${WORKSPACE_ID}/members/${PRINCIPAL_ID}`,
      invalidates: [['workspaces', WORKSPACE_ID, 'members']],
    });
  });

  it('lists bounded assignable direct and group-derived principals', () => {
    expect(
      listAssignablePrincipalsPage(WORKSPACE_ID, {
        query: 'Ada',
        limit: 25,
        cursor: PRINCIPAL_ID,
      }),
    ).toMatchObject({
      operation: 'workspaces.principals.list.page',
      path: `/api/v1/workspaces/${WORKSPACE_ID}/principals`,
      query: { query: 'Ada', limit: 25, cursor: PRINCIPAL_ID },
    });
  });

  it('keeps the invitee search on every page and separates page cache keys', () => {
    expect(listInvitees(WORKSPACE_ID, 'Ada')).toMatchObject({ query: { query: 'Ada' } });
    expect(
      listInviteesPage(WORKSPACE_ID, { query: 'Ada', cursor: 'next', limit: 25 }),
    ).toMatchObject({
      query: { query: 'Ada', cursor: 'next', limit: 25 },
      cacheKey: ['workspaces', WORKSPACE_ID, 'invitees', 'Ada', 'next', '25'],
      staleAfterMs: 0,
    });
  });

  it('owns invitation operations and invalidates both affected collections', () => {
    expect(listInvitations(WORKSPACE_ID)).toMatchObject({
      path: `/api/v1/workspaces/${WORKSPACE_ID}/invitations`,
    });
    expect(listInvitees(WORKSPACE_ID)).toMatchObject({
      path: `/api/v1/workspaces/${WORKSPACE_ID}/invitees`,
    });
    expect(createInvitation(WORKSPACE_ID, PRINCIPAL_ID, 'viewer')).toMatchObject({
      method: 'POST',
      body: { principalId: PRINCIPAL_ID, role: 'viewer' },
      invalidates: [
        ['workspaces', WORKSPACE_ID, 'invitations'],
        ['workspaces', WORKSPACE_ID, 'members'],
      ],
    });
    expect(revokeInvitation(WORKSPACE_ID, INVITATION_ID)).toMatchObject({
      method: 'DELETE',
      path: `/api/v1/workspaces/${WORKSPACE_ID}/invitations/${INVITATION_ID}`,
      invalidates: [['workspaces', WORKSPACE_ID, 'invitations']],
    });
    expect(acceptInvitation(WORKSPACE_ID, INVITATION_ID)).toMatchObject({
      method: 'POST',
      path: `/api/v1/workspaces/${WORKSPACE_ID}/invitations/${INVITATION_ID}/accept`,
    });
    expect(declineInvitation(WORKSPACE_ID, INVITATION_ID)).toMatchObject({
      method: 'POST',
      path: `/api/v1/workspaces/${WORKSPACE_ID}/invitations/${INVITATION_ID}/decline`,
    });
  });

  it('describes the idempotent daily-note operation', () => {
    expect(openDailyNote(WORKSPACE_ID, '2026-08-30')).toMatchObject({
      method: 'PUT',
      path: `/api/v1/workspaces/${WORKSPACE_ID}/daily-notes/2026-08-30`,
    });
  });

  it('parses capability-bearing workspace administration responses', () => {
    expect(
      workspaceSchema.parse({
        id: WORKSPACE_ID,
        name: 'Personal workspace',
        versionRetentionDays: 90,
        storageQuotaBytes: '10737418240',
        createdAt: '2026-08-30T10:00:00+00:00',
        kind: 'personal',
        canRename: true,
        canManageMembers: true,
        canLeave: false,
        canUseDailyNotes: true,
        pendingInvitationId: null,
        lifecycleState: 'active',
        archivedAt: null,
      }),
    ).toMatchObject({ kind: 'personal', canLeave: false });

    expect(
      workspaceMemberSchema.parse({
        subjectType: 'principal',
        subjectId: PRINCIPAL_ID,
        subjectDisplayName: 'Reader',
        email: null,
        role: 'commenter',
        grantedAt: '2026-08-30T10:00:00+00:00',
        canChangeRole: true,
        canRemove: true,
        assignableRoles: ['editor', 'viewer'],
      }),
    ).toMatchObject({ role: 'commenter', assignableRoles: ['editor', 'viewer'] });

    expect(
      workspaceInvitationSchema.parse({
        id: INVITATION_ID,
        emailNormalized: 'reader@example.com',
        targetPrincipalId: PRINCIPAL_ID,
        role: 'viewer',
        status: 'pending',
        invitedByPrincipalId: PRINCIPAL_ID,
        invitedAt: '2026-08-30T10:00:00+00:00',
        acceptedAt: null,
        acceptedByPrincipalId: null,
        revokedAt: null,
      }),
    ).toMatchObject({ status: 'pending', role: 'viewer' });

    expect(
      workspaceInviteeSchema.parse({
        principalId: PRINCIPAL_ID,
        displayName: 'Reader',
        email: 'reader@example.com',
        canInvite: true,
        cannotInviteReason: null,
      }),
    ).toMatchObject({ displayName: 'Reader' });

    expect(dailyNoteSchema.parse({ itemId: PRINCIPAL_ID })).toEqual({
      itemId: PRINCIPAL_ID,
      created: false,
    });
  });

  it('accepts commenter as an assignable role', () => {
    expect(
      workspaceMemberSchema.safeParse({
        subjectType: 'principal',
        subjectId: PRINCIPAL_ID,
        subjectDisplayName: 'Reader',
        email: 'reader@example.com',
        role: 'commenter',
        grantedAt: '2026-08-30T10:00:00+00:00',
        canChangeRole: true,
        canRemove: true,
        assignableRoles: ['commenter'],
      }).success,
    ).toBe(true);
  });
});
