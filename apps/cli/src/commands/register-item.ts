import type { Command } from 'commander';
import {
  createItem,
  deleteItem,
  getItem,
  listItems,
  moveItem,
  renameItem,
  restoreItem,
} from './items.ts';
import { closeLock, lockStatus, openLock, readPasswords, removeLock, setLock } from './locks.ts';
import { itemSettings, type ItemSettingsOptions } from './item-settings.ts';
import { protect, type ProtectionOptions } from './protection.ts';
import type {
  LsOptions,
  CreateItemOptions,
  MvOptions,
  WorkspaceOption,
} from './program-support.ts';
import { collect } from './program-support.ts';
import { parseAssignments } from './structure.ts';
import { readStdin, type Act } from './shared.ts';

export function registerItemCommands(program: Command, act: Act): void {
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
    .option(
      '--prop <key=value...>',
      'a property value (JSON when it parses, else text); repeatable',
      collect,
      [],
    )
    .option('--idempotency-key <key>', 'a retry with the same key returns the same item')
    .option('--strict', 'refuse undeclared properties and missing required ones (the default)')
    .option('--no-strict', 'accept properties the schema does not declare')
    .action((options: CreateItemOptions, command: Command) =>
      act(command, (profile, output) =>
        createItem(
          profile,
          {
            workspaceId: options.workspace,
            type: options.type,
            title: options.title,
            parentId: options.parent,
            properties: options.prop.length === 0 ? undefined : parseAssignments(options.prop),
            idempotencyKey: options.idempotencyKey,
            strict: options.strict ?? true,
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

  item
    .command('settings <itemId>')
    .description(
      "Switch an item's optional features on or off: comments, suggesting, file review " +
        'states and full width. All are off until switched on.',
    )
    .option('--comments <on|off>', 'whether people may comment on the item')
    .option('--suggesting <on|off>', 'whether the editor offers suggesting')
    .option('--review-states <on|off>', "whether a file's versions carry review states")
    .option('--full-width <on|off>', 'whether a note uses the full pane width')
    .action((itemId: string, options: ItemSettingsOptions, command: Command) =>
      act(command, (profile, output) => itemSettings(profile, itemId, options, output)),
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
}
