/**
 * `nixctl ws`: the workspaces a token can reach.
 *
 * The list is the first thing a scripted session reads, because every item command needs a
 * workspace id and this is where they come from. List commands return one bounded cursor page so
 * automation cannot accidentally materialize an unbounded tenant history.
 */

import { readFile } from 'node:fs/promises';
import {
  workspaces,
  workspaceGraph,
  dailyNoteSettingsSchema,
  type AssignableWorkspaceRole,
} from '@nix/api-client';
import { assertConfirmed, resolveSession, type SessionDeps } from './shared.ts';
import { printResult, type OutputOptions } from '../output.ts';

/** Lists one bounded page of workspaces the profile can reach. */
export async function listWorkspaces(
  profileName: string | undefined,
  page: WorkspacePageOptions,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const session = await resolveSession(profileName, deps);
  const result = await session.client.query(workspaces.listWorkspacesPage(validatePage(page)));
  printResult(
    { workspaces: result.items, count: result.items.length, nextCursor: result.nextCursor },
    output,
  );
}

/** Reads the graph with Core's visibility rules and truncation flags intact. */
export async function readWorkspaceGraph(
  profileName: string | undefined,
  workspaceId: string,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const session = await resolveSession(profileName, deps);
  printResult(await session.client.query(workspaceGraph.workspaceGraph(workspaceId)), output);
}

export async function createWorkspace(
  profileName: string | undefined,
  name: string,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const session = await resolveSession(profileName, deps);
  printResult(await session.client.execute(workspaces.createWorkspace(name)), output);
}

export async function renameWorkspace(
  profileName: string | undefined,
  workspaceId: string,
  name: string,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const session = await resolveSession(profileName, deps);
  printResult(await session.client.execute(workspaces.renameWorkspace(workspaceId, name)), output);
}

/** Closes or opens a workspace to new members, and turns live collaboration on or off. */
export async function setWorkspaceSharing(
  profileName: string | undefined,
  workspaceId: string,
  options: { readonly members?: string; readonly collaboration?: string },
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const parse = (value: string | undefined, flag: string): boolean | undefined => {
    if (value === undefined) return undefined;
    if (value !== 'on' && value !== 'off') throw new Error(`${flag} must be 'on' or 'off'.`);
    return value === 'on';
  };
  const members = parse(options.members, '--members');
  const collaboration = parse(options.collaboration, '--collaboration');
  const session = await resolveSession(profileName, deps);
  printResult(
    await session.client.execute(
      workspaces.setWorkspaceSharing(workspaceId, {
        ...(members === undefined ? {} : { membershipLocked: !members }),
        ...(collaboration === undefined ? {} : { collaboration }),
      }),
    ),
    output,
  );
}

/** Removes a workspace from everyday navigation without deleting its durable data. */
export async function archiveWorkspace(
  profileName: string | undefined,
  workspaceId: string,
  confirmed: boolean,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  assertConfirmed(confirmed);
  const session = await resolveSession(profileName, deps);
  printResult(await session.client.execute(workspaces.archiveWorkspace(workspaceId)), output);
}

/** Returns an archived workspace to ordinary use. */
export async function restoreWorkspace(
  profileName: string | undefined,
  workspaceId: string,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const session = await resolveSession(profileName, deps);
  printResult(await session.client.execute(workspaces.restoreWorkspace(workspaceId)), output);
}

/** Schedules irreversible deletion of a workspace that has already been archived. */
export async function purgeWorkspace(
  profileName: string | undefined,
  workspaceId: string,
  confirmed: boolean,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  assertConfirmed(confirmed);
  const session = await resolveSession(profileName, deps);
  await session.client.execute(workspaces.purgeWorkspace(workspaceId));
  printResult({ purging: true, workspaceId }, output);
}

export async function listWorkspaceInvitations(
  profileName: string | undefined,
  workspaceId: string,
  page: WorkspacePageOptions,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const session = await resolveSession(profileName, deps);
  const result = await session.client.query(
    workspaces.listInvitationsPage(workspaceId, validatePage(page)),
  );
  printResult(
    { invitations: result.items, count: result.items.length, nextCursor: result.nextCursor },
    output,
  );
}

export async function listWorkspaceInvitees(
  profileName: string | undefined,
  workspaceId: string,
  page: WorkspacePageOptions & { readonly query?: string | undefined },
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const query = page.query?.trim();
  if (query !== undefined && query.length > 128) {
    throw new Error('Search text must not exceed 128 characters.');
  }
  const session = await resolveSession(profileName, deps);
  const result = await session.client.query(
    workspaces.listInviteesPage(workspaceId, {
      ...validatePage(page),
      ...(query === undefined ? {} : { query }),
    }),
  );
  printResult(
    { invitees: result.items, count: result.items.length, nextCursor: result.nextCursor },
    output,
  );
}

export async function inviteWorkspaceMember(
  profileName: string | undefined,
  workspaceId: string,
  principalId: string,
  role: string,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  assertUiRole(role);
  const session = await resolveSession(profileName, deps);
  printResult(
    await session.client.execute(workspaces.createInvitation(workspaceId, principalId, role)),
    output,
  );
}

export async function acceptWorkspaceInvitation(
  profileName: string | undefined,
  workspaceId: string,
  invitationId: string,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const session = await resolveSession(profileName, deps);
  await session.client.execute(workspaces.acceptInvitation(workspaceId, invitationId));
  printResult({ accepted: true, invitationId }, output);
}

export async function declineWorkspaceInvitation(
  profileName: string | undefined,
  workspaceId: string,
  invitationId: string,
  confirmed: boolean,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  assertConfirmed(confirmed);
  const session = await resolveSession(profileName, deps);
  await session.client.execute(workspaces.declineInvitation(workspaceId, invitationId));
  printResult({ declined: true, invitationId }, output);
}

export async function revokeWorkspaceInvitation(
  profileName: string | undefined,
  workspaceId: string,
  invitationId: string,
  confirmed: boolean,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  assertConfirmed(confirmed);
  const session = await resolveSession(profileName, deps);
  await session.client.execute(workspaces.revokeInvitation(workspaceId, invitationId));
  printResult({ revoked: true, invitationId }, output);
}

export async function listWorkspaceMembers(
  profileName: string | undefined,
  workspaceId: string,
  page: WorkspacePageOptions,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const session = await resolveSession(profileName, deps);
  const result = await session.client.query(
    workspaces.listMembersPage(workspaceId, validatePage(page)),
  );
  printResult(
    { members: result.items, count: result.items.length, nextCursor: result.nextCursor },
    output,
  );
}

export async function listWorkspaceAssignablePrincipals(
  profileName: string | undefined,
  workspaceId: string,
  page: WorkspacePageOptions & { readonly query?: string | undefined },
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const limit = page.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('Page limit must be an integer from 1 through 100.');
  }
  if (page.cursor !== undefined && page.cursor.length > 128) {
    throw new Error('Cursor must not exceed 128 characters.');
  }
  const query = page.query?.trim();
  if (query !== undefined && query.length > 128) {
    throw new Error('Search text must not exceed 128 characters.');
  }
  const session = await resolveSession(profileName, deps);
  const result = await session.client.query(
    workspaces.listAssignablePrincipalsPage(workspaceId, {
      limit,
      ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
      ...(query === undefined ? {} : { query }),
    }),
  );
  printResult(
    { principals: result.items, count: result.items.length, nextCursor: result.nextCursor },
    output,
  );
}

export async function changeWorkspaceMemberRole(
  profileName: string | undefined,
  workspaceId: string,
  principalId: string,
  role: string,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  assertUiRole(role);
  const session = await resolveSession(profileName, deps);
  printResult(
    await session.client.execute(workspaces.changeMemberRole(workspaceId, principalId, role)),
    output,
  );
}

export async function removeWorkspaceMember(
  profileName: string | undefined,
  workspaceId: string,
  principalId: string,
  confirmed: boolean,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  assertConfirmed(confirmed);
  const session = await resolveSession(profileName, deps);
  await session.client.execute(workspaces.removeMember(workspaceId, principalId));
  printResult({ removed: true, principalId }, output);
}

export async function leaveWorkspace(
  profileName: string | undefined,
  workspaceId: string,
  confirmed: boolean,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  assertConfirmed(confirmed);
  const session = await resolveSession(profileName, deps);
  await session.client.execute(workspaces.leaveWorkspace(workspaceId));
  printResult({ left: true, workspaceId }, output);
}

export interface WorkspacePageOptions {
  readonly limit?: number | undefined;
  readonly cursor?: string | undefined;
}

function validatePage(page: WorkspacePageOptions): WorkspacePageOptions {
  const limit = page.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new Error('Page limit must be an integer from 1 through 200.');
  }
  if (page.cursor !== undefined && page.cursor.length > 512) {
    throw new Error('Cursor must not exceed 512 characters.');
  }
  return { limit, ...(page.cursor === undefined ? {} : { cursor: page.cursor }) };
}

function assertUiRole(role: string): asserts role is AssignableWorkspaceRole {
  if (role !== 'owner' && role !== 'editor' && role !== 'commenter' && role !== 'viewer')
    throw new Error("Role must be 'owner', 'editor', 'commenter', or 'viewer'.");
}

/** Read the effective settings or replace them from a validated JSON file. */
export async function dailyNoteSettings(
  profileName: string | undefined,
  workspaceId: string,
  file: string | undefined,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const settings =
    file === undefined
      ? undefined
      : dailyNoteSettingsSchema.parse(JSON.parse(await readFile(file, 'utf8')));
  const session = await resolveSession(profileName, deps);
  printResult(
    settings === undefined
      ? await session.client.query(workspaces.dailyNoteSettings(workspaceId))
      : await session.client.execute(workspaces.saveDailyNoteSettings(workspaceId, settings)),
    output,
  );
}

/** Open the one daily note for a canonical date through Core. */
export async function openDailyNote(
  profileName: string | undefined,
  workspaceId: string,
  date: string,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const session = await resolveSession(profileName, deps);
  printResult(await session.client.execute(workspaces.openDailyNote(workspaceId, date)), output);
}
