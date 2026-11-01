import type { Command } from 'commander';
import { InvalidArgumentError } from 'commander';
import { runSearch } from './search.ts';
import { runExport } from './export.ts';
import { runImport } from './import.ts';
import {
  cancelDocumentImport,
  commitDocumentImport,
  getDocumentImport,
} from './document-import.ts';
import { printResult } from '../output.ts';
import type { ImportCliOptions } from './program-support.ts';
import { type Act } from './shared.ts';

export function registerSearchTransferCommands(program: Command, act: Act): void {
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
}
