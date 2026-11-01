import type { Command } from 'commander';
import { getSchema, readStructureOutline, setSchema } from './structure.ts';
import {
  blueprintBuild,
  blueprintCatalog,
  blueprintDescribe,
  blueprintSave,
  blueprintValidate,
} from './blueprint.ts';
import { type Act } from './shared.ts';

export function registerStructureCommands(program: Command, act: Act): void {
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
}
