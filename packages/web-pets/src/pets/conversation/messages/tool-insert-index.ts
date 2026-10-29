import { type PetConnection } from '@nix/api-client';

/** Where the latest turn's tool rows belong among `messages`: right after the last user
 * message and any commentary that followed it (id contains `:commentary:`), and before that
 * turn's final answer (id `${lastUserMessageId}:assistant`) or its still-streaming draft (id
 * contains `:draft:`) - or at the very end when neither has arrived yet. The worker resets
 * `tools` on every send (`manager.go` `c.Tools = []ToolCall{}`), so every tool call in the
 * runtime belongs to this one turn; earlier turns render with no tool rows at all. */
export function toolInsertIndex(
  messages: readonly NonNullable<PetConnection['messages']>[number][],
): number {
  let lastUserIndex = -1;
  for (let index = 0; index < messages.length; index += 1) {
    if (messages[index]?.role === 'user') lastUserIndex = index;
  }
  if (lastUserIndex === -1) return messages.length;
  let index = lastUserIndex + 1;
  while (index < messages.length && messages[index]?.id.includes(':commentary:')) index += 1;
  return index;
}
