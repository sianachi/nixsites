import type { Command } from 'commander';
import { checkIn, readHabit, setHabit, setHabitStatus, undoCheckIn } from './habits.ts';
import { type Act } from './shared.ts';

export function registerHabitCommands(program: Command, act: Act): void {
  const habit = program.command('habit').description('Configure and record a habit tracker.');

  habit
    .command('set <habitId>')
    .description('Set a habit schedule and target.')
    .requiredOption('--frequency <frequency>', 'daily or weekly')
    .option('--weekdays <days>', 'weekly days as numbers 0 (Sunday) through 6 (Saturday)')
    .requiredOption('--timezone <iana>', 'IANA timezone, for example Europe/London')
    .requiredOption('--start-date <yyyy-mm-dd>', 'first scheduled day')
    .requiredOption('--target <number>', 'target quantity per scheduled day')
    .requiredOption('--unit <unit>', 'unit label, for example minutes or glasses')
    .action(
      (
        habitId: string,
        options: {
          frequency: string;
          weekdays?: string;
          timezone: string;
          startDate: string;
          target: string;
          unit: string;
        },
        command: Command,
      ) => act(command, (profile, output) => setHabit(profile, habitId, options, output)),
    );

  habit
    .command('status <habitId> <status>')
    .description('Set active, paused, or archived; recorded history is retained.')
    .action((habitId: string, status: string, _options: unknown, command: Command) =>
      act(command, (profile, output) => setHabitStatus(profile, habitId, status, output)),
    );

  habit
    .command('get <habitId>')
    .description('Read habit settings, check-ins, and weekly progress for a date window.')
    .requiredOption('--from <yyyy-mm-dd>', 'first day to include')
    .requiredOption('--to <yyyy-mm-dd>', 'last day to include')
    .action((habitId: string, options: { from: string; to: string }, command: Command) =>
      act(command, (profile, output) => readHabit(profile, habitId, options, output)),
    );

  habit
    .command('check-in <habitId>')
    .description('Record or update one scheduled day.')
    .requiredOption('--on <yyyy-mm-dd>', 'scheduled day')
    .option('--quantity <number>', 'quantity completed on that day')
    .option('--completed', 'mark the day complete', true)
    .action(
      (
        habitId: string,
        options: { on: string; quantity?: string; completed: boolean },
        command: Command,
      ) => act(command, (profile, output) => checkIn(profile, habitId, options, output)),
    );

  habit
    .command('undo <habitId>')
    .description('Remove the check-in for one scheduled day.')
    .requiredOption('--on <yyyy-mm-dd>', 'scheduled day')
    .action((habitId: string, options: { on: string }, command: Command) =>
      act(command, (profile, output) => undoCheckIn(profile, habitId, options.on, output)),
    );
}
