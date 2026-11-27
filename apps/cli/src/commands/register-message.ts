import type { Command } from 'commander';
import { messageDirectory, messageStatus, postMessage } from './messages.ts';
import { collectOption } from './program-support.ts';
import { type Act } from './shared.ts';

export function registerMessageCommands(program: Command, act: Act): void {
  const message = program
    .command('message')
    .description('Messages under an item, to people and your own pets.');

  message
    .command('post <itemId>')
    .description(
      'Post a message under an item, or a reply under a message. Addressing a pet needs a token with the pets:send scope.',
    )
    .requiredOption('--text <text>', 'the message')
    .option('--to <addressee>', 'person:<id> or pet:<id>; repeat for more', collectOption, [])
    .action((itemId: string, options: { text: string; to: string[] }, command: Command) =>
      act(command, (profile, output) => postMessage(profile, itemId, options, output)),
    );

  message
    .command('directory <itemId>')
    .description(
      'Who a message under this item can address (people who can read it, and your pets).',
    )
    .option('--query <text>', 'filter by name')
    .action((itemId: string, options: { query?: string }, command: Command) =>
      act(command, (profile, output) => messageDirectory(profile, itemId, options.query, output)),
    );

  message
    .command('status <messageId>')
    .description(
      'Where each pet the message addressed stands: pending, working, answered, failed, declined or expired.',
    )
    .action((messageId: string, _options: unknown, command: Command) =>
      act(command, (profile, output) => messageStatus(profile, messageId, output)),
    );
}
