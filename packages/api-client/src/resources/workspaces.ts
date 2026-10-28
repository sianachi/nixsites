/**
 * The workspaces resource: the only place workspace URLs appear.
 *
 * A workspace list is how a caller finds the ids every item command needs, so it is the first thing
 * a scripted session reads. Cursor-paginated like every collection here, and consumed through the
 * client's `paginate`, so a caller never sees a cursor.
 */

import {
  defineCommand,
  definePagedQuery,
  defineQuery,
  type CommandEndpoint,
  type PagedQueryEndpoint,
  type QueryEndpoint,
} from '../endpoints.js';
import {
  dailyNoteSchema,
  dailyNoteSettingsSchema,
  noContentSchema,
  workspaceInvitationSchema,
  workspaceInviteeSchema,
  workspaceMemberSchema,
  workspacePrincipalSchema,
  workspaceSchema,
  type DailyNote,
  type DailyNoteSettings,
  type Workspace,
  type WorkspaceInvitation,
  type WorkspaceInvitee,
  type WorkspaceMember,
  type WorkspacePrincipal,
} from '../schemas/index.js';
import { cursorPageSchema, type CursorPage } from '../schemas/pagination.js';
import type {
  ChangeWorkspaceMemberRoleRequestContract,
  CreateWorkspaceInvitationRequestContract,
  CreateWorkspaceRequestContract,
  RecoverWorkspaceRequestContract,
  RenameWorkspaceRequestContract,
  SaveDailyNoteSettingsRequestContract,
  SetWorkspaceSharingRequestContract,
} from '../contracts.js';

export type AssignableWorkspaceRole = ChangeWorkspaceMemberRoleRequestContract['role'];

export interface WorkspacePageOptions {
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

/** Every workspace the caller can reach, in the order Core returns them. */
export const listWorkspaces = (): PagedQueryEndpoint<Workspace> =>
  definePagedQuery<Workspace>({
    operation: 'workspaces.list',
    path: '/api/v1/workspaces',
    itemSchema: workspaceSchema,
  });

export const listWorkspacesPage = (
  options: WorkspacePageOptions = {},
): QueryEndpoint<CursorPage<Workspace>> =>
  defineQuery({
    operation: 'workspaces.list.page',
    path: '/api/v1/workspaces',
    query: { cursor: options.cursor, limit: options.limit },
    schema: cursorPageSchema(workspaceSchema),
  });

/** One workspace by id. */
export const workspaceById = (workspaceId: string): QueryEndpoint<Workspace> =>
  defineQuery<Workspace>({
    operation: 'workspaces.get',
    path: `/api/v1/workspaces/${workspaceId}`,
    schema: workspaceSchema,
    cacheKey: ['workspaces', workspaceId],
  });

const workspaceListKey = ['workspaces'] as const;
export const createWorkspace = (name: string): CommandEndpoint<Workspace> =>
  defineCommand({
    operation: 'workspaces.create',
    method: 'POST',
    path: '/api/v1/workspaces',
    body: { name } satisfies CreateWorkspaceRequestContract,
    schema: workspaceSchema,
    invalidates: [workspaceListKey],
  });
export const renameWorkspace = (workspaceId: string, name: string): CommandEndpoint<Workspace> =>
  defineCommand({
    operation: 'workspaces.rename',
    method: 'PATCH',
    path: `/api/v1/workspaces/${workspaceId}`,
    body: { name } satisfies RenameWorkspaceRequestContract,
    schema: workspaceSchema,
    invalidates: [workspaceListKey, ['workspaces', workspaceId]],
  });
/** Closes or opens a workspace to new members, and turns live collaboration on or off. Owners only. */
export const setWorkspaceSharing = (
  workspaceId: string,
  input: { readonly membershipLocked?: boolean; readonly collaboration?: boolean },
): CommandEndpoint<Workspace> =>
  defineCommand({
    operation: 'workspaces.setSharing',
    method: 'PUT',
    path: `/api/v1/workspaces/${workspaceId}/sharing`,
    body: {
      membershipLocked: input.membershipLocked ?? null,
      collaboration: input.collaboration ?? null,
    } satisfies SetWorkspaceSharingRequestContract,
    schema: workspaceSchema,
    invalidates: [workspaceListKey, ['workspaces', workspaceId]],
  });
export const archiveWorkspace = (workspaceId: string): CommandEndpoint<Workspace> =>
  defineCommand({
    operation: 'workspaces.archive',
    method: 'POST',
    path: `/api/v1/workspaces/${workspaceId}/archive`,
    schema: workspaceSchema,
    invalidates: [workspaceListKey, ['workspaces', workspaceId]],
  });
export const restoreWorkspace = (workspaceId: string): CommandEndpoint<Workspace> =>
  defineCommand({
    operation: 'workspaces.restore',
    method: 'POST',
    path: `/api/v1/workspaces/${workspaceId}/restore`,
    schema: workspaceSchema,
    invalidates: [workspaceListKey, ['workspaces', workspaceId]],
  });
export const purgeWorkspace = (workspaceId: string): CommandEndpoint<undefined> =>
  defineCommand({
    operation: 'workspaces.purge',
    method: 'DELETE',
    path: `/api/v1/workspaces/${workspaceId}`,
    schema: noContentSchema,
    invalidates: [workspaceListKey, ['workspaces', workspaceId]],
  });
export const listMembers = (workspaceId: string): PagedQueryEndpoint<WorkspaceMember> =>
  definePagedQuery({
    operation: 'workspaces.members.list',
    path: `/api/v1/workspaces/${workspaceId}/members`,
    itemSchema: workspaceMemberSchema,
  });
export const listMembersPage = (
  workspaceId: string,
  options: WorkspacePageOptions = {},
): QueryEndpoint<CursorPage<WorkspaceMember>> =>
  defineQuery({
    operation: 'workspaces.members.list.page',
    path: `/api/v1/workspaces/${workspaceId}/members`,
    query: { cursor: options.cursor, limit: options.limit },
    schema: cursorPageSchema(workspaceMemberSchema),
  });

export interface AssignablePrincipalPageOptions extends WorkspacePageOptions {
  readonly query?: string | undefined;
}

export const listAssignablePrincipalsPage = (
  workspaceId: string,
  options: AssignablePrincipalPageOptions = {},
): QueryEndpoint<CursorPage<WorkspacePrincipal>> =>
  defineQuery({
    operation: 'workspaces.principals.list.page',
    path: `/api/v1/workspaces/${workspaceId}/principals`,
    query: { query: options.query, cursor: options.cursor, limit: options.limit },
    schema: cursorPageSchema(workspacePrincipalSchema),
    cacheKey: ['workspaces', workspaceId, 'principals', options.query ?? '', options.cursor ?? ''],
    staleAfterMs: 0,
  });

export const listAssignablePrincipals = (
  workspaceId: string,
  query?: string,
): PagedQueryEndpoint<WorkspacePrincipal> =>
  definePagedQuery({
    operation: 'workspaces.principals.list',
    path: `/api/v1/workspaces/${workspaceId}/principals`,
    query: query === undefined ? undefined : { query },
    itemSchema: workspacePrincipalSchema,
    pageSize: 100,
  });
export const changeMemberRole = (
  workspaceId: string,
  principalId: string,
  role: AssignableWorkspaceRole,
): CommandEndpoint<WorkspaceMember> =>
  defineCommand({
    operation: 'workspaces.members.change',
    method: 'PATCH',
    path: `/api/v1/workspaces/${workspaceId}/members/${principalId}`,
    body: { role } satisfies ChangeWorkspaceMemberRoleRequestContract,
    schema: workspaceMemberSchema,
    invalidates: [['workspaces', workspaceId, 'members']],
  });
export const removeMember = (
  workspaceId: string,
  principalId: string,
): CommandEndpoint<undefined> =>
  defineCommand({
    operation: 'workspaces.members.remove',
    method: 'DELETE',
    path: `/api/v1/workspaces/${workspaceId}/members/${principalId}`,
    schema: noContentSchema,
    invalidates: [['workspaces', workspaceId, 'members']],
  });
export const leaveWorkspace = (workspaceId: string): CommandEndpoint<undefined> =>
  defineCommand({
    operation: 'workspaces.leave',
    method: 'POST',
    path: `/api/v1/workspaces/${workspaceId}/leave`,
    schema: noContentSchema,
    invalidates: [workspaceListKey],
  });
export const recoverWorkspace = (
  workspaceId: string,
  newOwnerPrincipalId: string,
): CommandEndpoint<Workspace> =>
  defineCommand({
    operation: 'workspaces.recover',
    method: 'POST',
    path: `/api/v1/workspaces/${workspaceId}/recover`,
    body: { newOwnerPrincipalId } satisfies RecoverWorkspaceRequestContract,
    schema: workspaceSchema,
    invalidates: [workspaceListKey, ['workspaces', workspaceId]],
  });
export const listInvitations = (workspaceId: string): PagedQueryEndpoint<WorkspaceInvitation> =>
  definePagedQuery({
    operation: 'workspaces.invitations.list',
    path: `/api/v1/workspaces/${workspaceId}/invitations`,
    itemSchema: workspaceInvitationSchema,
  });
export const listInvitationsPage = (
  workspaceId: string,
  options: WorkspacePageOptions = {},
): QueryEndpoint<CursorPage<WorkspaceInvitation>> =>
  defineQuery({
    operation: 'workspaces.invitations.list.page',
    path: `/api/v1/workspaces/${workspaceId}/invitations`,
    query: { cursor: options.cursor, limit: options.limit },
    schema: cursorPageSchema(workspaceInvitationSchema),
  });
export const createInvitation = (
  workspaceId: string,
  principalId: string,
  role: AssignableWorkspaceRole,
): CommandEndpoint<WorkspaceInvitation> =>
  defineCommand({
    operation: 'workspaces.invitations.create',
    method: 'POST',
    path: `/api/v1/workspaces/${workspaceId}/invitations`,
    body: { principalId, role } satisfies CreateWorkspaceInvitationRequestContract,
    schema: workspaceInvitationSchema,
    invalidates: [
      ['workspaces', workspaceId, 'invitations'],
      ['workspaces', workspaceId, 'members'],
    ],
  });
export const listInvitees = (
  workspaceId: string,
  query?: string,
): PagedQueryEndpoint<WorkspaceInvitee> =>
  definePagedQuery({
    operation: 'workspaces.invitees.list',
    path: `/api/v1/workspaces/${workspaceId}/invitees`,
    query: query === undefined ? undefined : { query },
    itemSchema: workspaceInviteeSchema,
  });
export const listInviteesPage = (
  workspaceId: string,
  options: AssignablePrincipalPageOptions = {},
): QueryEndpoint<CursorPage<WorkspaceInvitee>> =>
  defineQuery({
    operation: 'workspaces.invitees.list.page',
    path: `/api/v1/workspaces/${workspaceId}/invitees`,
    query: { query: options.query, cursor: options.cursor, limit: options.limit },
    schema: cursorPageSchema(workspaceInviteeSchema),
    cacheKey: [
      'workspaces',
      workspaceId,
      'invitees',
      options.query ?? '',
      options.cursor ?? '',
      String(options.limit ?? 50),
    ],
    staleAfterMs: 0,
  });
export const revokeInvitation = (
  workspaceId: string,
  invitationId: string,
): CommandEndpoint<undefined> =>
  defineCommand({
    operation: 'workspaces.invitations.revoke',
    method: 'DELETE',
    path: `/api/v1/workspaces/${workspaceId}/invitations/${invitationId}`,
    schema: noContentSchema,
    invalidates: [['workspaces', workspaceId, 'invitations']],
  });
export const acceptInvitation = (
  workspaceId: string,
  invitationId: string,
): CommandEndpoint<undefined> =>
  defineCommand({
    operation: 'workspaces.invitations.accept',
    method: 'POST',
    path: `/api/v1/workspaces/${workspaceId}/invitations/${invitationId}/accept`,
    schema: noContentSchema,
    invalidates: [workspaceListKey, ['workspaces', workspaceId]],
  });
export const declineInvitation = (
  workspaceId: string,
  invitationId: string,
): CommandEndpoint<undefined> =>
  defineCommand({
    operation: 'workspaces.invitations.decline',
    method: 'POST',
    path: `/api/v1/workspaces/${workspaceId}/invitations/${invitationId}/decline`,
    schema: noContentSchema,
    invalidates: [workspaceListKey, ['workspaces', workspaceId]],
  });
export const openDailyNote = (workspaceId: string, date: string): CommandEndpoint<DailyNote> =>
  defineCommand({
    operation: 'workspaces.daily.open',
    method: 'PUT',
    path: `/api/v1/workspaces/${workspaceId}/daily-notes/${date}`,
    schema: dailyNoteSchema,
  });

const dailyNoteSettingsKey = (workspaceId: string) =>
  ['workspaces', workspaceId, 'daily-notes', 'settings'] as const;

/** The workspace's effective daily-note settings, defaults applied. */
export const dailyNoteSettings = (workspaceId: string): QueryEndpoint<DailyNoteSettings> =>
  defineQuery<DailyNoteSettings>({
    operation: 'workspaces.daily.settings.get',
    path: `/api/v1/workspaces/${workspaceId}/daily-notes/settings`,
    schema: dailyNoteSettingsSchema,
    cacheKey: dailyNoteSettingsKey(workspaceId),
  });

/**
 * Replaces the workspace's daily-note settings. It also invalidates the workspace queries, because
 * `canUseDailyNotes` follows the `enabled` setting.
 */
export const saveDailyNoteSettings = (
  workspaceId: string,
  settings: DailyNoteSettings,
): CommandEndpoint<DailyNoteSettings> =>
  defineCommand({
    operation: 'workspaces.daily.settings.save',
    method: 'PUT',
    path: `/api/v1/workspaces/${workspaceId}/daily-notes/settings`,
    body: settings satisfies SaveDailyNoteSettingsRequestContract,
    schema: dailyNoteSettingsSchema,
    invalidates: [workspaceListKey, ['workspaces', workspaceId], dailyNoteSettingsKey(workspaceId)],
  });
