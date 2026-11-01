import type { Command } from 'commander';
import {
  executeCreateLink,
  executeLinkLog,
  executeListCalendars,
  executeListConnections,
  executeListLinks,
  executeListWorkspaceLinks,
  executeSyncLink,
  executeUnlinkWorkspaceLink,
  executeUnlink,
  executeUpdateLink,
  parseCalendarSyncId,
  runCalendarSync,
} from './calendar-sync.ts';
import { type Act } from './shared.ts';

export function registerCalendarSyncCommands(program: Command, act: Act): void {
  const calsync = program
    .command('calsync')
    .description(
      'Calendars linked from Google and Outlook. Connect an account in the web settings first.',
    );

  calsync
    .command('connections')
    .description('The accounts connected for calendar sync.')
    .action((_options: unknown, command: Command) =>
      act(command, (profile, output) => runCalendarSync(profile, executeListConnections, output)),
    );

  calsync
    .command('calendars <connectionId>')
    .description("A connected account's calendars, read live from the provider.")
    .action((connectionId: string, _options: unknown, command: Command) =>
      act(command, (profile, output) => {
        parseCalendarSyncId(connectionId, 'The connection');
        return runCalendarSync(
          profile,
          (session) => executeListCalendars(session, connectionId),
          output,
        );
      }),
    );

  calsync
    .command('links')
    .description('The calendars linked into your workspaces.')
    .action((_options: unknown, command: Command) =>
      act(command, (profile, output) => runCalendarSync(profile, executeListLinks, output)),
    );

  calsync
    .command('link <connectionId> <externalCalendarId>')
    .description('Link a calendar into a new item at the root of a workspace.')
    .requiredOption('--workspace <id>', 'the workspace the item is created in')
    .requiredOption('--title <title>', 'the name of the item that holds the events')
    .option('--direction <two_way|import_only>', 'which way changes travel', 'two_way')
    .action(
      (
        connectionId: string,
        externalCalendarId: string,
        options: { workspace: string; title: string; direction: string },
        command: Command,
      ) =>
        act(command, (profile, output) => {
          parseCalendarSyncId(connectionId, 'The connection');
          parseCalendarSyncId(options.workspace, '--workspace');
          return runCalendarSync(
            profile,
            (session) => executeCreateLink(session, connectionId, externalCalendarId, options),
            output,
          );
        }),
    );

  calsync
    .command('set <linkId>')
    .description("Change a link's direction, or pause and resume it.")
    .option('--direction <two_way|import_only>', 'which way changes travel')
    .option('--status <active|paused>', 'whether the link syncs')
    .action((linkId: string, options: { direction?: string; status?: string }, command: Command) =>
      act(command, (profile, output) => {
        parseCalendarSyncId(linkId, 'The link');
        return runCalendarSync(
          profile,
          (session) => executeUpdateLink(session, linkId, options),
          output,
        );
      }),
    );

  calsync
    .command('unlink <linkId>')
    .description(
      'Unlink a calendar. Nothing is removed from the external calendar. The notes it created ' +
        'are kept as ordinary items or moved to the trash, as --items says.',
    )
    .requiredOption('--items <keep|trash>', 'what becomes of the notes the link created')
    .action((linkId: string, options: { items: string }, command: Command) =>
      act(command, (profile, output) => {
        parseCalendarSyncId(linkId, 'The link');
        return runCalendarSync(
          profile,
          (session) => executeUnlink(session, linkId, options.items),
          output,
        );
      }),
    );

  calsync
    .command('workspace-links')
    .description(
      'Every item in a workspace with a calendar linked into it, whoever linked it. For the ' +
        "workspace's owner and tenant administrators.",
    )
    .requiredOption('--workspace <id>', 'the workspace to read')
    .action((options: { workspace: string }, command: Command) =>
      act(command, (profile, output) => {
        parseCalendarSyncId(options.workspace, '--workspace');
        return runCalendarSync(
          profile,
          (session) => executeListWorkspaceLinks(session, options.workspace),
          output,
        );
      }),
    );

  calsync
    .command('workspace-unlink <containerItemId>')
    .description(
      'Unlink a calendar another member linked into a workspace you manage. Nothing is removed ' +
        'from the external calendar.',
    )
    .requiredOption('--workspace <id>', 'the workspace the item is in')
    .requiredOption('--items <keep|trash>', 'what becomes of the notes the link created')
    .action(
      (containerItemId: string, options: { workspace: string; items: string }, command: Command) =>
        act(command, (profile, output) => {
          parseCalendarSyncId(containerItemId, 'The item');
          parseCalendarSyncId(options.workspace, '--workspace');
          return runCalendarSync(
            profile,
            (session) =>
              executeUnlinkWorkspaceLink(
                session,
                options.workspace,
                containerItemId,
                options.items,
              ),
            output,
          );
        }),
    );

  calsync
    .command('sync <linkId>')
    .description('Ask for a sync round now.')
    .action((linkId: string, _options: unknown, command: Command) =>
      act(command, (profile, output) => {
        parseCalendarSyncId(linkId, 'The link');
        return runCalendarSync(profile, (session) => executeSyncLink(session, linkId), output);
      }),
    );

  calsync
    .command('log <linkId>')
    .description("The newest entries of a link's sync log.")
    .action((linkId: string, _options: unknown, command: Command) =>
      act(command, (profile, output) => {
        parseCalendarSyncId(linkId, 'The link');
        return runCalendarSync(profile, (session) => executeLinkLog(session, linkId), output);
      }),
    );
}
