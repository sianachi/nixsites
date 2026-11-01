import type { Command } from 'commander';
import { seed, stressRun } from './stress.ts';
import type { SeedCliOptions, RunCliOptions } from './program-support.ts';
import { type Act } from './shared.ts';

export function registerStressCommands(program: Command, act: Act): void {
  const stress = program.command('stress').description('Seed and exercise a workspace at scale.');

  stress
    .command('seed')
    .description('Create many children under a container, for the scale the stress rows name.')
    .requiredOption('--workspace <id>', 'the workspace to seed within')
    .requiredOption('--count <n>', 'how many children to create', (value) =>
      Number.parseInt(value, 10),
    )
    .option('--parent <id>', 'the container to seed under (default: create a new one)')
    .option('--title-prefix <p>', 'the prefix each child title carries', 'Item')
    .option('--type <type>', 'the body kind of each child', 'note')
    .option(
      '--prop <key=value...>',
      "a property each child carries; '#n' is the child's index and '#n%<k>' its index modulo k, " +
        'so a seed produces a spread rather than one repeated value',
    )
    .action((options: SeedCliOptions, command: Command) =>
      act(command, (profile, output) =>
        seed(
          profile,
          {
            workspaceId: options.workspace,
            count: options.count,
            parentId: options.parent,
            titlePrefix: options.titlePrefix,
            type: options.type,
            properties: options.prop,
          },
          output,
        ),
      ),
    );

  stress
    .command('run')
    .description('Run a stress scenario and print a machine-readable report.')
    .requiredOption(
      '--scenario <name>',
      'the scenario to run (read-storm, list-storm, chart-storm, search-storm, query-storm, ' +
        'collab-edit)',
    )
    .option('--iterations <n>', 'the storms: how many reads to make', (value) =>
      Number.parseInt(value, 10),
    )
    .option('--create', 'collab-edit: create a fresh note in --workspace to edit', false)
    .option('--clients <n>', 'collab-edit: concurrent Yjs clients', (value) =>
      Number.parseInt(value, 10),
    )
    .option('--edits <n>', 'collab-edit: marker edits per client', (value) =>
      Number.parseInt(value, 10),
    )
    .option('--interval-ms <n>', "collab-edit: pause between a client's edits", (value) =>
      Number(value),
    )
    .option(
      '--item <id>',
      'read-storm/list-storm/chart-storm/query-storm: the item to read (a container for all but ' +
        'read-storm); collab-edit: the note to edit (or --create with --workspace)',
    )
    .option('--workspace <id>', 'list-storm: the workspace the container lives in')
    .option('--page-size <n>', 'list-storm: how many children to ask for per page', (value) =>
      Number.parseInt(value, 10),
    )
    .option('--query <text>', 'search-storm: the query to run each iteration')
    .option('--limit <n>', 'search-storm: cap the hits per query', (value) =>
      Number.parseInt(value, 10),
    )
    .option('--view <viewId>', "query-storm/chart-storm: which of the container's views to run")
    .option('--today <yyyy-mm-dd>', "query-storm: the caller's own day, for relative rules")
    .action((options: RunCliOptions, command: Command) =>
      act(command, (profile, output) =>
        stressRun(
          profile,
          {
            scenario: options.scenario,
            iterations: options.iterations,
            collab: {
              docId: options.item,
              create: options.create === true,
              clients: options.clients ?? 2,
              edits: options.edits ?? 50,
              intervalMs: options.intervalMs ?? 20,
            },
            itemId: options.item,
            workspaceId: options.workspace,
            pageSize: options.pageSize,
            query: options.query,
            limit: options.limit,
            viewId: options.view,
            today: options.today,
          },
          output,
        ),
      ),
    );
}
