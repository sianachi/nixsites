/**
 * The workspace-password resource: the only place those URLs appear.
 *
 * A workspace password closes the workspace to its own members until they present it, and lets a
 * signed-in person in the same tenant join with the workspace's join link. Core enforces both;
 * these are the commands. An unlock belongs to the calling browser session or access token.
 */

import { defineCommand, type CommandEndpoint } from '../endpoints.js';
import {
  noContentSchema,
  workspaceUnlockResultSchema,
  type WorkspaceUnlockResult,
} from '../schemas/index.js';

const workspaceKeys = (workspaceId: string) =>
  [['workspaces'], ['workspaces', workspaceId], ['items'], ['search']] as const;

/** Sets the workspace password, or changes it (which needs `currentPassword`). Owners only. */
export const setWorkspacePassword = (
  workspaceId: string,
  password: string,
  currentPassword?: string,
): CommandEndpoint<undefined> =>
  defineCommand<undefined>({
    operation: 'workspaceLocks.set',
    method: 'PUT',
    path: `/api/v1/workspaces/${workspaceId}/password`,
    body: currentPassword === undefined ? { password } : { password, currentPassword },
    schema: noContentSchema,
    invalidates: [...workspaceKeys(workspaceId)],
  });

/** Removes the workspace password. Owners only; needs the password. */
export const removeWorkspacePassword = (
  workspaceId: string,
  password: string,
): CommandEndpoint<undefined> =>
  defineCommand<undefined>({
    operation: 'workspaceLocks.remove',
    method: 'POST',
    path: `/api/v1/workspaces/${workspaceId}/password/remove`,
    body: { password },
    schema: noContentSchema,
    invalidates: [...workspaceKeys(workspaceId)],
  });

/** Opens a password-protected workspace to this session for a while. Members only. */
export const unlockWorkspace = (
  workspaceId: string,
  password: string,
): CommandEndpoint<WorkspaceUnlockResult> =>
  defineCommand<WorkspaceUnlockResult>({
    operation: 'workspaceLocks.unlock',
    method: 'POST',
    path: `/api/v1/workspaces/${workspaceId}/unlock`,
    body: { password },
    schema: workspaceUnlockResultSchema,
    invalidates: [...workspaceKeys(workspaceId)],
  });

/** Closes a password-protected workspace to this session again. */
export const relockWorkspace = (workspaceId: string): CommandEndpoint<undefined> =>
  defineCommand<undefined>({
    operation: 'workspaceLocks.relock',
    method: 'DELETE',
    path: `/api/v1/workspaces/${workspaceId}/unlock`,
    schema: noContentSchema,
    invalidates: [...workspaceKeys(workspaceId)],
  });

/** Joins a workspace with its password, as a viewer, and unlocks it for this session. */
export const joinWorkspace = (
  workspaceId: string,
  password: string,
): CommandEndpoint<WorkspaceUnlockResult> =>
  defineCommand<WorkspaceUnlockResult>({
    operation: 'workspaceLocks.join',
    method: 'POST',
    path: `/api/v1/workspaces/${workspaceId}/join`,
    body: { password },
    schema: workspaceUnlockResultSchema,
    invalidates: [...workspaceKeys(workspaceId)],
  });
