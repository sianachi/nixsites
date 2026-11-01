import type { Command } from 'commander';
import {
  createAutomation,
  deleteAutomation,
  getAutomation,
  listAutomationRuns,
  listAutomations,
  runAutomation,
  setAutomationEnabled,
  testAutomation,
  updateAutomation,
  type CreateAutomationOptions,
  type UpdateAutomationOptions,
} from './automations.ts';
import { ruleFlags } from './program-support.ts';
import type { WorkspaceOption, ConfirmCliOptions } from './program-support.ts';
import { type Act } from './shared.ts';

export function registerAutomationCommands(program: Command, act: Act): void {
  const auto = program
    .command('automations')
    .description(
      'Your own automation rules. Writes need a personal access token with the admin scope.',
    );

  auto
    .command('list')
    .description('List your rules in a workspace.')
    .requiredOption('--workspace <id>', 'the workspace to read')
    .action((options: WorkspaceOption, command: Command) =>
      act(command, (profile, output) => listAutomations(profile, options.workspace, output)),
    );

  auto
    .command('get <ruleId>')
    .description('Print one rule; the output can be edited and passed back to update --file.')
    .action((ruleId: string, _options: unknown, command: Command) =>
      act(command, (profile, output) => getAutomation(profile, ruleId, output)),
    );

  ruleFlags(
    auto
      .command('create')
      .description('Create a rule from flags or a JSON file.')
      .requiredOption('--workspace <id>', 'the workspace the rule belongs to')
      .option('--disabled', 'create it switched off'),
  ).action((options: CreateAutomationOptions, command: Command) =>
    act(command, (profile, output) => createAutomation(profile, options, output)),
  );

  ruleFlags(
    auto
      .command('update <ruleId>')
      .description('Change a rule: flags replace the parts they name; --file replaces its members.')
      .option('--revision <n>', 'save only if the rule is still at this revision'),
  ).action((ruleId: string, options: UpdateAutomationOptions, command: Command) =>
    act(command, (profile, output) => updateAutomation(profile, ruleId, options, output)),
  );

  for (const [name, enabled] of [
    ['enable', true],
    ['disable', false],
  ] as const) {
    auto
      .command(`${name} <ruleId>`)
      .description(
        enabled
          ? 'Switch a rule on; this also clears an automatic disable after repeated failures.'
          : 'Switch a rule off and cancel its pending triggers.',
      )
      .action((ruleId: string, _options: unknown, command: Command) =>
        act(command, (profile, output) => setAutomationEnabled(profile, ruleId, enabled, output)),
      );
  }

  auto
    .command('delete <ruleId>')
    .description('Delete a rule and its run log.')
    .option('--yes', 'confirm this destructive operation', false)
    .action((ruleId: string, options: ConfirmCliOptions, command: Command) =>
      act(command, (profile, output) =>
        deleteAutomation(profile, ruleId, options.yes === true, output),
      ),
    );

  auto
    .command('runs <ruleId>')
    .description("One page of a rule's run log, newest first.")
    .option('--cursor <cursor>', 'opaque cursor returned by the previous page')
    .action((ruleId: string, options: { cursor?: string }, command: Command) =>
      act(command, (profile, output) => listAutomationRuns(profile, ruleId, options, output)),
    );

  auto
    .command('run <ruleId>')
    .description('Run a rule now, as you; the result is the recorded run.')
    .option('--item <itemId>', 'the triggering item, for rules that act on one')
    .action((ruleId: string, options: { item?: string }, command: Command) =>
      act(command, (profile, output) => runAutomation(profile, ruleId, options, output)),
    );

  auto
    .command('test <ruleId>')
    .description('Dry-run a rule: whether it would run now and what its actions would do.')
    .option('--item <itemId>', 'the triggering item, for rules that act on one')
    .action((ruleId: string, options: { item?: string }, command: Command) =>
      act(command, (profile, output) => testAutomation(profile, ruleId, options, output)),
    );
}
