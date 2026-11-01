import type { Command } from 'commander';
import { downloadFile, listFileVersions, probeFile, uploadFile } from './files.ts';
import { type Act } from './shared.ts';

export function registerFileCommands(program: Command, act: Act): void {
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
}
