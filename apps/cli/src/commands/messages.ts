/**
 * `nixctl message post|directory|status`: messages under an item, from a token or a sign-in.
 *
 * A message that addresses a pet needs a token with the pets:send scope and the workspace's "agents
 * may address pets" switch; the answer says where each pet's turn stands and carries the poster's
 * pet budget. Addressees are explicit, as `person:<id>` or `pet:<id>`; the text is never parsed.
 */

import {
  items,
  messages,
  type MessageDirectory,
  type MessagePetStates,
  type PostedMessage,
} from '@nix/api-client';
import { assertTokenSession } from './agent-records.ts';
import { parseUuid, resolveSession, type SessionDeps } from './shared.ts';
import { printResult, type OutputOptions } from '../output.ts';
import type { Session } from '../session.ts';

/** `person:<uuid>` or `pet:<uuid>` into an addressee. */
export function parseAddressee(value: string): { id: string; kind: 'person' | 'pet' } {
  const [kind, id] = value.split(':', 2);
  if ((kind !== 'person' && kind !== 'pet') || id === undefined)
    throw new Error(`Address "${value}" as person:<id> or pet:<id>.`);
  return { id: parseUuid(id, '--to'), kind };
}

export async function executePostMessage(
  session: Session,
  parentId: string,
  input: { readonly text: string; readonly to?: readonly string[] | undefined },
): Promise<PostedMessage> {
  const to = (input.to ?? []).map(parseAddressee);
  // Core treats a browser-approved login as a person, who may address pets with no scope, cap or approval.
  if (to.some((address) => address.kind === 'pet')) assertTokenSession(session, 'Addressing a pet');
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
