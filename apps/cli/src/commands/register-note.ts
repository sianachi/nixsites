import type { Command } from 'commander';
import { readNote, writeNote } from './notes.ts';
import { readCanvas, writeCanvas } from './canvas.ts';
import {
  listHistory,
  listHistoryVersions,
  nameHistoryVersion,
  restoreHistory,
  showHistory,
} from './history.ts';
import { runQuery } from './query.ts';
import { runFilterQuery } from './register-records.ts';
import { getViews, inspectViews, setViews } from './views.ts';
import { collect, parseInteger, parseSeqArg } from './program-support.ts';
import type { ConfirmCliOptions } from './program-support.ts';
import { type Act } from './shared.ts';

export function registerNoteCommands(program: Command, act: Act): void {
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
    .addHelpText(
      'after',
      '\nExamples:\n  nixctl note write <itemId> --file body.md\n  cat body.md | nixctl note write <itemId>',
    )
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
    .command('query [itemId]')
    .description(
      "With an item: run one of a container's views and print the children it shows (--view, --today). " +
        'With --workspace: filter items by property across a workspace; rules are ANDed.',
    )
    .option('--view <viewId>', "which of the container's views to run")
    .option('--today <yyyy-mm-dd>', "the caller's own day, for relative rules")
    .option('--workspace <id>', 'filter across this workspace instead of running a view')
    .option('--parent <id>', 'with --workspace: only within this collection (its whole subtree)')
    .option(
      '--filter <property:operator[:value]>',
      'with --workspace, e.g. status:not-equals:retired (not-equals also matches records missing the field); repeatable',
      collect,
      [],
    )
    .option(
      '--sort <property[:desc]>',
      'with --workspace: order by a property, $created or $modified',
    )
    .option('--limit <n>', 'with --workspace: maximum rows (default 100, at most 500)', Number)
    .action(
      (
        itemId: string | undefined,
        options: {
          view?: string;
          today?: string;
          workspace?: string;
          parent?: string;
          filter: string[];
          sort?: string;
          limit?: number;
        },
        command: Command,
      ) =>
        act(command, (profile, output) => {
          if (options.workspace !== undefined)
            return runFilterQuery(profile, { ...options, workspace: options.workspace }, output);
          if (itemId === undefined || options.view === undefined || options.today === undefined)
            throw new Error(
              'Give an item with --view and --today, or use --workspace with --filter.',
            );
          return runQuery(profile, itemId, { view: options.view, today: options.today }, output);
        }),
    );
}
