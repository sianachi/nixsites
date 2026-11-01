import type { Command } from 'commander';
import { InvalidArgumentError } from 'commander';
import { login, logout, status } from './auth.ts';
import { petEval } from './pet-eval.ts';
import { petEvalChat } from './pet-eval-chat.ts';
import { petCommand, petToolRun, type PetOptions, type PetToolRunOptions } from './pets.ts';
import type { LoginOptions } from './program-support.ts';
import { type Act } from './shared.ts';

export function registerAccountCommands(program: Command, act: Act): void {
  const auth = program.command('auth').description('Sign in, check who you are, and sign out.');
  const pet = program
    .command('pet <operation>')
    .description(
      'Inspect or drive companions. Sign in with nixctl auth login for runtime calls; PAT permissions are not expanded.',
    )
    .option('--api-url <url>', 'Core origin when supplying an interactive bearer token')
    .option('--workspace <id>', 'workspace identity')
    .option('--pet <id>', 'saved pet identity')
    .option('--root-item <id>', 'limit the conversation to this note and its readable children')
    .option('--allow-edits', 'allow approval-gated edits within --root-item', false)
    .option(
      '--history-id <id>',
      'archived conversation identity for read_history, delete_history or resume_history; with rename, renames that archive instead of the live conversation',
    )
    .option('--title <text>', 'the new conversation title for rename')
    .option('--message <text>', 'message to send')
    .option('--model <id>', 'model from pet models')
    .option(
      '--workspace-tools',
      'offer workspace tools; approve requests in the Nix companion panel',
      false,
    )
    .option('--tool-id <id>', 'the pending tool call to claim or resolve')
    .option('--request-id <id>', 'the claim request identity, shared by tool_claim and tool_result')
    .option('--tool-result <text>', 'the outcome text to post with tool_result')
    .option('--tool-success', 'mark the posted tool_result a success')
    .option(
      '--after <revision>',
      'with --operation watch: the last known revision to wait past',
      (value: string) => {
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed < 0) {
          throw new InvalidArgumentError('--after must be a non-negative integer.');
        }

        return parsed;
      },
      0,
    )
    .action((operation: string, options: PetOptions, command: Command) =>
      act(command, (profile, output) => petCommand(profile, operation, options, output)),
    );

  // `--workspace`, `--pet` and `--api-url` are already declared on `pet` above and are read
  // back here through `optsWithGlobals()`: declaring them again on this nested command would
  // let `pet` consume them from anywhere in the argument list before this subcommand's own
  // parser ever sees them, so a redeclared `requiredOption` here would fail even when the
  // flag was given (commander extracts a command's own options wherever they appear in argv,
  // ahead of dispatching to subcommands).
  pet
    .command('tools')
    .description('Preview and resolve a companion’s pending workspace tool calls.')
    .command('run <toolId>')
    .description(
      'Preview a pending tool call; with --approve, claim and run it exactly as the web companion panel does, then post its outcome.',
    )
    .option('--approve', 'claim, run and post the outcome', false)
    .option('--decline', 'claim and post a declined outcome without running it', false)
    .action((toolId: string, _options: unknown, command: Command) => {
      const options: PetToolRunOptions = command.optsWithGlobals();
      return act(command, (profile, output) => petToolRun(profile, toolId, options, output));
    });

  pet
    .command('eval')
    .description('Run a scripted companion evaluation against the connected provider.')
    .requiredOption('--suite <name>', 'evaluation suite: design or chat')
    .option('--scenario <id>', 'design: run one scenario')
    .option('--case <id>', 'chat: run one case, or a group by prefix such as context-*')
    .option('--runs <count>', 'chat: repeat the suite this many times', '1')
    .option(
      '--allow-writes',
      'chat: run writes the "apply without asking" policy allows, inside the fixture only',
      false,
    )
    .option('--keep', 'chat: leave each fixture in place afterwards', false)
    .option('--baseline <file>', 'chat: fail only on a regression against this baseline')
    .option('--write-baseline <file>', "chat: record this run's pass counts as a baseline")
    .action((_options: unknown, command: Command) => {
      const options: {
        suite: string;
        scenario?: string;
        case?: string;
        runs: string;
        allowWrites: boolean;
        keep: boolean;
        baseline?: string;
        writeBaseline?: string;
        model?: string;
        apiUrl?: string;
        workspace?: string;
        pet?: string;
      } = command.optsWithGlobals();
      return act(command, (profile, output) => {
        if (options.suite === 'chat') {
          const runs = Number(options.runs);
          if (!Number.isInteger(runs) || runs < 1 || runs > 10)
            throw new Error('--runs must be a whole number from 1 to 10.');
          return petEvalChat(profile, { ...options, suite: 'chat', runs }, output);
        }
        if (options.suite !== 'design') throw new Error('Choose --suite design or --suite chat.');
        return petEval(profile, { ...options, suite: 'design' }, output);
      });
    });

  auth
    .command('login')
    .description('Approve a renewable CLI session in your browser, or store an explicit PAT.')
    .requiredOption('--api-url <url>', "Core's base URL, e.g. http://localhost:5014")
    .option('--token <token>', 'use a personal access token instead of browser login, nixpat_...')
    .option('--browser-url <url>', 'trusted Nix web origin when it differs from Core')
    .option('--no-browser', 'print the approval URL without opening a browser')
    .option('--collab-url <url>', 'the collaboration service URL (defaults from the API URL)')
    .option('--media-url <url>', 'legacy media URL retained in the profile for compatibility')
    .option('--no-default', 'store the profile without making it the default')
    .action((options: LoginOptions, command: Command) =>
      act(command, (profile, output) =>
        login(
          {
            apiUrl: options.apiUrl,
            token: options.token,
            browserUrl: options.browserUrl,
            browser: options.browser,
            profileName: profile ?? 'default',
            collabUrl: options.collabUrl,
            mediaUrl: options.mediaUrl,
            makeDefault: options.default !== false,
          },
          output,
        ),
      ),
    );

  auth
    .command('status')
    .description('Show who the current profile acts as.')
    .action((_options: unknown, command: Command) =>
      act(command, (profile, output) => status(profile, output)),
    );

  auth
    .command('logout')
    .description('Revoke a browser-approved CLI session and remove its local profile.')
    .action((_options: unknown, command: Command) =>
      act(command, (profile, output) => logout(profile, output)),
    );
}
