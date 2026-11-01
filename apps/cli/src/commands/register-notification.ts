import type { Command } from 'commander';
import {
  getPreferences,
  listNotifications,
  readAllNotifications,
  readNotification,
  setPreferences,
  type PreferenceFlags,
} from './notifications.ts';
import { collectOption } from './program-support.ts';
import { type Act } from './shared.ts';

export function registerNotificationCommands(program: Command, act: Act): void {
  const inbox = program
    .command('notifications')
    .description('Your own notifications inbox and reminder preferences.');

  inbox
    .command('list')
    .description('List one page of your notifications, newest first.')
    .option('--unread', 'only unread notifications', false)
    .option('--cursor <cursor>', 'opaque cursor returned by the previous page')
    .action((options: { unread: boolean; cursor?: string }, command: Command) =>
      act(command, (profile, output) => listNotifications(profile, options, output)),
    );

  inbox
    .command('read <notificationId>')
    .description('Mark one notification read.')
    .action((notificationId: string, _options: unknown, command: Command) =>
      act(command, (profile, output) => readNotification(profile, notificationId, output)),
    );

  inbox
    .command('read-all')
    .description('Mark every notification read.')
    .action((_options: unknown, command: Command) =>
      act(command, (profile, output) => readAllNotifications(profile, output)),
    );

  const prefs = inbox
    .command('prefs')
    .description('Your time zone, quiet hours, reminder switches and muted containers.');

  prefs
    .command('get')
    .description('Print your preferences.')
    .action((_options: unknown, command: Command) =>
      act(command, (profile, output) => getPreferences(profile, output)),
    );

  prefs
    .command('set')
    .description('Change only the preferences given; the rest stay as they are.')
    .option('--time-zone <iana>', 'IANA time zone, for example Europe/London')
    .option('--quiet <HH:mm-HH:mm|off>', 'quiet hours that defer reminders, or off')
    .option('--due-time <HH:mm>', 'when due-task reminders fire on the due day')
    .option('--due-reminders <on|off>', 'reminders for due tasks')
    .option('--habit-reminders <on|off>', 'reminders for habit check-ins')
    .option(
      '--mute <containerId>',
      'mute reminders under a container (repeatable)',
      collectOption,
      [],
    )
    .option('--unmute <containerId>', 'unmute a container (repeatable)', collectOption, [])
    .action((options: PreferenceFlags, command: Command) =>
      act(command, (profile, output) => setPreferences(profile, options, output)),
    );
}
