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

import { Command, InvalidArgumentError } from 'commander';
import { registerConversationCommands } from './commands/conversations.ts';
import { readHealth } from './commands/health.ts';
import {
  createItem,
  deleteItem,
  getItem,
  listItems,
  moveItem,
  renameItem,
  restoreItem,
} from './commands/items.ts';
import {
  closeLock,
  lockStatus,
  openLock,
  readPasswords,
  removeLock,
  setLock,
} from './commands/locks.ts';
import { protect, type ProtectionOptions } from './commands/protection.ts';
import { readStdin } from './commands/shared.ts';
import { runSearch } from './commands/search.ts';
import { runExport } from './commands/export.ts';
import * as siteCommands from './commands/sites.ts';

import { registerSiteHostingCommands } from './commands/site-hostnames.ts';
import { runImport } from './commands/import.ts';
import {
  cancelDocumentImport,
  commitDocumentImport,
  getDocumentImport,
} from './commands/document-import.ts';
import { downloadFile, listFileVersions, probeFile, uploadFile } from './commands/files.ts';
import { seed, stressRun } from './commands/stress.ts';
import { outputOptions, printError, printResult, ExitCode, type OutputOptions } from './output.ts';
import { runWorkspaceMcpServer } from './mcp.ts';

import { registerAccountCommands } from './commands/register-account.ts';
import { registerWorkspaceCommands } from './commands/register-workspace.ts';
import { registerTemplateCommands } from './commands/register-template.ts';
import { registerNoteCommands } from './commands/register-note.ts';
import { registerStructureCommands } from './commands/register-structure.ts';
import { registerApiCommands } from './commands/register-api.ts';
import { registerRecurrenceCommands } from './commands/register-recurrence.ts';
import { registerFinanceCommands } from './commands/register-finance.ts';
import { registerHabitCommands } from './commands/register-habit.ts';
import { registerNotificationCommands } from './commands/register-notification.ts';
import { registerCalendarSyncCommands } from './commands/register-calendar-sync.ts';
import { registerReminderCommands } from './commands/register-reminder.ts';
import { registerAutomationCommands } from './commands/register-automation.ts';
import { collectOptional } from './commands/program-support.ts';
import type {
  LsOptions,
  CreateItemOptions,
  MvOptions,
  WorkspaceOption,
  ConfirmCliOptions,
  ImportCliOptions,
  SeedCliOptions,
  RunCliOptions,
} from './commands/program-support.ts';
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
  registerFinanceCommands(program, act);
  registerHabitCommands(program, act);
  registerNotificationCommands(program, act);
  registerCalendarSyncCommands(program, act);
  registerReminderCommands(program, act);
  registerAutomationCommands(program, act);
  program
    .command('search <query>')
    .description('Full-text search across the items you can see.')
    .option('--limit <n>', 'cap the number of hits', (value: string) => {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new InvalidArgumentError('--limit must be a positive integer.');
      }

      return parsed;
    })
    .addHelpText(
      'after',
      '\nExamples:\n  nixctl search "weekly review"\n  nixctl search "weekly review" --limit 10',
    )
    .action((query: string, options: { limit?: number }, command: Command) =>
      act(command, (profile, output) =>
        runSearch(profile, query, { limit: options.limit }, output),
      ),
    );

  program
    .command('export <itemId>')
    .description('Create a durable Core export and download its verified result.')
    .option('--format <format>', 'an active worker format (md aliases markdown)', 'nix')
    .option('--scope <scope>', 'item | subtree', 'item')
    .option('-o, --out <file>', 'write the export here instead of stdout')
    .addHelpText(
      'after',
      '\nExamples:\n  nixctl export <itemId> --format md --scope subtree -o notes.md\n  nixctl export <itemId> --format nix -o item.nix',
    )
    .action(
      (
        itemId: string,
        options: { format: string; scope: string; out?: string },
        command: Command,
      ) =>
        act(command, (profile, output) =>
          runExport(
            profile,
            itemId,
            { format: options.format, scope: options.scope, out: options.out },
            output,
          ),
        ),
    );

  program
    .command('import <path>')
    .description(
      'Import Markdown trees, PDF, DOCX, or UTF-8 TXT. Documents become editable notes and retain their originals.',
    )
    .requiredOption('--workspace <id>', 'the workspace to import into')
    .option('--parent <id>', 'the container to import under (default: workspace root)')
    .option('--dry-run', 'print the mapping report without creating anything', false)
    .option('--no-wait', 'return a resumable receipt after the preview is queued')
    .action((path: string, options: ImportCliOptions & { wait?: boolean }, command: Command) =>
      act(command, (profile, output) =>
        runImport(
          profile,
          {
            path,
            workspaceId: options.workspace,
            parentId: options.parent,
            dryRun: options.dryRun === true,
            noWait: options.wait === false,
          },
          output,
        ),
      ),
    );

  const documentImport = program
    .command('document-import')
    .description('Inspect and resume durable document imports.');
  documentImport
    .command('get <importId>')
    .description('Read durable document import state.')
    .action((importId: string, _options: unknown, command: Command) =>
      act(command, async (profile, output) => {
        printResult(await getDocumentImport(profile, importId), output);
      }),
    );
  documentImport
    .command('commit <importId>')
    .description('Commit a preview-ready document import.')
    .option('--no-wait', 'return a resumable receipt while the import commits')
    .action((importId: string, options: { wait?: boolean }, command: Command) =>
      act(command, async (profile, output) => {
        printResult(await commitDocumentImport(profile, importId, options.wait !== false), output);
      }),
    );
  documentImport
    .command('cancel <importId>')
    .description('Cancel a durable document import.')
    .option('--yes', 'confirm cancellation of this import', false)
    .action((importId: string, options: { yes?: boolean }, command: Command) =>
      act(command, async (profile, output) => {
        if (options.yes !== true)
          throw new Error('Pass --yes to confirm cancellation of this import.');
        printResult(await cancelDocumentImport(profile, importId), output);
      }),
    );

  const file = program
    .command('file')
    .description('Upload, replace, inspect, and download file items.');
  file
    .command('probe <itemId>')
    .description('Check preview or thumbnail delivery, including byte-range support.')
    .option('--thumbnail', 'check the generated JPEG thumbnail', false)
    .action((itemId: string, options: { thumbnail: boolean }, command: Command) =>
      act(command, (profile, output) => probeFile(profile, itemId, options.thumbnail, output)),
    );
  file
    .command('upload <path>')
    .requiredOption('--workspace <id>', 'the workspace to upload into')
    .option('--parent <id>', 'the parent item')
    .action((path: string, options: { workspace: string; parent?: string }, command: Command) =>
      act(command, (profile, output) =>
        uploadFile(
          profile,
          {
            path,
            workspaceId: options.workspace,
            ...(options.parent === undefined ? {} : { parentId: options.parent }),
          },
          output,
        ),
      ),
    );
  file
    .command('replace <itemId> <path>')
    .requiredOption('--workspace <id>', 'the item workspace')
    .action((itemId: string, path: string, options: { workspace: string }, command: Command) =>
      act(command, (profile, output) =>
        uploadFile(profile, { path, workspaceId: options.workspace, targetItemId: itemId }, output),
      ),
    );
  file
    .command('versions <itemId>')
    .action((itemId: string, _options: unknown, command: Command) =>
      act(command, (profile, output) => listFileVersions(profile, itemId, output)),
    );
  file
    .command('download <itemId>')
    .requiredOption('-o, --out <path>', 'output file')
    .option('--version <id>', 'historical version id')
    .action((itemId: string, options: { out: string; version?: string }, command: Command) =>
      act(command, (profile, output) =>
        downloadFile(profile, itemId, options.out, options.version, output),
      ),
    );

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

  const item = program.command('item').description('Read and write the item tree.');

  item
    .command('ls')
    .description("List a container's children, or the workspace roots.")
    .requiredOption('--workspace <id>', 'the workspace to list within')
    .option('--parent <id>', 'the container whose children to list (default: workspace roots)')
    .option('--deleted', 'include soft-deleted items', false)
    .action((options: LsOptions, command: Command) =>
      act(command, (profile, output) =>
        listItems(
          profile,
          {
            workspaceId: options.workspace,
            parentId: options.parent,
            includeDeleted: options.deleted === true,
          },
          output,
        ),
      ),
    );

  item
    .command('get <itemId>')
    .description('Read one item by id.')
    .action((itemId: string, _options: unknown, command: Command) =>
      act(command, (profile, output) => getItem(profile, itemId, output)),
    );

  item
    .command('create')
    .description('Create an item.')
    .requiredOption('--workspace <id>', 'the workspace to create in')
    .requiredOption('--title <title>', 'the item title')
    .option('--type <type>', 'the body kind', 'note')
    .option('--parent <id>', 'the parent container (default: workspace root)')
    .action((options: CreateItemOptions, command: Command) =>
      act(command, (profile, output) =>
        createItem(
          profile,
          {
            workspaceId: options.workspace,
            type: options.type,
            title: options.title,
            parentId: options.parent,
          },
          output,
        ),
      ),
    );

  item
    .command('edit <itemId>')
    .description('Rename an item.')
    .requiredOption('--workspace <id>', "the item's workspace")
    .requiredOption('--title <title>', 'the new title')
    .action((itemId: string, options: { workspace: string; title: string }, command: Command) =>
      act(command, (profile, output) =>
        renameItem(profile, itemId, options.workspace, options.title, output),
      ),
    );

  item
    .command('mv <itemId>')
    .description('Move an item and its subtree to a parent or another workspace.')
    .requiredOption('--workspace <id>', "the item's workspace")
    .option('--parent <id>', 'the new parent, or omit for the workspace root')
    .option('--after <id>', 'the sibling to place it after, or omit to place it first')
    .option(
      '--destination-workspace <id>',
      'a writable destination workspace; omitted keeps the current workspace',
    )
    .action((itemId: string, options: MvOptions, command: Command) =>
      act(command, (profile, output) =>
        moveItem(
          profile,
          itemId,
          {
            workspaceId: options.workspace,
            parentId: options.parent ?? null,
            afterId: options.after ?? null,
            destinationWorkspaceId: options.destinationWorkspace,
          },
          output,
        ),
      ),
    );

  item
    .command('rm <itemId>')
    .description('Soft-delete an item; it can be restored until it is purged.')
    .requiredOption('--workspace <id>', "the item's workspace")
    .action((itemId: string, options: WorkspaceOption, command: Command) =>
      act(command, (profile, output) => deleteItem(profile, itemId, options.workspace, output)),
    );

  item
    .command('restore <itemId>')
    .description('Restore a soft-deleted item.')
    .requiredOption('--workspace <id>', "the item's workspace")
    .action((itemId: string, options: WorkspaceOption, command: Command) =>
      act(command, (profile, output) => restoreItem(profile, itemId, options.workspace, output)),
    );

  item
    .command('protect <itemId>')
    .description(
      'Protect an item from deletion, or stop it accepting new children. A protected item ' +
        'cannot be trashed, and neither can anything holding it.',
    )
    .option('--delete <on|off>', 'whether the item is protected from deletion')
    .option('--children <on|off>', 'whether the item refuses new children')
    .option('--collaboration <on|off>', 'whether several people may edit it at once')
    .action((itemId: string, options: ProtectionOptions, command: Command) =>
      act(command, (profile, output) => protect(profile, itemId, options, output)),
    );

  // A lock withholds an item's body until its password is presented; it does not encrypt it.
  // Passwords come from stdin only, never an argument, which process lists and history would keep.
  const lock = item
    .command('lock')
    .description("Read and manage an item's password lock. Passwords are read from stdin.");

  lock
    .command('status <itemId>')
    .description('Whether the body is locked, and until when this profile has it open.')
    .action((itemId: string, _options: unknown, command: Command) =>
      act(command, (profile, output) => lockStatus(profile, itemId, output)),
    );

  lock
    .command('set <itemId>')
    .description(
      'Lock the body with the password on stdin. With --change, stdin carries the current ' +
        'password and then the new one, one per line.',
    )
    .option('--change', 'change the password of an existing lock', false)
    .action((itemId: string, options: { change: boolean }, command: Command) =>
      act(command, async (profile, output) => {
        const [first = '', second] = readPasswords(await readStdin(), options.change ? 2 : 1);
        await (options.change
          ? setLock(profile, itemId, second ?? '', first, output)
          : setLock(profile, itemId, first, undefined, output));
      }),
    );

  lock
    .command('remove <itemId>')
    .description('Remove the lock, given its password on stdin.')
    .action((itemId: string, _options: unknown, command: Command) =>
      act(command, async (profile, output) => {
        const [password = ''] = readPasswords(await readStdin(), 1);
        await removeLock(profile, itemId, password, output);
      }),
    );

  lock
    .command('open <itemId>')
    .description('Unlock the body for this profile, given the password on stdin.')
    .action((itemId: string, _options: unknown, command: Command) =>
      act(command, async (profile, output) => {
        const [password = ''] = readPasswords(await readStdin(), 1);
        await openLock(profile, itemId, password, output);
      }),
    );

  lock
    .command('close <itemId>')
    .description('Lock the body again for this profile before its unlock runs out.')
    .action((itemId: string, _options: unknown, command: Command) =>
      act(command, (profile, output) => closeLock(profile, itemId, output)),
    );

  // Sites publish an item's subtree as a static website. Core decides who may manage them; the
  // publish of a site that is not live, auto mode, a rollback, an unpublish and a delete each need
  // --yes.
  const site = program.command('site').description('Publish an item and its subtree as a website.');

  site
    .command('create <rootItemId>')
    .description('Make an item a draft site. Nothing is public until it is published.')
    .requiredOption('--slug <slug>', 'the first label of the default hostname')
    .option('--layout <layout>', 'docs or blog', 'docs')
    .action((rootItemId: string, options: { slug: string; layout: string }, command: Command) =>
      act(command, (profile, output) =>
        siteCommands.createSite(profile, rootItemId, options, output),
      ),
    );

  site
    .command('get [siteId]')
    .description('Read a site, by id or by its root item.')
    .option('--item <itemId>', 'the root item instead of the site id')
    .action((siteId: string | undefined, options: { item?: string }, command: Command) =>
      act(command, (profile, output) =>
        siteCommands.getSite(profile, { siteId, itemId: options.item }, output),
      ),
    );

  site
    .command('update <siteId>')
    .description('Change settings, the republish mode, exclusions or dated collections.')
    .option('--name <name>', 'the site name')
    .option('--description <text>', 'the one-line description')
    .option('--accent <hex>', 'the accent colour as #rrggbb')
    .option(
      '--nav <link>',
      'a top navigation link <label>=</path>; repeat; replaces the navigation',
      collectOptional,
    )
    .option('--footer <text>', 'the footer text')
    .option('--built-with-nix', 'show the "Built with Nix" footer link')
    .option('--no-built-with-nix', 'hide the "Built with Nix" footer link')
    .option('--noindex', 'hide the site from search engines (robots.txt and meta robots)')
    .option('--no-noindex', 'let search engines index the site again')
    .option('--author <name>', 'who writes the site, for search engines; "" clears it')
    .option('--typeface <face>', 'rounded (Nunito Sans), serif (Literata) or legible (Atkinson)')
    .option('--heading-mark <mark>', 'square, diamond or none')
    .option('--spacing <spacing>', 'compact, comfortable or airy')
    .option('--theme <itemId>', 'the page whose files are the custom layout\'s theme; "" clears it')
    .option('--layout <layout>', 'docs, blog or custom (custom needs --theme)')
    .option(
      '--mode <mode>',
      'manual, auto or on_release; auto publishes every saved edit on its own and needs --yes',
    )
    .option('--debounce <seconds>', 'settle time before an automatic rebuild, 60 to 3600')
    .option(
      '--exclude <itemId>',
      'an item to leave out; repeat; replaces the list',
      collectOptional,
    )
    .option(
      '--dated <spec>',
      'add or replace a dated collection <itemId>:<dateProp>[:<tagsProp>[:<coverProp>[:<summaryProp>]]]; repeat; others are kept',
      collectOptional,
    )
    .option('--undated <itemId>', 'stop treating a collection as dated; repeat', collectOptional)
    .option('--yes', 'confirm switching to auto mode', false)
    .action((siteId: string, options: siteCommands.UpdateSiteOptions, command: Command) =>
      act(command, (profile, output) => siteCommands.updateSite(profile, siteId, options, output)),
    );

  site
    .command('publish <siteId>')
    .description(
      'Build the site and take it live. Publishing a site that is not live (a draft or an unpublished site) needs --yes.',
    )
    .option(
      '--refresh-paths',
      're-derive the paths of pages whose path is not pinned; each old path keeps redirecting to the new one',
      false,
    )
    .option('--yes', 'confirm the content becomes public', false)
    .option('--wait', 'wait until the build is live or has failed', false)
    .option('--timeout <seconds>', 'how long --wait waits', '600')
    .action((siteId: string, options: siteCommands.PublishOptions, command: Command) =>
      act(command, (profile, output) => siteCommands.publishSite(profile, siteId, options, output)),
    );

  site
    .command('builds <siteId>')
    .description("A site's builds, newest first.")
    .action((siteId: string, _options: unknown, command: Command) =>
      act(command, (profile, output) => siteCommands.listBuilds(profile, siteId, output)),
    );

  site
    .command('build <siteId> <buildId>')
    .description('One build: status, page count and what could not be published.')
    .action((siteId: string, buildId: string, _options: unknown, command: Command) =>
      act(command, (profile, output) => siteCommands.getBuild(profile, siteId, buildId, output)),
    );

  site
    .command('pages <siteId>')
    .description("A site's page paths.")
    .action((siteId: string, _options: unknown, command: Command) =>
      act(command, (profile, output) => siteCommands.listPages(profile, siteId, output)),
    );

  site
    .command('path <siteId> <itemId> <path>')
    .description('Set and pin one page path; the old path becomes a permanent redirect.')
    .action((siteId: string, itemId: string, path: string, _options: unknown, command: Command) =>
      act(command, (profile, output) =>
        siteCommands.setPath(profile, siteId, itemId, path, output),
      ),
    );

  site
    .command('rollback <siteId> <buildId>')
    .description('Serve a previous build again, exactly as it was then.')
    .option('--yes', 'confirm re-serving that content', false)
    .action((siteId: string, buildId: string, options: ConfirmCliOptions, command: Command) =>
      act(command, (profile, output) =>
        siteCommands.rollbackSite(profile, siteId, buildId, options.yes === true, output),
      ),
    );

  site
    .command('unpublish <siteId>')
    .description('Take the site down and delete its builds. Copies others made may remain.')
    .option('--yes', 'confirm this destructive operation', false)
    .action((siteId: string, options: ConfirmCliOptions, command: Command) =>
      act(command, (profile, output) =>
        siteCommands.unpublishSite(profile, siteId, options.yes === true, output),
      ),
    );

  registerSiteHostingCommands(site, act);

  site
    .command('delete <siteId>')
    .description('Delete a site that is not live.')
    .option('--yes', 'confirm this destructive operation', false)
    .action((siteId: string, options: ConfirmCliOptions, command: Command) =>
      act(command, (profile, output) =>
        siteCommands.deleteSite(profile, siteId, options.yes === true, output),
      ),
    );

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
