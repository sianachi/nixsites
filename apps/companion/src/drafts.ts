import { createHash } from 'node:crypto';

import type { Message } from './types.ts';
import { byteLen, truncateUtf8 } from './util.ts';

/**
 * The combined length of every streaming draft message in one conversation (normally one, but a
 * turn can produce more than one agent-message item). Each draft is also capped at 32000 bytes.
 */
export const MAX_TOTAL_DRAFT_BYTES = 64000;
const MAX_DRAFT_BYTES = 32000;

export const isDraft = (m: Message): boolean => m.id.includes(':draft:');

/** Streaming drafts are in-memory progress only; only the final message is durable. */
export const withoutDrafts = (messages: Message[]): Message[] =>
  messages.filter((m) => !isDraft(m));

/** The one streaming draft for an item within a turn: stable across deltas, distinct across items. */
export function draftId(requestId: string, itemId: string): string {
  return `${requestId}:draft:${createHash('sha256').update(itemId).digest('hex').slice(0, 32)}`;
}

/** Keeps at most `limit` non-draft messages, dropping the oldest first; drafts are never counted. */
export function trimMessages(messages: Message[], limit: number): Message[] {
  const real = messages.filter((m) => !isDraft(m)).length;
  if (real <= limit) return messages;
  let drop = real - limit;
  return messages.filter((m) => {
    if (drop > 0 && !isDraft(m)) {
      drop--;
      return false;
    }
    return true;
  });
}

export function draftBytes(messages: Message[]): number {
  return messages.filter(isDraft).reduce((total, m) => total + byteLen(m.text), 0);
}

/** Appends one delta to the item's draft (starting it if needed), within both caps. Returns whether it changed. */
export function applyDelta(
  messages: Message[],
  requestId: string,
  itemId: string,
  delta: string,
): boolean {
  if (itemId === '' || byteLen(itemId) > 200 || delta === '') return false;
  const id = draftId(requestId, itemId);
  const index = messages.findIndex((m) => m.id === id);
  const total = draftBytes(messages);
  if (total >= MAX_TOTAL_DRAFT_BYTES) return false;
  const existing = messages[index];
  if (existing === undefined) {
    messages.push({
      id,
      role: 'assistant',
      text: truncateUtf8(delta, Math.min(MAX_DRAFT_BYTES, MAX_TOTAL_DRAFT_BYTES - total)),
    });
    return true;
  }
  const remaining = Math.min(
    MAX_DRAFT_BYTES - byteLen(existing.text),
    MAX_TOTAL_DRAFT_BYTES - total,
  );
  if (remaining <= 0) return false;
  existing.text += truncateUtf8(delta, remaining);
  return true;
}
