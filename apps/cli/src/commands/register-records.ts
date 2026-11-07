/**
 * Records, references, file lifecycle, expiry, public links and attachments: the CLI face of the
 * agent tools in mcp-records.ts. Every command prints JSON like the rest of nixctl and shares its
 * implementation with the MCP tools through ./agent-records.ts.
 */

import type { Command } from 'commander';
import {
  agentRecords,
  attachments,
  references,
  structure,
  type FileVersionState,
} from '@nix/api-client';
import type { Session } from '../session.ts';
import { printResult, type OutputOptions } from '../output.ts';
import {
  assertRowsRetrySafe,
  assertTokenSession,
  describeBatchFailures,
  EXPIRY_KEY,
  exportToFileValue,
  lookupByProperty,
  queryWorkspace,
  readBatchFile,
} from './agent-records.ts';
import { collect } from './program-support.ts';
import { resolveSession, type Act, type SessionDeps } from './shared.ts';
import { parseAssignments } from './structure.ts';

/** Opens the session, runs `body`, prints what it returns. */
export async function withSession(
  profile: string | undefined,
  output: OutputOptions,
  deps: SessionDeps,
  body: (session: Session) => Promise<unknown>,
): Promise<void> {
  printResult(await body(await resolveSession(profile, deps)), output);
}

/** `key=value` with a plain text value: an exact lookup never reinterprets what it is given. */
function splitPair(pair: string): { key: string; value: string } {
  const eq = pair.indexOf('=');
  if (eq <= 0) throw new Error(`Expected key=value, got '${pair}'.`);
  return { key: pair.slice(0, eq), value: pair.slice(eq + 1) };
}

/** `property:operator[:value]`; the value may itself contain colons (a URL). */
export function parseFilter(text: string): { property: string; operator: string; value?: string } {
  const first = text.indexOf(':');
  if (first <= 0) throw new Error(`Expected property:operator[:value], got '${text}'.`);
  const second = text.indexOf(':', first + 1);
  const property = text.slice(0, first);
  if (second === -1) return { property, operator: text.slice(first + 1) };
  return { property, operator: text.slice(first + 1, second), value: text.slice(second + 1) };
}

export async function runBatch(
  profile: string | undefined,
  options: { workspace: string; file: string; strict?: boolean | undefined },
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const { rows, strict } = await readBatchFile(options.file);
  assertRowsRetrySafe(rows);
  const session = await resolveSession(profile, deps);
  const result = await session.client.execute(
    agentRecords.batchRecords(options.workspace, rows, options.strict ?? strict ?? true),
  );
  printResult(result, output);
  const failure = describeBatchFailures(result);
  if (failure !== undefined) {
    process.stderr.write(`${failure}\n`);
    process.exitCode = 1;
  }
}

export function registerRecordCommands(program: Command, act: Act): void {
  const record = program.command('record').description('Create and update structured records.');
  record
    .command('upsert <parentId>')
    .description(
      'Create or update one record in a collection, keyed by a unique field. Prints created, updated or unchanged.',
    )
    .requiredOption(
      '--key <field=value>',
      'the unique field and the record value, e.g. url=https://example.com/a',
    )
    .option('--title <title>', 'the title')
    .option('--type <type>', 'the item type when it is created')
    .option(
      '--prop <key=value>',
      'a property value (JSON when it parses, else text); repeatable',
      collect,
      [],
    )
    .option('--idempotency-key <key>', 'a retry with the same key replays the first answer')
    .option('--no-strict', 'accept properties the schema does not declare')
    .action(
      (
        parentId: string,
        options: {
          key: string;
          title?: string;
          type?: string;
          prop: string[];
          idempotencyKey?: string;
          strict: boolean;
        },
        command: Command,
      ) =>
        act(command, (profile, output) =>
          withSession(profile, output, {}, (session) => {
            const key = splitPair(options.key);
            return session.client.execute(
              agentRecords.upsertRecord(parentId, {
                keyField: key.key,
                keyValue: key.value,
                title: options.title,
                type: options.type,
                properties: options.prop.length === 0 ? undefined : parseAssignments(options.prop),
                idempotencyKey: options.idempotencyKey,
                strict: options.strict,
              }),
            );
          }),
        ),
    );
  record
    .command('batch')
    .description(
      'Write up to 100 records from a JSON file (an array of rows, or { "rows": [...], "strict": true }). ' +
        'Exits non-zero when any row failed, naming each; the good rows are kept.',
    )
    .requiredOption('--workspace <id>', 'the workspace')
    .requiredOption('--file <path>', 'the rows file')
    .option('--no-strict', 'accept properties the schema does not declare')
    .action((options: { workspace: string; file: string; strict: boolean }, command: Command) =>
      act(command, (profile, output) => runBatch(profile, options, output)),
    );

  const ref = program
    .command('ref')
    .description('References and exact-version pins between items.');
  ref
    .command('add <holderId> <targetId>')
    .description('Reference an item from a record; with --version, pin that approved file version.')
    .option('--version <id>', 'pin this approved file version of the target')
    .option('--role <role>', 'free-text role such as organisation or contact')
    .action(
      (
        holderId: string,
        targetId: string,
        options: { version?: string; role?: string },
        command: Command,
      ) =>
        act(command, (profile, output) =>
          withSession(profile, output, {}, (session) =>
            session.client.execute(
              agentRecords.addReference(holderId, {
                targetItemId: targetId,
                targetFileVersionId: options.version,
                role: options.role,
              }),
            ),
          ),
        ),
    );
  ref
    .command('rm <holderId> <referenceId>')
    .description('Remove a reference or pin.')
    .action((holderId: string, referenceId: string, _options: unknown, command: Command) =>
      act(command, (profile, output) =>
        withSession(profile, output, {}, async (session) => {
          await session.client.execute(agentRecords.removeReference(holderId, referenceId));
          return { id: referenceId, removed: true };
        }),
      ),
    );
  ref
    .command('ls <itemId>')
    .description('List what a record references and pins.')
    .option('--limit <n>', 'page size', Number)
    .action((itemId: string, options: { limit?: number }, command: Command) =>
      act(command, (profile, output) =>
        withSession(profile, output, {}, (session) =>
          session.client.query(agentRecords.listReferences(itemId, options.limit)),
        ),
      ),
    );
  ref
    .command('used-by <itemId>')
    .description('List the records that reference or pin this item.')
    .option('--limit <n>', 'page size', Number)
    .action((itemId: string, options: { limit?: number }, command: Command) =>
      act(command, (profile, output) =>
        withSession(profile, output, {}, (session) =>
          session.client.query(agentRecords.listReferencedBy(itemId, options.limit)),
        ),
      ),
    );

  const link = program.command('link').description('Public links for notes and files.');
  link
    .command('get <itemId>')
    .description('Show the active public link, if any.')
    .action((itemId: string, _options: unknown, command: Command) =>
      act(command, (profile, output) =>
        withSession(profile, output, {}, (session) =>
          session.client.query(attachments.getPublicLink(itemId)),
        ),
      ),
    );
  link
    .command('create <itemId>')
    .description('Create the public link; anyone with the url can read it. Needs --yes.')
    .option('--version <id>', 'the file version to serve (default: latest approved)')
    .option('--yes', 'confirm making this public', false)
    .action((itemId: string, options: { version?: string; yes?: boolean }, command: Command) =>
      act(command, (profile, output) =>
        withSession(profile, output, {}, (session) => {
          if (options.yes !== true) throw new Error('Pass --yes to confirm making this public.');
          assertTokenSession(session, 'Creating a public link');
          return session.client.execute(attachments.createPublicLink(itemId, options.version));
        }),
      ),
    );
  link
    .command('revoke <itemId>')
    .description('Revoke the public link. New downloads stop within 60 seconds.')
    .action((itemId: string, _options: unknown, command: Command) =>
      act(command, (profile, output) =>
        withSession(profile, output, {}, async (session) => {
          await session.client.execute(attachments.revokePublicLink(itemId));
          return { itemId, revoked: true };
        }),
      ),
    );
}

/** Subcommands that belong to existing groups (`item`, `file`, `note`). */
export function registerRecordExtensions(program: Command, act: Act): void {
  const sub = (name: string): Command => {
    const found = program.commands.find((command) => command.name() === name);
    if (found === undefined) throw new Error(`The ${name} command group is not registered.`);
    return found;
  };

  sub('item')
    .command('find')
    .description('Exact lookup of items by a property value (no full-text search).')
    .requiredOption('--workspace <id>', 'the workspace')
    .requiredOption('--prop <key=value>', 'the property and exact value to match')
    .option('--parent <id>', 'only within this collection')
    .action((options: { workspace: string; prop: string; parent?: string }, command: Command) =>
      act(command, (profile, output) =>
        withSession(profile, output, {}, (session) => {
          const pair = splitPair(options.prop);
          return lookupByProperty(session, {
            workspaceId: options.workspace,
            key: pair.key,
            value: pair.value,
            parentId: options.parent,
          });
        }),
      ),
    );
  sub('item')
    .command('backlinks <itemId>')
    .description('List the documents whose body links to this item.')
    .option('--limit <n>', 'maximum rows', Number)
    .action((itemId: string, options: { limit?: number }, command: Command) =>
      act(command, (profile, output) =>
        withSession(profile, output, {}, (session) =>
          session.client.query(references.listBacklinks(itemId, options.limit)),
        ),
      ),
    );
  sub('item')
    .command('expire <itemId>')
    .description('Set when an item moves to the trash, or clear it. Restoring clears the date.')
    .option('--at <iso>', 'a future time with its offset, such as 2027-04-02T17:00:00Z')
    .option('--clear', 'remove the expiry', false)
    .action((itemId: string, options: { at?: string; clear?: boolean }, command: Command) =>
      act(command, (profile, output) =>
        withSession(profile, output, {}, (session) => {
          if ((options.at === undefined) === (options.clear !== true))
            throw new Error('Pass exactly one of --at <iso> or --clear.');
          return session.client.execute(
            structure.setItemProperties(itemId, {
              [EXPIRY_KEY]: options.clear === true ? null : (options.at ?? null),
            }),
          );
        }),
      ),
    );

  const file = sub('file');
  file
    .command('state <itemId> <versionId> <state>')
    .description(
      'Set a file version to draft, in_review, approved or revoked. Approve/revoke needs an access-token profile.',
    )
    .action(
      (itemId: string, versionId: string, state: string, _options: unknown, command: Command) =>
        act(command, (profile, output) =>
          withSession(profile, output, {}, (session) => {
            if (!['draft', 'in_review', 'approved', 'revoked'].includes(state))
              throw new Error('state must be draft, in_review, approved or revoked.');
            if (state === 'approved' || state === 'revoked')
              assertTokenSession(session, 'Approving or revoking a file version');
            return session.client.execute(
              attachments.setVersionState(itemId, versionId, state as FileVersionState),
            );
          }),
        ),
    );
  file
    .command('list')
    .description('List the workspace file items with the version each shows and its state.')
    .requiredOption('--workspace <id>', 'the workspace')
    .option('--state <state>', 'draft | in_review | approved | revoked')
    .option('--images', 'include images', false)
    .option('--expiring', 'only files with an expiry date', false)
    .option('--limit <n>', 'page size', Number)
    .option('--cursor <cursor>', 'continue from a previous page')
    .action(
      (
        options: {
          workspace: string;
          state?: string;
          images?: boolean;
          expiring?: boolean;
          limit?: number;
          cursor?: string;
        },
        command: Command,
      ) =>
        act(command, (profile, output) =>
          withSession(profile, output, {}, (session) =>
            session.client.query(
              attachments.listAttachments(options.workspace, {
                state: options.state as FileVersionState | undefined,
                includeImages: options.images === true ? true : undefined,
                expiring: options.expiring === true ? true : undefined,
                limit: options.limit,
                cursor: options.cursor,
              }),
            ),
          ),
        ),
    );

  sub('note')
    .command('export <itemId>')
    .description('Export a note to PDF, DOCX or Markdown as a draft file version, and wait for it.')
    .option('--to-file', 'save the export as a file item (required)', false)
    .option('--format <format>', 'pdf | docx | md', 'pdf')
    .option(
      '--target <fileItemId>',
      'add a version to this existing file instead of making a new one',
    )
    .action(
      (
        itemId: string,
        options: { toFile?: boolean; format: string; target?: string },
        command: Command,
      ) =>
        act(command, (profile, output) =>
          withSession(profile, output, {}, (session) => {
            if (options.toFile !== true)
              throw new Error(
                'Pass --to-file. To download an export instead, use `nixctl export`.',
              );
            return exportToFileValue(session, {
              itemId,
              format: options.format,
              targetItemId: options.target,
            });
          }),
        ),
    );
}

export interface FilterQueryOptions {
  readonly workspace: string;
  readonly parent?: string | undefined;
  readonly filter: readonly string[];
  readonly sort?: string | undefined;
  readonly limit?: number | undefined;
  readonly today?: string | undefined;
}

/** `nixctl query --workspace <id> --filter ...`: filter items by property across a workspace. */
export function runFilterQuery(
  profile: string | undefined,
  options: FilterQueryOptions,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  return withSession(profile, output, deps, (session) => {
    const [property = '', direction] = (options.sort ?? '').split(':');
    return queryWorkspace(session, {
      workspaceId: options.workspace,
      parentId: options.parent,
      filters: options.filter.length === 0 ? undefined : options.filter.map(parseFilter),
      sort: options.sort === undefined ? undefined : { property, descending: direction === 'desc' },
      limit: options.limit,
      today: options.today,
    });
  });
}
