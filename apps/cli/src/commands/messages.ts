/**
 * `nixctl message post|directory|status|inbox`: messages under an item, from a token or a sign-in.
 *
 * A message that addresses a pet or an agent needs a token with the agents scope (a pet also needs the
 * workspace's "agents may address pets" switch); the answer says where each pet's turn stands and carries
 * the poster's pet budget. Addressees are explicit, as `person:<id>`, `pet:<id>` or `agent:<id>`; the text
 * is never parsed. An agent token reads what was addressed to it with `inbox` and marks it read.
 */

import {
  items,
  messages,
  type MarkMessagesRead,
  type MessageDirectory,
  type MessageInbox,
  type MessagePetStates,
  type PostedMessage,
} from '@nix/api-client';
import { assertTokenSession } from './agent-records.ts';
import { parseUuid, resolveSession, type SessionDeps } from './shared.ts';
import { printResult, type OutputOptions } from '../output.ts';
import type { Session } from '../session.ts';

/** `person:<uuid>`, `pet:<uuid>` or `agent:<uuid>` into an addressee. */
export function parseAddressee(value: string): { id: string; kind: 'person' | 'pet' | 'agent' } {
  const [kind, id] = value.split(':', 2);
  if ((kind !== 'person' && kind !== 'pet' && kind !== 'agent') || id === undefined)
    throw new Error(`Address "${value}" as person:<id>, pet:<id> or agent:<id>.`);
  return { id: parseUuid(id, '--to'), kind };
}

export async function executePostMessage(
  session: Session,
  parentId: string,
  input: { readonly text: string; readonly to?: readonly string[] | undefined },
): Promise<PostedMessage> {
  const to = (input.to ?? []).map(parseAddressee);
  // Core treats a browser-approved login as a person, who may address pets with no scope, cap or approval.
  if (to.some((address) => address.kind !== 'person'))
    assertTokenSession(session, 'Addressing a pet or an agent');
  const parent = await session.client.query(items.itemById(parentId), { forceRefresh: true });
  return session.client.execute(
    messages.post(parent.workspaceId, parentId, { text: input.text, to }),
  );
}

export const executeMessageDirectory = (
  session: Session,
  itemId: string,
  query?: string,
): Promise<MessageDirectory> =>
  session.client.query(messages.directory(itemId, query), { forceRefresh: true });

export const executeMessageStatus = (
  session: Session,
  messageId: string,
): Promise<MessagePetStates> =>
  session.client.query(messages.petTurns(messageId), { forceRefresh: true });

/** The calling agent token's unread messages; `markRead` marks the ones returned as read afterwards. */
export async function executeMessageInbox(
  session: Session,
  options: {
    readonly after?: string | undefined;
    readonly limit?: number | undefined;
    readonly markRead?: boolean | undefined;
  },
): Promise<MessageInbox & { readonly marked?: number }> {
  assertTokenSession(session, 'Reading an agent inbox');
  const inbox = await session.client.query(
    messages.inbox({
      ...(options.after ? { after: parseUuid(options.after, '--after') } : {}),
      ...(options.limit ? { limit: options.limit } : {}),
    }),
    { forceRefresh: true },
  );
  if (!options.markRead || inbox.messages.length === 0) return inbox;
  const { marked } = await executeMarkRead(
    session,
    inbox.messages.map((message) => message.messageId),
  );
  return { ...inbox, marked };
}

export const executeMarkRead = async (
  session: Session,
  messageIds: readonly string[],
): Promise<MarkMessagesRead> => {
  assertTokenSession(session, 'Marking an inbox message read');
  return session.client.execute(
    messages.markRead(messageIds.map((id) => parseUuid(id, 'messageId'))),
  );
};

export async function messageInbox(
  profileName: string | undefined,
  options: {
    readonly after?: string | undefined;
    readonly limit?: string | undefined;
    readonly markRead?: boolean | undefined;
  },
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const limit = options.limit === undefined ? undefined : Number(options.limit);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100))
    throw new Error('--limit is 1 to 100.');
  const session = await resolveSession(profileName, deps);
  printResult(await executeMessageInbox(session, { ...options, limit }), output);
}

export async function postMessage(
  profileName: string | undefined,
  parentId: string,
  input: { readonly text: string; readonly to?: readonly string[] | undefined },
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const session = await resolveSession(profileName, deps);
  printResult(await executePostMessage(session, parentId, input), output);
}

export async function messageDirectory(
  profileName: string | undefined,
  itemId: string,
  query: string | undefined,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const session = await resolveSession(profileName, deps);
  printResult(await executeMessageDirectory(session, itemId, query), output);
}

export async function messageStatus(
  profileName: string | undefined,
  messageId: string,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const session = await resolveSession(profileName, deps);
  printResult(await executeMessageStatus(session, messageId), output);
}
