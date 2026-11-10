#!/usr/bin/env -S node --experimental-strip-types
/**
 * `nixctl`: the scriptable way into a Nix workspace.
 *
 * **The output is machine-readable by default and the process leaves with a code a script can
 * branch on**, which is what makes this the surface an agent or a shell loop drives rather than a
 * person clicking. Every command routes its result through `printResult` and its failure through
 * `printError`, so the two streams stay apart and the exit code is never an afterthought.
 *
 * Commands are thin: parse the flags, open a session, call the use case, print the result. The work
 * lives in `commands/` and in the packages this shares with the web application, so a behaviour is
 * defined once and reached two ways.
 */

import { Command } from 'commander';
import { registerConversationCommands } from './commands/conversations.ts';
import { readHealth } from './commands/health.ts';
import { outputOptions, printError, ExitCode, type OutputOptions } from './output.ts';
import { runWorkspaceMcpServer } from './mcp.ts';

import { registerAccountCommands } from './commands/register-account.ts';
import { registerWorkspaceCommands } from './commands/register-workspace.ts';
import { registerTemplateCommands } from './commands/register-template.ts';
import { registerNoteCommands } from './commands/register-note.ts';
import { registerStructureCommands } from './commands/register-structure.ts';
import { registerApiCommands } from './commands/register-api.ts';
import { registerRecurrenceCommands } from './commands/register-recurrence.ts';
import { registerHabitCommands } from './commands/register-habit.ts';
import { registerNotificationCommands } from './commands/register-notification.ts';
import { registerCalendarSyncCommands } from './commands/register-calendar-sync.ts';
import { registerReminderCommands } from './commands/register-reminder.ts';
import { registerAutomationCommands } from './commands/register-automation.ts';
import { registerSearchTransferCommands } from './commands/register-search-transfer.ts';
import { registerFileCommands } from './commands/register-file.ts';
import { registerStressCommands } from './commands/register-stress.ts';
import { registerItemCommands } from './commands/register-item.ts';
import { registerSiteCommands } from './commands/register-site.ts';
import { registerTenantCommands } from './commands/register-tenant.ts';
import { registerRecordCommands, registerRecordExtensions } from './commands/register-records.ts';
interface GlobalFlags {
  readonly profile: string | undefined;
  readonly json: boolean;
}

function globalFlags(command: Command): GlobalFlags {
  const opts = command.optsWithGlobals();
  return {
    profile: typeof opts.profile === 'string' ? opts.profile : undefined,
    json: opts.json === true,
  };
}

/**
 * Runs one command's body, turning anything thrown into a stderr line and an exit code.
 *
 * Kept in one place so no command forgets it: a throw that reached the top would print a stack
 * trace, which is neither the honest failure a person wants nor the parseable one a script does.
 */
async function run(body: () => Promise<void>): Promise<void> {
  try {
    await body();
  } catch (error) {
    process.exitCode = printError(error);
  }
}

/** {@link run} with the global profile and output shape read from the command. */
function act(
  command: Command,
  body: (profile: string | undefined, output: OutputOptions) => Promise<void>,
): Promise<void> {
  const flags = globalFlags(command);
  return run(() => body(flags.profile, outputOptions(flags.json)));
}

export function buildProgram(): Command {
  const program = new Command();

  program
    .name('nixctl')
    .description('Drive a Nix workspace from the terminal.')
    .option('--profile <name>', 'the stored profile to act as')
    .option('--json', 'force machine-readable output even on a terminal', false)
    .configureOutput({
      // Usage and option errors are diagnostics, so they belong on stderr with the results kept
      // clean on stdout.
      writeErr: (text) => process.stderr.write(text),
    });

  program
    .command('health')
    .description('Check public Core HTTP liveness and service identity without signing in.')
    .requiredOption('--api-url <url>', "Core's origin, e.g. http://localhost:5014")
    .action((options: { apiUrl: string }, command: Command) =>
      act(command, (profile, output) => readHealth(options.apiUrl, output)),
    );

  registerConversationCommands(program, act);

  registerAccountCommands(program, act);
  registerWorkspaceCommands(program, act);
  program
    .command('mcp')
    .description(
      'Serve Nix workspace tools over MCP: on stdio for this profile, or over HTTP with --listen, ' +
        'where every request carries its own personal access token.',
    )
    .option('--listen <host:port>', 'serve Streamable HTTP instead of stdio (or NIX_MCP_LISTEN)')
    .option('--api-url <url>', "Core's origin for HTTP mode (or NIX_API_URL)")
    .option('--collab-url <url>', 'the collaboration service for HTTP mode (or NIX_COLLAB_URL)')
    .action(
      async (
        options: { listen?: string; apiUrl?: string; collabUrl?: string },
        command: Command,
      ) => {
        const flags = globalFlags(command);
        const listen = options.listen ?? process.env.NIX_MCP_LISTEN;
        if (listen === undefined) {
          await run(() => runWorkspaceMcpServer(flags.profile));
          return;
        }
        const apiUrl = options.apiUrl ?? process.env.NIX_API_URL;
        if (apiUrl === undefined) {
          throw new Error('HTTP mode needs --api-url or NIX_API_URL.');
        }
        const collabUrl = options.collabUrl ?? process.env.NIX_COLLAB_URL;
        const { startMcpHttpServer } = await import('./mcp-http.ts');
        await run(async () => {
          await startMcpHttpServer({ listen, apiUrl, collabUrl });
          await new Promise<never>(() => undefined);
        });
      },
    );

  registerTemplateCommands(program, act);
  registerNoteCommands(program, act);
  registerStructureCommands(program, act);
  registerApiCommands(program, act);
  registerRecurrenceCommands(program, act);
  registerHabitCommands(program, act);
  registerNotificationCommands(program, act);
  registerCalendarSyncCommands(program, act);
  registerReminderCommands(program, act);
  registerAutomationCommands(program, act);
  registerSearchTransferCommands(program, act);
  registerFileCommands(program, act);
  registerStressCommands(program, act);
  registerItemCommands(program, act);
  registerSiteCommands(program, act);
  registerTenantCommands(program, act);
  registerRecordCommands(program, act);
  registerRecordExtensions(program, act);

  return program;
}

// Run only when invoked as the binary, not when imported by a test.
if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  buildProgram()
    .parseAsync(process.argv)
    .catch((error: unknown) => {
      process.exitCode = printError(error);
    });
}

export { ExitCode };
