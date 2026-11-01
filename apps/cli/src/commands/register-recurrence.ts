import type { Command } from 'commander';
import { setProps } from './structure.ts';
import { clearRecurrence, completeRecurrence, runCalendar, setRecurrence } from './recurrence.ts';
import { type Act } from './shared.ts';

export function registerRecurrenceCommands(program: Command, act: Act): void {
  const props = program.command('props').description("An item's property values.");

  props
    .command('set <itemId> [pairs...]')
    .description('Merge key=value property values onto an item (a null value clears a key).')
    .action((itemId: string, pairs: string[], _options: unknown, command: Command) =>
      act(command, (profile, output) => setProps(profile, itemId, pairs, output)),
    );

  const recur = program.command('recur').description("An item's recurrence rule.");

  recur
    .command('set <itemId>')
    .description("Replace an item's recurrence rule wholesale.")
    .requiredOption('--freq <freq>', 'daily | weekly | monthly | yearly')
    .option('--interval <n>', 'repeat every n units of freq (1-366, default 1)')
    .option('--weekdays <days>', 'comma-separated mo,tu,we,th,fr,sa,su - weekly rules only')
    .option('--until <yyyy-mm-dd>', 'the last day the item is due, inclusive (default: no end)')
    .action(
      (
        itemId: string,
        options: { freq: string; interval?: string; weekdays?: string; until?: string },
        command: Command,
      ) =>
        act(command, (profile, output) =>
          setRecurrence(
            profile,
            itemId,
            {
              freq: options.freq,
              interval: options.interval,
              weekdays: options.weekdays,
              until: options.until,
            },
            output,
          ),
        ),
    );

  recur
    .command('clear <itemId>')
    .description("Remove an item's recurrence rule; it stops repeating.")
    .action((itemId: string, _options: unknown, command: Command) =>
      act(command, (profile, output) => clearRecurrence(profile, itemId, output)),
    );

  recur
    .command('complete <itemId>')
    .description('Mark one occurrence of a recurring item complete.')
    .requiredOption('--on <yyyy-mm-dd>', 'the day of the occurrence to complete')
    .action((itemId: string, options: { on: string }, command: Command) =>
      act(command, (profile, output) =>
        completeRecurrence(profile, itemId, { on: options.on }, output),
      ),
    );

  program
    .command('calendar')
    .description("Print one window of a workspace's collated calendar, generated entries included.")
    .requiredOption('--workspace <id>', 'the workspace to read')
    .requiredOption('--from <yyyy-mm-dd>', 'the first day to include, inclusive')
    .requiredOption('--to <yyyy-mm-dd>', 'the last day to include, inclusive')
    .action((options: { workspace: string; from: string; to: string }, command: Command) =>
      act(command, (profile, output) =>
        runCalendar(
          profile,
          { workspaceId: options.workspace, from: options.from, to: options.to },
          output,
        ),
      ),
    );
}
