import type { Command } from 'commander';
import { messageDirectory, messageInbox, messageStatus, postMessage } from './messages.ts';
import { collectOption } from './program-support.ts';
import { type Act } from './shared.ts';

export function registerMessageCommands(program: Command, act: Act): void {
  const message = program
    .command('message')
    .description('Messages under an item, to people, your own pets and your own agents.');

  message
    .command('post <itemId>')
    .description(
      'Post a message under an item, or a reply under a message. Addressing a pet or an agent needs a token with the agents scope.',
    )
    .requiredOption('--text <text>', 'the message')
    .option(
      '--to <addressee>',
      'person:<id>, pet:<id> or agent:<id>; repeat for more',
      collectOption,
      [],
    )
    .action((itemId: string, options: { text: string; to: string[] }, command: Command) =>
      act(command, (profile, output) => postMessage(profile, itemId, options, output)),
    );

  message
    .command('directory <itemId>')
    .description(
      'Who a message under this item can address (people who can read it, and your pets and agents).',
    )
    .option('--query <text>', 'filter by name')
    .action((itemId: string, options: { query?: string }, command: Command) =>
      act(command, (profile, output) => messageDirectory(profile, itemId, options.query, output)),
    );

  message
    .command('inbox')
    .description(
      'The unread messages addressed to this agent token, newest first, with their thread and parent item. Needs a token with the agents scope.',
    )
    .option('--after <messageId>', 'the "next" of the previous page')
    .option('--limit <n>', 'messages per page, 1 to 100')
    .option('--mark-read', 'mark the messages returned as read')
    .action((options: { after?: string; limit?: string; markRead?: boolean }, command: Command) =>
      act(command, (profile, output) => messageInbox(profile, options, output)),
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
