import type { Command } from 'commander';
import {
  changeWorkspaceMemberRole,
  acceptWorkspaceInvitation,
  archiveWorkspace,
  createWorkspace,
  declineWorkspaceInvitation,
  inviteWorkspaceMember,
  leaveWorkspace,
  listWorkspaceInvitations,
  listWorkspaceInvitees,
  listWorkspaceMembers,
  listWorkspaceAssignablePrincipals,
  listWorkspaces,
  readWorkspaceGraph,
  dailyNoteSettings,
  openDailyNote,
  purgeWorkspace,
  removeWorkspaceMember,
  renameWorkspace,
  setWorkspaceSharing,
  restoreWorkspace,
  revokeWorkspaceInvitation,
} from './workspaces.ts';
import { getOperation } from './operations.ts';
import { parseInteger } from './program-support.ts';
import type { PageCliOptions, ConfirmCliOptions } from './program-support.ts';
import { type Act } from './shared.ts';

export function registerWorkspaceCommands(program: Command, act: Act): void {
  const ws = program.command('ws').description('The workspaces a token can reach.');

  program
    .command('operation')
    .description('Inspect a durable operation visible to the current profile.')
    .command('get <operationId>')
    .description('Read the current state of an authorized operation.')
    .action((operationId: string, _options: unknown, command: Command) =>
      act(command, (profile, output) => getOperation(profile, operationId, output)),
    );

  ws.command('list')
    .description('List one page of workspaces the profile can reach.')
    .option('--limit <count>', 'maximum rows in this page', parseInteger, 50)
    .option('--cursor <cursor>', 'opaque cursor returned by the previous page')
    .action((options: PageCliOptions, command: Command) =>
      act(command, (profile, output) => listWorkspaces(profile, options, output)),
    );

  ws.command('graph <workspaceId>')
    .description('Read the workspace graph, including its item and link limits.')
    .action((workspaceId: string, _options: unknown, command: Command) =>
      act(command, (profile, output) => readWorkspaceGraph(profile, workspaceId, output)),
    );

  ws.command('daily-settings <workspaceId>')
    .description('Read daily-note settings, or save all settings from a JSON file.')
    .option('--file <path>', 'JSON settings file to save')
    .action((workspaceId: string, options: { file?: string }, command: Command) =>
      act(command, (profile, output) =>
        dailyNoteSettings(profile, workspaceId, options.file, output),
      ),
    );
  ws.command('daily <workspaceId> <date>')
    .description('Open or create the workspace daily note for yyyy-MM-dd.')
    .action((workspaceId: string, date: string, _options: unknown, command: Command) =>
      act(command, (profile, output) => openDailyNote(profile, workspaceId, date, output)),
    );

  ws.command('create <name>')
    .description('Create a shared workspace.')
    .action((name: string, _options: unknown, command: Command) =>
      act(command, (profile, output) => createWorkspace(profile, name, output)),
    );
  ws.command('rename <workspaceId> <name>')
    .description('Rename a workspace.')
    .action((workspaceId: string, name: string, _options: unknown, command: Command) =>
      act(command, (profile, output) => renameWorkspace(profile, workspaceId, name, output)),
    );
  ws.command('sharing <workspaceId>')
    .description('Close or open a workspace to new members, and turn live collaboration on or off.')
    .option('--members <on|off>', 'whether new members may be invited and accept')
    .option('--collaboration <on|off>', 'whether several people may edit a file at once')
    .action(
      (
        workspaceId: string,
        options: { members?: string; collaboration?: string },
        command: Command,
      ) =>
        act(command, (profile, output) =>
          setWorkspaceSharing(profile, workspaceId, options, output),
        ),
    );
  ws.command('archive <workspaceId>')
    .description('Archive a workspace so it is out of everyday navigation.')
    .option('--yes', 'confirm this destructive operation', false)
    .action((workspaceId: string, options: ConfirmCliOptions, command: Command) =>
      act(command, (profile, output) =>
        archiveWorkspace(profile, workspaceId, options.yes === true, output),
      ),
    );
  ws.command('restore <workspaceId>')
    .description('Restore an archived workspace.')
    .action((workspaceId: string, _options: unknown, command: Command) =>
      act(command, (profile, output) => restoreWorkspace(profile, workspaceId, output)),
    );
  ws.command('purge <workspaceId>')
    .description('Permanently delete an archived workspace and its stored files.')
    .option('--yes', 'confirm this irreversible operation', false)
    .action((workspaceId: string, options: ConfirmCliOptions, command: Command) =>
      act(command, (profile, output) =>
        purgeWorkspace(profile, workspaceId, options.yes === true, output),
      ),
    );
  ws.command('invitations <workspaceId>')
    .description('List invitation history.')
    .option('--limit <count>', 'maximum rows in this page', parseInteger, 50)
    .option('--cursor <cursor>', 'opaque cursor returned by the previous page')
    .action((workspaceId: string, options: PageCliOptions, command: Command) =>
      act(command, (profile, output) =>
        listWorkspaceInvitations(profile, workspaceId, options, output),
      ),
    );
  ws.command('invitees <workspaceId>')
    .description('List active users and their workspace invitation eligibility.')
    .option('--query <text>', 'search people by name or email')
    .option('--limit <count>', 'maximum rows in this page', parseInteger, 50)
    .option('--cursor <cursor>', 'opaque cursor returned by the previous page')
    .action((workspaceId: string, options: PageCliOptions & { query?: string }, command: Command) =>
      act(command, (profile, output) =>
        listWorkspaceInvitees(profile, workspaceId, options, output),
      ),
    );
  ws.command('invite <workspaceId> <principalId>')
    .requiredOption('--role <role>', 'owner, editor, or viewer')
    .description('Invite a collaborator.')
    .action(
      (workspaceId: string, principalId: string, options: { role: string }, command: Command) =>
        act(command, (profile, output) =>
          inviteWorkspaceMember(profile, workspaceId, principalId, options.role, output),
        ),
    );
  ws.command('accept-invite <workspaceId> <invitationId>')
    .description('Accept an invitation addressed to the current principal.')
    .action((workspaceId: string, invitationId: string, _options: unknown, command: Command) =>
      act(command, (profile, output) =>
        acceptWorkspaceInvitation(profile, workspaceId, invitationId, output),
      ),
    );
  ws.command('decline-invite <workspaceId> <invitationId>')
    .description('Decline an invitation and remove provisional access.')
    .option('--yes', 'confirm this destructive operation', false)
    .action(
      (workspaceId: string, invitationId: string, options: ConfirmCliOptions, command: Command) =>
        act(command, (profile, output) =>
          declineWorkspaceInvitation(
            profile,
            workspaceId,
            invitationId,
            options.yes === true,
            output,
          ),
        ),
    );
  ws.command('revoke-invite <workspaceId> <invitationId>')
    .description('Revoke a pending invitation.')
    .option('--yes', 'confirm this destructive operation', false)
    .action(
      (workspaceId: string, invitationId: string, options: ConfirmCliOptions, command: Command) =>
        act(command, (profile, output) =>
          revokeWorkspaceInvitation(
            profile,
            workspaceId,
            invitationId,
            options.yes === true,
            output,
          ),
        ),
    );
  ws.command('members <workspaceId>')
    .description('List principal and group workspace grants.')
    .option('--limit <count>', 'maximum rows in this page', parseInteger, 50)
    .option('--cursor <cursor>', 'opaque cursor returned by the previous page')
    .action((workspaceId: string, options: PageCliOptions, command: Command) =>
      act(command, (profile, output) =>
        listWorkspaceMembers(profile, workspaceId, options, output),
      ),
    );
  ws.command('principals <workspaceId>')
    .description('List active direct and group-derived principals available for assignment.')
    .option('--query <text>', 'filter display names by text')
    .option('--limit <count>', 'maximum rows in this page', parseInteger, 50)
    .option('--cursor <cursor>', 'opaque cursor returned by the previous page')
    .action((workspaceId: string, options: PageCliOptions & { query?: string }, command: Command) =>
      act(command, (profile, output) =>
        listWorkspaceAssignablePrincipals(profile, workspaceId, options, output),
      ),
    );
  ws.command('role <workspaceId> <principalId>')
    .requiredOption('--role <role>', 'owner, editor, or viewer')
    .description('Change a member role.')
    .action(
      (workspaceId: string, principalId: string, options: { role: string }, command: Command) =>
        act(command, (profile, output) =>
          changeWorkspaceMemberRole(profile, workspaceId, principalId, options.role, output),
        ),
    );
  ws.command('remove <workspaceId> <principalId>')
    .description('Remove a workspace member.')
    .option('--yes', 'confirm this destructive operation', false)
    .action(
      (workspaceId: string, principalId: string, options: ConfirmCliOptions, command: Command) =>
        act(command, (profile, output) =>
          removeWorkspaceMember(profile, workspaceId, principalId, options.yes === true, output),
        ),
    );
  ws.command('leave <workspaceId>')
    .description('Leave a workspace.')
    .option('--yes', 'confirm this destructive operation', false)
    .action((workspaceId: string, options: ConfirmCliOptions, command: Command) =>
      act(command, (profile, output) =>
        leaveWorkspace(profile, workspaceId, options.yes === true, output),
      ),
    );
}
