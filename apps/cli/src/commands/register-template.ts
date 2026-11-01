import type { Command } from 'commander';
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
} from './templates.ts';
import { parseInteger, collectOption, parseTemplateInputPairs } from './program-support.ts';
import { type Act } from './shared.ts';

export function registerTemplateCommands(program: Command, act: Act): void {
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
}
