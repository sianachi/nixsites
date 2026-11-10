/**
 * `nixctl ws password|unlock|relock|join`: a workspace's password, managed by a person.
 *
 * A workspace password closes the workspace to its own members until they present it, and lets a
 * signed-in person in the same tenant join with the password. It withholds the workspace; it does
 * not encrypt it. An unlock belongs to the credential that asked - here, the profile's access
 * token - so it opens the workspace to this profile only, for as long as Core says.
 *
 * Passwords are read from stdin, never from an argument (see `readPasswords`). These commands are
 * the person's: the pet and MCP catalog refuses them, so an agent is never handed a password.
 * There is no recovery for a forgotten password.
 */

import { workspaceLocks } from '@nix/api-client';
import { resolveSession, type SessionDeps } from './shared.ts';
import { printResult, type OutputOptions } from '../output.ts';

/** Sets the workspace password, or changes it when `currentPassword` is given. Owners only. */
export async function setWorkspacePassword(
  profileName: string | undefined,
  workspaceId: string,
  password: string,
  currentPassword: string | undefined,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const session = await resolveSession(profileName, deps);
  await session.client.execute(
    workspaceLocks.setWorkspacePassword(workspaceId, password, currentPassword),
  );
  printResult(
    { id: workspaceId, passwordProtected: true, changed: currentPassword !== undefined },
    output,
  );
}

/** Removes the workspace password. Owners only. */
export async function removeWorkspacePassword(
  profileName: string | undefined,
  workspaceId: string,
  password: string,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const session = await resolveSession(profileName, deps);
  await session.client.execute(workspaceLocks.removeWorkspacePassword(workspaceId, password));
  printResult({ id: workspaceId, passwordProtected: false }, output);
}

/** Opens a protected workspace to this profile's token for a while. Members only. */
export async function unlockWorkspace(
  profileName: string | undefined,
  workspaceId: string,
  password: string,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const session = await resolveSession(profileName, deps);
  const result = await session.client.execute(
    workspaceLocks.unlockWorkspace(workspaceId, password),
  );
  printResult({ id: workspaceId, unlockedUntil: result.unlockedUntil }, output);
}

/** Closes a protected workspace to this profile's token again. */
export async function relockWorkspace(
  profileName: string | undefined,
  workspaceId: string,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const session = await resolveSession(profileName, deps);
  await session.client.execute(workspaceLocks.relockWorkspace(workspaceId));
  printResult({ id: workspaceId, unlockedUntil: null }, output);
}

/** Joins a workspace by its password, as a viewer, and unlocks it for this profile. */
export async function joinWorkspace(
  profileName: string | undefined,
  workspaceId: string,
  password: string,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const session = await resolveSession(profileName, deps);
  const result = await session.client.execute(workspaceLocks.joinWorkspace(workspaceId, password));
  printResult({ id: workspaceId, joined: true, unlockedUntil: result.unlockedUntil }, output);
}
