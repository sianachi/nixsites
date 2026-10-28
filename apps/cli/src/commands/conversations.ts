import { readFile } from 'node:fs/promises';
import type { Command } from 'commander';
import {
  conversations,
  createConversationInputSchema,
  type CreateConversationInput,
  type Conversation,
  type ConversationMessages,
} from '@nix/api-client';
import type { Session } from '../session.ts';
import { printResult } from '../output.ts';
import { parseUuid, readStdin, resolveSession, type Act } from './shared.ts';

export function executeCreateConversation(
  session: Session,
  workspaceId: string,
  input: CreateConversationInput,
  importing = false,
): Promise<Conversation> {
  return session.client.execute(
    importing
      ? conversations.importTranscript(workspaceId, input)
      : conversations.create(workspaceId, input),
  );
}
export function executeConfigureConversation(
  session: Session,
  itemId: string,
  input: Parameters<typeof conversations.configure>[1],
): Promise<Conversation> {
  return session.client.execute(conversations.configure(itemId, input));
}
export function executeGetConversation(session: Session, itemId: string): Promise<Conversation> {
  return session.client.query(conversations.conversation(itemId), { forceRefresh: true });
}
export function executeConversationMessages(
  session: Session,
  itemId: string,
  options: { cursor?: string; limit?: number } = {},
): Promise<ConversationMessages> {
  return session.client.query(conversations.messages(itemId, options), { forceRefresh: true });
}
export function executeSendConversation(
  session: Session,
  itemId: string,
  input: Parameters<typeof conversations.send>[1],
): Promise<Conversation> {
  return session.client.execute(conversations.send(itemId, input));
}
export function executeWatchConversation(
  session: Session,
  itemId: string,
  after: number,
): Promise<Conversation> {
  return session.client.query(conversations.watch(itemId, after), { forceRefresh: true });
}
export function executeCancelConversation(session: Session, itemId: string): Promise<Conversation> {
  return session.client.execute(conversations.cancel(itemId));
}
export function executeConversationSources(
  session: Session,
  itemId: string,
  sourceWorkspaceIds: string[],
  expectedRevision: number,
): Promise<Conversation> {
  return session.client.execute(
    conversations.sources(itemId, sourceWorkspaceIds, expectedRevision),
  );
}

export function parseConversationInteger(value: string): number {
  const parsed = Number(value);
  if (value.trim() === '' || !Number.isSafeInteger(parsed) || parsed < 0)
    throw new Error('Expected a non-negative safe integer.');
  return parsed;
}

export function registerConversationCommands(program: Command, act: Act): void {
  const chat = program
    .command('chat')
    .description(
      'Create, read and continue durable conversation notes. Core checks source and destination access.',
    );
  const show = (command: Command, action: (session: Session) => Promise<unknown>) =>
    act(command, async (profile, output) => {
      printResult(await action(await resolveSession(profile)), output);
    });
  for (const operation of ['create', 'import']) {
    chat
      .command(`${operation} <workspaceId>`)
      .description(
        `${operation === 'import' ? 'Import a retained visible transcript as' : 'Create'} a chat note. The JSON file specifies title, parentId, petId, sourceWorkspaceIds and optional messages; saving shares these with the destination readers.`,
      )
      .requiredOption('--file <path>', 'conversation JSON file, or - for stdin')
      .option('--yes', 'confirm the transcript may be read by destination readers', false)
      .action(
        async (workspaceId: string, options: { file: string; yes: boolean }, command: Command) =>
          show(command, async (session) => {
            const input = createConversationInputSchema.parse(
              JSON.parse(
                options.file === '-' ? await readStdin() : await readFile(options.file, 'utf8'),
              ),
            );
            if ((input.messages?.length ?? 0) > 0 && !options.yes)
              throw new Error(
                'Saving a transcript shares it with destination readers. Inspect the destination and pass --yes to confirm.',
              );
            if (operation === 'import' && !input.messages?.length)
              throw new Error('Import needs a non-empty messages transcript.');
            return executeCreateConversation(
              session,
              parseUuid(workspaceId, 'workspaceId'),
              input,
              operation === 'import',
            );
          }),
      );
  }
  chat
    .command('get <itemId>')
    .description('Read conversation scope, permissions and active turn.')
    .action(async (id: string, _options: unknown, command: Command) =>
      show(command, (session) => executeGetConversation(session, parseUuid(id, 'itemId'))),
    );
  chat
    .command('messages <itemId>')
    .description('Read one page of saved messages.')
    .option('--cursor <cursor>', 'nextCursor from the previous page')
    .option('--limit <count>', 'page size, 1–100', parseConversationInteger, 50)
    .action(async (id: string, options: { cursor?: string; limit: number }, command: Command) =>
      show(command, (session) => {
        if (options.limit < 1 || options.limit > 100) throw new Error('--limit must be 1 to 100.');
        return executeConversationMessages(session, parseUuid(id, 'itemId'), options);
      }),
    );
  chat
    .command('send <itemId> <text>')
    .description('Start a read-only analysis turn. Reuse request-id when retrying the same send.')
    .requiredOption('--request-id <id>', 'stable UUID for this send and any retry')
    .option('--model <model>', 'provider model')
    .action(
      async (
        id: string,
        text: string,
        options: { requestId: string; model?: string },
        command: Command,
      ) =>
        show(command, (session) =>
          executeSendConversation(session, parseUuid(id, 'itemId'), {
            requestId: parseUuid(options.requestId, '--request-id'),
            text,
            ...(options.model === undefined ? {} : { model: options.model }),
          }),
        ),
    );
  chat
    .command('watch <itemId>')
    .description('Read a fresh revision snapshot; poll with its revision to follow progress.')
    .option('--after <revision>', 'last observed revision', parseConversationInteger, 0)
    .action(async (id: string, options: { after: number }, command: Command) =>
      show(command, (session) =>
        executeWatchConversation(session, parseUuid(id, 'itemId'), options.after),
      ),
    );
  chat
    .command('cancel <itemId>')
    .description('Cancel the active turn without deleting saved messages.')
    .action(async (id: string, _options: unknown, command: Command) =>
      show(command, (session) => executeCancelConversation(session, parseUuid(id, 'itemId'))),
    );
  chat
    .command('configure <itemId>')
    .description(
      'Configure a compatible existing note as a chat. Core validates its message fields.',
    )
    .requiredOption('--workspaces <ids>', 'comma-separated source workspace UUIDs')
    .requiredOption('--pet <id>', 'pet UUID')
    .action(async (id: string, options: { workspaces: string; pet: string }, command: Command) =>
      show(command, (session) =>
        executeConfigureConversation(session, parseUuid(id, 'itemId'), {
          sourceWorkspaceIds: options.workspaces
            .split(',')
            .map((value) => parseUuid(value.trim(), '--workspaces')),
          petId: parseUuid(options.pet, '--pet'),
        }),
      ),
    );
  chat
    .command('sources <itemId>')
    .description(
      'Replace source workspaces for future turns. Group membership does not change this scope.',
    )
    .requiredOption('--workspaces <ids>', 'comma-separated workspace UUIDs')
    .requiredOption(
      '--revision <revision>',
      'expected conversation revision',
      parseConversationInteger,
    )
    .action(
      async (id: string, options: { workspaces: string; revision: number }, command: Command) =>
        show(command, (session) =>
          executeConversationSources(
            session,
            parseUuid(id, 'itemId'),
            options.workspaces.split(',').map((value) => parseUuid(value.trim(), '--workspaces')),
            options.revision,
          ),
        ),
    );
}
