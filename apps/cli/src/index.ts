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
import { login, logout, status } from './commands/auth.ts';
import { readHealth } from './commands/health.ts';
import {
  changeWorkspaceMemberRole,
  acceptWorkspaceInvitation,
  archiveWorkspace,
  createWorkspace,
  declineWorkspaceInvitation,
  inviteWorkspaceMember,
  leaveWorkspace,
  listWorkspaceInvitations,
  listWorkspaceInvitees,
  listWorkspaceMembers,
  listWorkspaceAssignablePrincipals,
  listWorkspaces,
  readWorkspaceGraph,
  dailyNoteSettings,
  openDailyNote,
  purgeWorkspace,
  removeWorkspaceMember,
  renameWorkspace,
  restoreWorkspace,
  revokeWorkspaceInvitation,
} from './commands/workspaces.ts';
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
import { protect } from './commands/protection.ts';
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
} from './commands/calendar-sync.ts';
import { readStdin } from './commands/shared.ts';
import { readNote, writeNote } from './commands/notes.ts';
import { readCanvas, writeCanvas } from './commands/canvas.ts';
import {
  listHistory,
  listHistoryVersions,
  nameHistoryVersion,
  restoreHistory,
  showHistory,
} from './commands/history.ts';
import { runQuery } from './commands/query.ts';
import { getViews, inspectViews, setViews } from './commands/views.ts';
import { getSchema, readStructureOutline, setProps, setSchema } from './commands/structure.ts';
import {
  blueprintBuild,
  blueprintCatalog,
  blueprintDescribe,
  blueprintSave,
  blueprintValidate,
} from './commands/blueprint.ts';
import {
  clearRecurrence,
  completeRecurrence,
  runCalendar,
  setRecurrence,
} from './commands/recurrence.ts';
import { runMyDay } from './commands/my-day.ts';
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
import { getOperation } from './commands/operations.ts';
import { seed, stressRun } from './commands/stress.ts';
import { outputOptions, printError, printResult, ExitCode, type OutputOptions } from './output.ts';
import { runWorkspaceMcpServer } from './mcp.ts';
import { petEval } from './commands/pet-eval.ts';
import { petEvalChat } from './commands/pet-eval-chat.ts';
import {
  petCommand,
  petToolRun,
  type PetOptions,
  type PetToolRunOptions,
} from './commands/pets.ts';
import { checkIn, readHabit, setHabit, setHabitStatus, undoCheckIn } from './commands/habits.ts';
import * as financeCommands from './commands/finance.ts';
import {
  getPreferences,
  listNotifications,
  readAllNotifications,
  readNotification,
  setPreferences,
  type PreferenceFlags,
} from './commands/notifications.ts';
import { clearReminder, setReminder } from './commands/reminders.ts';
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
} from './commands/automations.ts';
import {
  applyTemplate,
  captureTemplate,
  cancelTemplateArchiveImport,
  commitTemplateArchive,
  exportTemplateArchive,
  getTemplate,
  getTemplateImport,
  listTemplates,
  beginTemplateDraft,
  getTemplateDraft,
  updateTemplateDraftFromFile,
  updateTemplateDraftItemFromFile,
  saveTemplateDraft,
  discardTemplateDraft,
  resumeTemplateOperation,
  preflightTemplate,
  previewTemplateArchive,
  updateTemplateInitialization,
} from './commands/templates.ts';

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
    .action((_options: unknown, command: Command) => {
      const options: {
        suite: string;
        scenario?: string;
        case?: string;
        runs: string;
        allowWrites: boolean;
        keep: boolean;
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

  const ws = program.command('ws').description('The workspaces a token can reach.');

  program
    .command('operation')
    .description('Inspect a durable operation visible to the current profile.')
    .command('get <operationId>')
    .description('Read the current state of an authorized operation.')
    .action((operationId: string, _options: unknown, command: Command) =>
      act(command, (profile, output) => getOperation(profile, operationId, output)),
    );

  ws.command('list')
    .description('List one page of workspaces the profile can reach.')
    .option('--limit <count>', 'maximum rows in this page', parseInteger, 50)
    .option('--cursor <cursor>', 'opaque cursor returned by the previous page')
    .action((options: PageCliOptions, command: Command) =>
      act(command, (profile, output) => listWorkspaces(profile, options, output)),
    );

  ws.command('graph <workspaceId>')
    .description('Read the workspace graph, including its item and link limits.')
    .action((workspaceId: string, _options: unknown, command: Command) =>
      act(command, (profile, output) => readWorkspaceGraph(profile, workspaceId, output)),
    );

  ws.command('daily-settings <workspaceId>')
    .description('Read daily-note settings, or save all settings from a JSON file.')
    .option('--file <path>', 'JSON settings file to save')
    .action((workspaceId: string, options: { file?: string }, command: Command) =>
      act(command, (profile, output) =>
        dailyNoteSettings(profile, workspaceId, options.file, output),
      ),
    );
  ws.command('daily <workspaceId> <date>')
    .description('Open or create the workspace daily note for yyyy-MM-dd.')
    .action((workspaceId: string, date: string, _options: unknown, command: Command) =>
      act(command, (profile, output) => openDailyNote(profile, workspaceId, date, output)),
    );

  ws.command('create <name>')
    .description('Create a shared workspace.')
    .action((name: string, _options: unknown, command: Command) =>
      act(command, (profile, output) => createWorkspace(profile, name, output)),
    );
  ws.command('rename <workspaceId> <name>')
    .description('Rename a workspace.')
    .action((workspaceId: string, name: string, _options: unknown, command: Command) =>
      act(command, (profile, output) => renameWorkspace(profile, workspaceId, name, output)),
    );
  ws.command('archive <workspaceId>')
    .description('Archive a workspace so it is out of everyday navigation.')
    .option('--yes', 'confirm this destructive operation', false)
    .action((workspaceId: string, options: ConfirmCliOptions, command: Command) =>
      act(command, (profile, output) =>
        archiveWorkspace(profile, workspaceId, options.yes === true, output),
      ),
    );
  ws.command('restore <workspaceId>')
    .description('Restore an archived workspace.')
    .action((workspaceId: string, _options: unknown, command: Command) =>
      act(command, (profile, output) => restoreWorkspace(profile, workspaceId, output)),
    );
  ws.command('purge <workspaceId>')
    .description('Permanently delete an archived workspace and its stored files.')
    .option('--yes', 'confirm this irreversible operation', false)
    .action((workspaceId: string, options: ConfirmCliOptions, command: Command) =>
      act(command, (profile, output) =>
        purgeWorkspace(profile, workspaceId, options.yes === true, output),
      ),
    );
  ws.command('invitations <workspaceId>')
    .description('List invitation history.')
    .option('--limit <count>', 'maximum rows in this page', parseInteger, 50)
    .option('--cursor <cursor>', 'opaque cursor returned by the previous page')
    .action((workspaceId: string, options: PageCliOptions, command: Command) =>
      act(command, (profile, output) =>
        listWorkspaceInvitations(profile, workspaceId, options, output),
      ),
    );
  ws.command('invitees <workspaceId>')
    .description('List active users and their workspace invitation eligibility.')
    .option('--query <text>', 'search people by name or email')
    .option('--limit <count>', 'maximum rows in this page', parseInteger, 50)
    .option('--cursor <cursor>', 'opaque cursor returned by the previous page')
    .action((workspaceId: string, options: PageCliOptions & { query?: string }, command: Command) =>
      act(command, (profile, output) =>
        listWorkspaceInvitees(profile, workspaceId, options, output),
      ),
    );
  ws.command('invite <workspaceId> <principalId>')
    .requiredOption('--role <role>', 'owner, editor, or viewer')
    .description('Invite a collaborator.')
    .action(
      (workspaceId: string, principalId: string, options: { role: string }, command: Command) =>
        act(command, (profile, output) =>
          inviteWorkspaceMember(profile, workspaceId, principalId, options.role, output),
        ),
    );
  ws.command('accept-invite <workspaceId> <invitationId>')
    .description('Accept an invitation addressed to the current principal.')
    .action((workspaceId: string, invitationId: string, _options: unknown, command: Command) =>
      act(command, (profile, output) =>
        acceptWorkspaceInvitation(profile, workspaceId, invitationId, output),
      ),
    );
  ws.command('decline-invite <workspaceId> <invitationId>')
    .description('Decline an invitation and remove provisional access.')
    .option('--yes', 'confirm this destructive operation', false)
    .action(
      (workspaceId: string, invitationId: string, options: ConfirmCliOptions, command: Command) =>
        act(command, (profile, output) =>
          declineWorkspaceInvitation(
            profile,
            workspaceId,
            invitationId,
            options.yes === true,
            output,
          ),
        ),
    );
  ws.command('revoke-invite <workspaceId> <invitationId>')
    .description('Revoke a pending invitation.')
    .option('--yes', 'confirm this destructive operation', false)
    .action(
      (workspaceId: string, invitationId: string, options: ConfirmCliOptions, command: Command) =>
        act(command, (profile, output) =>
          revokeWorkspaceInvitation(
            profile,
            workspaceId,
            invitationId,
            options.yes === true,
            output,
          ),
        ),
    );
  ws.command('members <workspaceId>')
    .description('List principal and group workspace grants.')
    .option('--limit <count>', 'maximum rows in this page', parseInteger, 50)
    .option('--cursor <cursor>', 'opaque cursor returned by the previous page')
    .action((workspaceId: string, options: PageCliOptions, command: Command) =>
      act(command, (profile, output) =>
        listWorkspaceMembers(profile, workspaceId, options, output),
      ),
    );
  ws.command('principals <workspaceId>')
    .description('List active direct and group-derived principals available for assignment.')
    .option('--query <text>', 'filter display names by text')
    .option('--limit <count>', 'maximum rows in this page', parseInteger, 50)
    .option('--cursor <cursor>', 'opaque cursor returned by the previous page')
    .action((workspaceId: string, options: PageCliOptions & { query?: string }, command: Command) =>
      act(command, (profile, output) =>
        listWorkspaceAssignablePrincipals(profile, workspaceId, options, output),
      ),
    );
  ws.command('role <workspaceId> <principalId>')
    .requiredOption('--role <role>', 'owner, editor, or viewer')
    .description('Change a member role.')
    .action(
      (workspaceId: string, principalId: string, options: { role: string }, command: Command) =>
        act(command, (profile, output) =>
          changeWorkspaceMemberRole(profile, workspaceId, principalId, options.role, output),
        ),
    );
  ws.command('remove <workspaceId> <principalId>')
    .description('Remove a workspace member.')
    .option('--yes', 'confirm this destructive operation', false)
    .action(
      (workspaceId: string, principalId: string, options: ConfirmCliOptions, command: Command) =>
        act(command, (profile, output) =>
          removeWorkspaceMember(profile, workspaceId, principalId, options.yes === true, output),
        ),
    );
  ws.command('leave <workspaceId>')
    .description('Leave a workspace.')
    .option('--yes', 'confirm this destructive operation', false)
    .action((workspaceId: string, options: ConfirmCliOptions, command: Command) =>
      act(command, (profile, output) =>
        leaveWorkspace(profile, workspaceId, options.yes === true, output),
      ),
    );

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

  const template = program
    .command('template')
    .description('List, capture, initialize, and apply workspace templates.');

  const draft = template
    .command('draft')
    .description('Open and manage a resumable editable template draft.');
  draft
    .command('begin <templateId>')
    .description('Copy a template into a draft and wait for any file transfer to finish.')
    .option('--idempotency-key <key>', 'reuse a key to resume the same draft copy')
    .option('--no-wait', 'return a resumable receipt while files copy in the background')
    .action(
      (
        templateId: string,
        options: { idempotencyKey?: string; wait?: boolean },
        command: Command,
      ) =>
        act(command, (profile, output) =>
          beginTemplateDraft(
            profile,
            templateId,
            {
              ...(options.idempotencyKey === undefined
                ? {}
                : { idempotencyKey: options.idempotencyKey }),
              noWait: options.wait === false,
            },
            output,
          ),
        ),
    );
  draft
    .command('show <templateId> <operationId>')
    .description('Read the current draft tree and metadata.')
    .action((templateId: string, operationId: string, _options: unknown, command: Command) =>
      act(command, (profile, output) => getTemplateDraft(profile, templateId, operationId, output)),
    );
  draft
    .command('update <templateId> <operationId>')
    .description('Patch draft title, description, or initialization from a JSON file.')
    .requiredOption('--file <path>', 'JSON object containing the draft metadata patch')
    .action(
      (templateId: string, operationId: string, options: { file: string }, command: Command) =>
        act(command, (profile, output) =>
          updateTemplateDraftFromFile(profile, templateId, operationId, options.file, output),
        ),
    );
  draft
    .command('update-item <templateId> <operationId> <sourceId>')
    .description('Patch one draft item from a JSON file.')
    .requiredOption('--file <path>', 'JSON object containing the item patch')
    .action(
      (
        templateId: string,
        operationId: string,
        sourceId: string,
        options: { file: string },
        command: Command,
      ) =>
        act(command, (profile, output) =>
          updateTemplateDraftItemFromFile(
            profile,
            templateId,
            operationId,
            sourceId,
            options.file,
            output,
          ),
        ),
    );
  draft
    .command('save <templateId> <operationId>')
    .description('Publish the completed draft as the new template revision.')
    .action((templateId: string, operationId: string, _options: unknown, command: Command) =>
      act(command, (profile, output) =>
        saveTemplateDraft(profile, templateId, operationId, output),
      ),
    );
  draft
    .command('discard <templateId> <operationId>')
    .description('Discard an unfinished draft and its copied bodies.')
    .action((templateId: string, operationId: string, _options: unknown, command: Command) =>
      act(command, (profile, output) =>
        discardTemplateDraft(profile, templateId, operationId, output),
      ),
    );
  template
    .command('resume <receiptPath>')
    .description('Poll a template file-copy job and replay its original idempotent command.')
    .action((receiptPath: string, _options: unknown, command: Command) =>
      act(command, (profile, output) => resumeTemplateOperation(profile, receiptPath, output)),
    );

  template
    .command('list <workspaceId>')
    .description('List templates visible in a workspace.')
    .action((workspaceId: string, _options: unknown, command: Command) =>
      act(command, (profile, output) => listTemplates(profile, workspaceId, output)),
    );

  template
    .command('show <templateId>')
    .description('Read one template and its initialization questions.')
    .action((templateId: string, _options: unknown, command: Command) =>
      act(command, (profile, output) => getTemplate(profile, templateId, output)),
    );

  template
    .command('capture <workspaceId> <sourceItemId>')
    .description('Capture an item tree as a reusable template.')
    .requiredOption('--title <title>', 'template name')
    .option('--idempotency-key <key>', 'reuse a key to resume a pending capture')
    .option('--description <text>', 'when this starting point is useful')
    .option('--include-body', 'copy body content', false)
    .option('--include-children', 'copy readable descendants', false)
    .option('--no-wait', 'return a resumable receipt while files copy in the background')
    .action(
      (
        workspaceId: string,
        sourceItemId: string,
        options: {
          title: string;
          description?: string;
          idempotencyKey?: string;
          includeBody?: boolean;
          includeChildren?: boolean;
          wait?: boolean;
        },
        command: Command,
      ) =>
        act(command, (profile, output) =>
          captureTemplate(
            profile,
            {
              workspaceId,
              sourceItemId,
              title: options.title,
              includeBody: options.includeBody === true,
              includeChildren: options.includeChildren === true,
              ...(options.description === undefined ? {} : { description: options.description }),
              ...(options.idempotencyKey === undefined
                ? {}
                : { idempotencyKey: options.idempotencyKey }),
            },
            output,
            undefined,
            undefined,
            options.wait !== false,
          ),
        ),
    );

  template
    .command('initialize <templateId>')
    .description('Replace a template’s setup questions and field rules from a JSON file.')
    .requiredOption('--file <path>', 'strict version 1 initialization JSON')
    .option('--title <title>', 'rename the template')
    .option('--description <text>', 'update its description')
    .option('--idempotency-key <key>', 'reuse a key to resume a pending draft update')
    .option('--no-wait', 'return a resumable receipt while files copy in the background')
    .action(
      (
        templateId: string,
        options: {
          file: string;
          title?: string;
          description?: string;
          idempotencyKey?: string;
          wait?: boolean;
        },
        command: Command,
      ) =>
        act(command, (profile, output) =>
          updateTemplateInitialization(
            profile,
            templateId,
            options.file,
            {
              ...(options.title === undefined ? {} : { title: options.title }),
              ...(options.description === undefined ? {} : { description: options.description }),
              ...(options.idempotencyKey === undefined
                ? {}
                : { idempotencyKey: options.idempotencyKey }),
            },
            output,
            undefined,
            options.wait !== false,
          ),
        ),
    );

  template
    .command('apply <templateId>')
    .description('Preflight and apply a template to an item or as a new child.')
    .requiredOption('--mode <mode>', 'merge or create')
    .option('--target <itemId>', 'existing item for merge mode')
    .option('--parent <itemId>', 'parent item for create mode')
    .option('--title <title>', 'title for the created item')
    .option(
      '--input <key=value>',
      'answer one setup question; repeat for each answer',
      collectOption,
      [],
    )
    .option('--expected-revision <revision>', 'refuse a changed template revision', parseInteger)
    .option('--idempotency-key <key>', 'reuse a key to resume a pending application')
    .option('--no-wait', 'return a resumable receipt while files copy in the background')
    .action(
      (
        templateId: string,
        options: {
          mode: 'merge' | 'create';
          target?: string;
          parent?: string;
          title?: string;
          input?: string[];
          expectedRevision?: number;
          idempotencyKey?: string;
          wait?: boolean;
        },
        command: Command,
      ) =>
        act(command, (profile, output) =>
          applyTemplate(
            profile,
            {
              templateId,
              mode: options.mode,
              ...(options.target === undefined ? {} : { targetItemId: options.target }),
              ...(options.parent === undefined ? {} : { parentItemId: options.parent }),
              ...(options.title === undefined ? {} : { title: options.title }),
              ...(options.input === undefined
                ? {}
                : { inputs: parseTemplateInputPairs(options.input) }),
              ...(options.expectedRevision === undefined
                ? {}
                : { expectedRevision: options.expectedRevision }),
              ...(options.idempotencyKey === undefined
                ? {}
                : { idempotencyKey: options.idempotencyKey }),
            },
            output,
            undefined,
            options.wait !== false,
          ),
        ),
    );

  template
    .command('preflight <templateId>')
    .description('Resolve setup questions and preview a template without creating items.')
    .requiredOption('--mode <mode>', 'merge or create')
    .option('--target <itemId>', 'existing item for merge mode')
    .option('--parent <itemId>', 'parent item for create mode')
    .option('--title <title>', 'title for the created item')
    .option(
      '--input <key=value>',
      'answer one setup question; repeat for each answer',
      collectOption,
      [],
    )
    .option('--expected-revision <revision>', 'preview only this template revision', parseInteger)
    .action(
      (
        templateId: string,
        options: {
          mode: 'merge' | 'create';
          target?: string;
          parent?: string;
          title?: string;
          input?: string[];
          expectedRevision?: number;
        },
        command: Command,
      ) =>
        act(command, (profile, output) =>
          preflightTemplate(
            profile,
            {
              templateId,
              mode: options.mode,
              ...(options.target === undefined ? {} : { targetItemId: options.target }),
              ...(options.parent === undefined ? {} : { parentItemId: options.parent }),
              ...(options.title === undefined ? {} : { title: options.title }),
              ...(options.input === undefined
                ? {}
                : { inputs: parseTemplateInputPairs(options.input) }),
              ...(options.expectedRevision === undefined
                ? {}
                : { expectedRevision: options.expectedRevision }),
            },
            output,
          ),
        ),
    );

  template
    .command('import <workspaceId> <path>')
    .description('Upload a portable template archive and print its validated preview and digest.')
    .option('--idempotency-key <key>', 'reuse a key to resume the same archive preview')
    .action(
      (workspaceId: string, path: string, options: { idempotencyKey?: string }, command: Command) =>
        act(command, (profile, output) =>
          previewTemplateArchive(profile, workspaceId, path, options, output),
        ),
    );

  template
    .command('import-commit <importId> <digest>')
    .description('Publish a previewed template archive using the exact digest returned by import.')
    .action((importId: string, digest: string, _options: unknown, command: Command) =>
      act(command, (profile, output) => commitTemplateArchive(profile, importId, digest, output)),
    );

  template
    .command('import-get <importId>')
    .description('Read the current state of an authorized template archive import.')
    .action((importId: string, _options: unknown, command: Command) =>
      act(command, (profile, output) => getTemplateImport(profile, importId, output)),
    );

  template
    .command('import-cancel <importId>')
    .description('Cancel an authorized template archive import and its pending worker execution.')
    .option('--yes', 'confirm cancellation of this import', false)
    .action((importId: string, options: { yes?: boolean }, command: Command) =>
      act(command, (profile, output) => {
        if (options.yes !== true) {
          throw new Error('Pass --yes to confirm cancellation of this template archive import.');
        }
        return cancelTemplateArchiveImport(profile, importId, output);
      }),
    );

  template
    .command('export <templateId>')
    .description('Download a portable template archive from the authorized Collab service.')
    .requiredOption('-o, --out <path>', 'write the archive here')
    .action((templateId: string, options: { out: string }, command: Command) =>
      act(command, (profile, output) =>
        exportTemplateArchive(profile, templateId, options.out, output),
      ),
    );

  const note = program
    .command('note')
    .description(
      "A note's body, as Markdown. The same read, replace and append are " +
        'GET, PUT and POST /api/v1/items/{itemId}/body.',
    );

  note
    .command('read <itemId>')
    .description('Read a note body as Markdown.')
    .option('--raw', 'print only the Markdown text, even when piped', false)
    .action((itemId: string, options: { raw?: boolean }, command: Command) =>
      act(command, (profile, output) =>
        readNote(profile, itemId, { raw: options.raw === true }, output),
      ),
    );

  note
    .command('write <itemId>')
    .description('Replace a note body with Markdown from --file or stdin.')
    .option('--file <path>', 'read the Markdown from this file instead of stdin')
    .action((itemId: string, options: { file?: string }, command: Command) =>
      act(command, (profile, output) => writeNote(profile, itemId, { file: options.file }, output)),
    );

  const canvas = program.command('canvas').description("A canvas's durable elements, as JSON.");

  canvas
    .command('read <itemId>')
    .description('Read a canvas scene, including element metadata and deletion tombstones.')
    .action((itemId: string, _options: unknown, command: Command) =>
      act(command, (profile, output) => readCanvas(profile, itemId, output)),
    );

  canvas
    .command('write <itemId>')
    .description('Merge JSON scene elements from --file or stdin; omitted elements are retained.')
    .option('--file <path>', 'read the scene from this file instead of stdin')
    .action((itemId: string, options: { file?: string }, command: Command) =>
      act(command, (profile, output) =>
        writeCanvas(profile, itemId, { file: options.file }, output),
      ),
    );

  const history = program
    .command('history')
    .description("A document's revisions, named versions, and earlier states.");

  history
    .command('list <itemId>')
    .description('List revisions, newest first.')
    .option('--limit <n>', 'maximum revisions in this page (default 50, max 100)', parseInteger)
    .option('--before <seq>', 'page backwards from this sequence number, exclusive', parseInteger)
    .action((itemId: string, options: { limit?: number; before?: number }, command: Command) =>
      act(command, (profile, output) =>
        listHistory(profile, itemId, { limit: options.limit, before: options.before }, output),
      ),
    );

  history
    .command('show <itemId> <seq>')
    .description('Show the document as it stood at one revision.')
    .option('--markdown', 'render as Markdown instead of plaintext', false)
    .action((itemId: string, seq: string, options: { markdown?: boolean }, command: Command) =>
      act(command, (profile, output) =>
        showHistory(
          profile,
          itemId,
          parseSeqArg(seq),
          { markdown: options.markdown === true },
          output,
        ),
      ),
    );

  history
    .command('restore <itemId> <seq>')
    .description('Replace the current document with its state at an earlier revision.')
    .option('--yes', 'confirm this operation', false)
    .action((itemId: string, seq: string, options: ConfirmCliOptions, command: Command) =>
      act(command, (profile, output) =>
        restoreHistory(profile, itemId, parseSeqArg(seq), options.yes === true, output),
      ),
    );

  history
    .command('name <itemId> <seq> <name>')
    .description('Name a revision, pinning it so retention can never remove it.')
    .action((itemId: string, seq: string, name: string, _options: unknown, command: Command) =>
      act(command, (profile, output) =>
        nameHistoryVersion(profile, itemId, parseSeqArg(seq), name, output),
      ),
    );

  history
    .command('versions <itemId>')
    .description("List a document's named versions.")
    .action((itemId: string, _options: unknown, command: Command) =>
      act(command, (profile, output) => listHistoryVersions(profile, itemId, output)),
    );

  const viewsCmd = program
    .command('views')
    .description('The views a container offers over its children.');

  viewsCmd
    .command('get <itemId>')
    .description("List a container's views, which can render, and which opens by default.")
    .action((itemId: string, _options: unknown, command: Command) =>
      act(command, (profile, output) => getViews(profile, itemId, output)),
    );

  viewsCmd
    .command('inspect <itemId>')
    .description('Read the saved view configuration, including embedded widgets.')
    .action((itemId: string, _options: unknown, command: Command) =>
      act(command, (profile, output) => inspectViews(profile, itemId, output)),
    );

  viewsCmd
    .command('set <itemId>')
    .description("Replace a container's view set from a JSON file.")
    .requiredOption('--file <path>', 'a JSON object { "views": [...], "default": <id|null> }')
    .action((itemId: string, options: { file: string }, command: Command) =>
      act(command, (profile, output) => setViews(profile, itemId, options.file, output)),
    );

  program
    .command('query <itemId>')
    .description("Run one of a container's views and print the children it shows.")
    .requiredOption('--view <viewId>', "which of the container's views to run")
    .requiredOption('--today <yyyy-mm-dd>', "the caller's own day, for relative rules")
    .action((itemId: string, options: { view: string; today: string }, command: Command) =>
      act(command, (profile, output) =>
        runQuery(profile, itemId, { view: options.view, today: options.today }, output),
      ),
    );

  const schema = program.command('schema').description("An item's declared property schema.");

  const structureRead = program
    .command('structure')
    .description("An item's fields, views and child count as the pet sees them.");

  structureRead
    .command('read <itemId>')
    .description('Read an item’s effective fields, views and bounded child count.')
    .action((itemId: string, _options: unknown, command: Command) =>
      act(command, (profile, output) => readStructureOutline(profile, itemId, output)),
    );

  const blueprint = program.command('blueprint').description('Inspect and build a blueprint.');
  blueprint
    .command('catalog')
    .description('Print the generated structure catalog.')
    .option('--text', 'print the rendered catalog text the pet reads', false)
    .action((options: { text: boolean }, command: Command) =>
      act(command, (profile, output) => blueprintCatalog(options.text, output)),
    );
  blueprint
    .command('validate <file>')
    .description('Validate a blueprint without writing it.')
    .option('--parent <id>', 'destination item whose fields are inherited')
    .action((file: string, options: { parent?: string }, command: Command) =>
      act(command, (profile, output) => blueprintValidate(profile, file, options, output)),
    );
  blueprint
    .command('describe <file>')
    .description('Preview a blueprint without writing it.')
    .option('--parent <id>', 'destination item whose fields are inherited')
    .action((file: string, options: { parent?: string }, command: Command) =>
      act(command, (profile, output) => blueprintDescribe(profile, file, options, output)),
    );
  blueprint
    .command('build <file>')
    .description('Build a blueprint as a draft and print its write ledger.')
    .option('--parent <id>', 'destination item')
    .option('--workspace <id>', 'workspace for the Pet drafts sandbox')
    .option('--yes', 'confirm the blueprint build', false)
    .action(
      (
        file: string,
        options: { parent?: string; workspace?: string; yes?: boolean },
        command: Command,
      ) => act(command, (profile, output) => blueprintBuild(profile, file, options, output)),
    );
  blueprint
    .command('save <rootId> <spec-file>')
    .description('Save a built item tree as a reusable template.')
    .option('--yes', 'confirm template capture', false)
    .requiredOption('--idempotency-key <key>', 'stable key for safe retries')
    .action(
      (
        rootId: string,
        specFile: string,
        options: { yes?: boolean; idempotencyKey: string },
        command: Command,
      ) =>
        act(command, (profile, output) =>
          blueprintSave(profile, rootId, specFile, options, output),
        ),
    );

  schema
    .command('get <itemId>')
    .description('Read the property schema resolved at an item.')
    .action((itemId: string, _options: unknown, command: Command) =>
      act(command, (profile, output) => getSchema(profile, itemId, output)),
    );

  schema
    .command('set <itemId>')
    .description("Replace an item's declared schema from a JSON file.")
    .requiredOption('--file <path>', 'a JSON object { "properties": [...], "inherit": bool }')
    .action((itemId: string, options: { file: string }, command: Command) =>
      act(command, (profile, output) => setSchema(profile, itemId, options.file, output)),
    );

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

  program
    .command('my-day')
    .description(
      "Print what to do today in one workspace: tasks due, overdue or assigned, and today's habits, with coverage.",
    )
    .requiredOption('--workspace <id>', 'the workspace to read')
    .action((options: { workspace: string }, command: Command) =>
      act(command, (profile, output) => runMyDay(profile, options.workspace, output)),
    );

  const money = program
    .command('finance')
    .description('Set up a finance root, record against it, and read what Core derives.');

  money
    .command('setup <rootId>')
    .description('Make an item a finance root, or change its settings.')
    .requiredOption('--currency <code>', 'three-letter ISO code, for example GBP')
    .requiredOption('--start-month <yyyy-mm>', 'first planned month')
    .option('--horizon <months>', 'months to plan', '17')
    .option('--opening-cash <amount>', 'cash the day before the start month', '0')
    .option('--emergency-months <months>', 'months of outgoings to hold', '3')
    .option('--timezone <iana>', 'where today is decided', 'Europe/London')
    .action((rootId: string, options: financeCommands.SetupOptions, command: Command) =>
      act(command, (profile, output) => financeCommands.setup(profile, rootId, options, output)),
    );

  money
    .command('get <rootId>')
    .description('Read settings, accounts, budget lines and closed months.')
    .action((rootId: string, _options: unknown, command: Command) =>
      act(command, (profile, output) => financeCommands.get(profile, rootId, output)),
    );

  const accountFlags = (target: Command): Command =>
    target
      .requiredOption('--name <name>', 'account name')
      .requiredOption('--type <type>', 'current, savings, debit, credit_card or loan')
      .option('--limit <amount>', 'credit limit')
      .option('--opening <amount>', 'balance carried into the start month')
      .option('--settles-from <accountId>', 'the account a card is paid from')
      .option('--apr <percent>', 'annual rate for a loan, for example 11')
      .option('--payment <amount>', 'standard monthly payment for a loan')
      .option('--overpayment <amount>', 'extra paid each month on a loan')
      .option('--target <amount>', 'savings target')
      .option('--archived', 'keep for history only');

  accountFlags(money.command('account-add <rootId>').description('Add an account.')).action(
    (rootId: string, options: financeCommands.AccountOptions, command: Command) =>
      act(command, (profile, output) =>
        financeCommands.addAccount(profile, rootId, options, output),
      ),
  );

  accountFlags(
    money.command('account-set <rootId> <accountId>').description('Change an account.'),
  ).action(
    (
      rootId: string,
      accountId: string,
      options: financeCommands.AccountOptions,
      command: Command,
    ) =>
      act(command, (profile, output) =>
        financeCommands.setAccount(profile, rootId, accountId, options, output),
      ),
  );

  const lineFlags = (target: Command): Command =>
    target
      .requiredOption('--name <name>', 'line name, for example Rent')
      .requiredOption('--section <section>', 'heading, for example Housing')
      .requiredOption('--flow <flow>', 'income or expense')
      .requiredOption('--account <accountId>', 'the account it is paid from or into')
      .option('--amount <amount>', 'planned amount each month', '0')
      .option('--scheduled', 'leaves on its own; post it from the plan')
      .option('--due-day <day>', 'day of the month a scheduled line goes out')
      .option('--loan-account <accountId>', 'plan the instalment of this loan instead')
      .option(
        '--override <yyyy-mm=amount>',
        'a different plan for one month, repeatable',
        collectOption,
        [],
      )
      .option('--archived', 'plan no further');

  lineFlags(money.command('line-add <rootId>').description('Add a budget line.')).action(
    (rootId: string, options: financeCommands.LineOptions, command: Command) =>
      act(command, (profile, output) => financeCommands.addLine(profile, rootId, options, output)),
  );

  lineFlags(
    money.command('line-set <rootId> <lineId>').description('Change a budget line.'),
  ).action(
    (rootId: string, lineId: string, options: financeCommands.LineOptions, command: Command) =>
      act(command, (profile, output) =>
        financeCommands.setLine(profile, rootId, lineId, options, output),
      ),
  );

  money
    .command('add <rootId>')
    .description('Record a transaction; a negative amount left the account.')
    .requiredOption('--amount <amount>', 'signed cash effect, for example -12.40')
    .requiredOption('--description <text>', 'payee or what it was for')
    .requiredOption('--account <accountId>', 'the account it moved on')
    .option('--line <lineId>', 'budget line it counts against')
    .option('--date <yyyy-mm-dd>', 'day it happened; defaults to today')
    .option('--cleared', 'seen on a statement')
    .action((rootId: string, options: financeCommands.AddOptions, command: Command) =>
      act(command, (profile, output) => financeCommands.add(profile, rootId, options, output)),
    );

  money
    .command('transaction-set <rootId> <transactionId>')
    .description('Replace a transaction under a finance root.')
    .requiredOption('--amount <amount>', 'signed cash effect, for example -12.40')
    .requiredOption('--description <text>', 'payee or what it was for')
    .requiredOption('--account <accountId>', 'the account it moved on')
    .requiredOption('--date <yyyy-mm-dd>', 'day it happened')
    .option('--line <lineId>', 'budget line it counts against')
    .option('--unassigned', 'remove its budget line assignment')
    .requiredOption('--cleared <true|false>', 'whether it has been seen on a statement')
    .action(
      (
        rootId: string,
        transactionId: string,
        options: financeCommands.SetTransactionOptions,
        command: Command,
      ) =>
        act(command, (profile, output) =>
          financeCommands.setTransaction(profile, rootId, transactionId, options, output),
        ),
    );

  money
    .command('transactions <rootId>')
    .description('List transactions, newest first.')
    .option('--month <yyyy-mm>', 'only this month')
    .option('--account <accountId>', 'only this account')
    .option('--line <lineId>', 'only this budget line')
    .option('--unassigned', 'only those with no budget line')
    .option('--limit <count>', 'at most this many')
    .option('--offset <count>', 'skip this many matching records')
    .option('--transaction <transactionId>', 'only this transaction')
    .option('--from <yyyy-mm-dd>', 'history start date, inclusive')
    .option('--to <yyyy-mm-dd>', 'history end date, inclusive')
    .option('--search <text>', 'search descriptions')
    .option('--source <source>', 'manual, scheduled or import')
    .option('--min-amount <amount>', 'minimum amount magnitude')
    .option('--max-amount <amount>', 'maximum amount magnitude')
    .action((rootId: string, options: financeCommands.TransactionsOptions, command: Command) =>
      act(command, (profile, output) =>
        financeCommands.transactions(profile, rootId, options, output),
      ),
    );

  money
    .command('budget <rootId>')
    .description('Lines by month with plan, actual and variance.')
    .option('--from <yyyy-mm>', 'first month; defaults to the current month')
    .option('--to <yyyy-mm>', 'last month; defaults to --from')
    .option('--account <accountId>', "only this account's lines, with its own totals")
    .action(
      (
        rootId: string,
        options: { from?: string; to?: string; account?: string },
        command: Command,
      ) =>
        act(command, (profile, output) => financeCommands.budget(profile, rootId, options, output)),
    );

  money
    .command('actual <rootId> <lineId> <month>')
    .description(
      "Bring a line's actual for a month to an amount; Core records the transaction that gets it there.",
    )
    .requiredOption('--amount <amount>', "the total, zero or more, in the line's own direction")
    .option('--description <text>', 'what to call the transaction; defaults to the line name')
    .option('--date <yyyy-mm-dd>', 'day to record it on, inside the month')
    .action(
      (
        rootId: string,
        lineId: string,
        value: string,
        options: financeCommands.ActualOptions,
        command: Command,
      ) =>
        act(command, (profile, output) =>
          financeCommands.actual(profile, rootId, lineId, value, options, output),
        ),
    );

  money
    .command('transaction-delete <rootId> <transactionId>')
    .description('Delete a transaction in an open month; it can be restored like any item.')
    .action((rootId: string, transactionId: string, command: Command) =>
      act(command, (profile, output) =>
        financeCommands.deleteTransaction(profile, rootId, transactionId, output),
      ),
    );

  money
    .command('accounts <rootId>')
    .description('Every account with the figure that matters for it in a month.')
    .option('--month <yyyy-mm>', 'defaults to the current month')
    .action((rootId: string, options: { month?: string }, command: Command) =>
      act(command, (profile, output) => financeCommands.accounts(profile, rootId, options, output)),
    );

  money
    .command('loan <rootId> <accountId>')
    .description('A loan schedule, and what a different overpayment buys.')
    .option('--overpayment <amount>', 'try this overpayment each month')
    .action(
      (rootId: string, accountId: string, options: { overpayment?: string }, command: Command) =>
        act(command, (profile, output) =>
          financeCommands.loan(profile, rootId, accountId, options, output),
        ),
    );

  money
    .command('cashflow <rootId>')
    .description('Cash month by month across the horizon.')
    .action((rootId: string, _options: unknown, command: Command) =>
      act(command, (profile, output) => financeCommands.cashFlow(profile, rootId, output)),
    );

  money
    .command('dashboard <rootId>')
    .description("The month's position, cards, loans, what to watch and what is due soon.")
    .option('--month <yyyy-mm>', 'defaults to the current month')
    .action((rootId: string, options: { month?: string }, command: Command) =>
      act(command, (profile, output) =>
        financeCommands.dashboard(profile, rootId, options, output),
      ),
    );

  money
    .command('month <rootId> <month>')
    .description('Read what closing a month would leave open, or close or reopen it.')
    .option('--close', 'close the month')
    .option('--reopen', 'reopen the month')
    .action(
      (
        rootId: string,
        value: string,
        options: { close?: boolean; reopen?: boolean },
        command: Command,
      ) =>
        act(command, (profile, output) =>
          financeCommands.month(profile, rootId, value, options, output),
        ),
    );

  money
    .command('post <rootId> <month>')
    .description("Post every scheduled line's planned amount for the month, once.")
    .action((rootId: string, value: string, _options: unknown, command: Command) =>
      act(command, (profile, output) =>
        financeCommands.postScheduled(profile, rootId, value, output),
      ),
    );

  money
    .command('import <rootId>')
    .description('Read a bank CSV into an account; previews unless --commit.')
    .requiredOption('--account <accountId>', 'the account the statement is for')
    .requiredOption('--file <path>', 'the CSV file')
    .option('--commit', 'write what the preview would')
    .action((rootId: string, options: financeCommands.ImportOptions, command: Command) =>
      act(command, (profile, output) =>
        financeCommands.importStatement(profile, rootId, options, output),
      ),
    );

  money
    .command('seed <rootId>')
    .description(
      'Set up a root from a plan file: settings, accounts, lines, actuals and month closes.',
    )
    .requiredOption('--file <path>', 'the plan JSON')
    .action((rootId: string, options: { file: string }, command: Command) =>
      act(command, (profile, output) => financeCommands.seed(profile, rootId, options, output)),
    );

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

  program
    .command('search <query>')
    .description('Full-text search across the items you can see.')
    .option('--limit <n>', 'cap the number of hits', (value) => Number.parseInt(value, 10))
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
    .action((itemId: string, options: { delete?: string; children?: string }, command: Command) =>
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
    .option('--layout <layout>', 'docs or blog')
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

interface LsOptions {
  readonly workspace: string;
  readonly parent?: string;
  readonly deleted?: boolean;
}

interface CreateItemOptions {
  readonly workspace: string;
  readonly title: string;
  readonly type: string;
  readonly parent?: string;
}

interface MvOptions {
  readonly workspace: string;
  readonly destinationWorkspace?: string;
  readonly parent?: string;
  readonly after?: string;
}

interface WorkspaceOption {
  readonly workspace: string;
}

interface PageCliOptions {
  readonly limit?: number;
  readonly cursor?: string;
}

interface ConfirmCliOptions {
  readonly yes?: boolean;
}

function parseInteger(value: string): number {
  return Number.parseInt(value, 10);
}

/** Parses a `<seq>` positional argument; a history `seq` is always a non-negative integer. */
function parseSeqArg(value: string): number {
  const seq = Number.parseInt(value, 10);
  if (!Number.isInteger(seq) || seq < 0 || String(seq) !== value) {
    throw new Error(`'${value}' is not a valid sequence number.`);
  }
  return seq;
}

/** The rule-shaping flags `automations create` and `automations update` share. */
function ruleFlags(command: Command): Command {
  return command
    .option('--file <path>', "a JSON rule, or the output of 'automations get' ('-' for stdin)")
    .option('--name <name>', 'the rule name')
    .option('--scope <itemId|none>', 'only items under this container (none clears it)')
    .option('--schedule <freq>', 'trigger on a schedule: daily | weekly | monthly')
    .option('--at <HH:mm>', 'schedule time, or the time a date-only value arrives')
    .option('--every <n>', 'schedule interval (1-366, default 1)')
    .option('--weekdays <days>', 'weekly schedule days: comma-separated mo,tu,we,th,fr,sa,su')
    .option('--time-zone <iana>', 'schedule zone (default: yours)')
    .option('--start <yyyy-mm-dd>', 'first day of the schedule')
    .option('--when-date <key>', 'trigger when a date property arrives, e.g. due_date')
    .option('--offset <minutes>', 'fire this many minutes after (negative: before) the date')
    .option('--when-changed <key>', 'trigger when a property changes')
    .option('--from <value>', 'only when it changes from this value')
    .option('--to <value>', 'only when it changes to this value')
    .option(
      '--if <key=value|key!=value>',
      'condition on the triggering item (repeatable)',
      collectOptional,
    )
    .option('--if-empty <key>', 'condition: the property is empty (repeatable)', collectOptional)
    .option('--if-set <key>', 'condition: the property is set (repeatable)', collectOptional)
    .option('--notify <title>', 'action: notify you; {date} and {item.title} are filled in')
    .option('--notify-body <body>', 'the notification body')
    .option(
      '--set <key=value>',
      'action: set a property on the triggering item (repeatable)',
      collectOptional,
    )
    .option('--set-item <itemId>', 'set the --set properties on this item instead')
    .option('--create <title>', 'action: create an item with this title')
    .option('--create-type <type>', 'the created item type (default note)')
    .option('--create-under <triggering_item|scope|itemId>', 'where the item is created')
    .option(
      '--create-prop <key=value>',
      'a property of the created item (repeatable)',
      collectOptional,
    );
}

/** Like {@link collectOption}, but absent (undefined) until the flag is first given. */
function collectOptional(value: string, previous: string[] | undefined): string[] {
  return [...(previous ?? []), value];
}

function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parseTemplateInputPairs(entries: readonly string[]): Readonly<Record<string, string>> {
  const values: Record<string, string> = {};
  for (const entry of entries) {
    const separator = entry.indexOf('=');
    if (separator < 1) {
      throw new Error(`Template input '${entry}' must use key=value syntax.`);
    }
    const key = entry.slice(0, separator);
    if (Object.hasOwn(values, key)) {
      throw new Error(`Template input '${key}' was supplied more than once.`);
    }
    values[key] = entry.slice(separator + 1);
  }
  if (Object.keys(values).length > 100) {
    throw new Error('A template accepts at most 100 inputs.');
  }
  return values;
}

interface ImportCliOptions {
  readonly workspace: string;
  readonly parent?: string;
  readonly dryRun?: boolean;
}

interface SeedCliOptions {
  readonly workspace: string;
  readonly count: number;
  readonly parent?: string;
  readonly titlePrefix?: string;
  readonly type?: string;
  readonly prop?: readonly string[];
}

interface RunCliOptions {
  readonly scenario: string;
  readonly iterations?: number;
  readonly create?: boolean;
  readonly clients?: number;
  readonly edits?: number;
  readonly intervalMs?: number;
  readonly item?: string;
  readonly workspace?: string;
  readonly pageSize?: number;
  readonly query?: string;
  readonly limit?: number;
  readonly view?: string;
  readonly today?: string;
}

interface LoginOptions {
  readonly apiUrl: string;
  readonly token?: string;
  readonly browserUrl?: string;
  readonly browser?: boolean;
  readonly collabUrl?: string;
  readonly mediaUrl?: string;
  /** commander sets this false when `--no-default` is passed. */
  readonly default?: boolean;
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
