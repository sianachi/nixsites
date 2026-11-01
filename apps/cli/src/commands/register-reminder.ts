import type { Command } from 'commander';
import { clearReminder, setReminder } from './reminders.ts';
import { type Act } from './shared.ts';

export function registerReminderCommands(program: Command, act: Act): void {
  const remind = program
    .command('remind')
    .description("An item's reminder: one notification to you at a chosen time.");

  remind
    .command('set <itemId> <when>')
    .description(
      'Set the reminder. <when> is a local time (2026-10-01T09:00), an instant ' +
        '(2026-10-01T08:00:00Z), a zoned time (...+01:00[Europe/London]) or relative (+90m, +2h, +1d).',
    )
    .option('--zone <iana>', 'the zone a local time is read in (default: your preference)')
    .action((itemId: string, when: string, options: { zone?: string }, command: Command) =>
      act(command, (profile, output) => setReminder(profile, itemId, when, options, output)),
    );

  remind
    .command('clear <itemId>')
    .description("Remove the item's reminder.")
    .action((itemId: string, _options: unknown, command: Command) =>
      act(command, (profile, output) => clearReminder(profile, itemId, output)),
    );
}
