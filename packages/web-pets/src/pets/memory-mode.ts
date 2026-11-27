import type { PetConnection, PetSettings } from '@nix/api-client';

/** How the pet may save memories; settings saved before the choice existed read as `ask`. */
export type PetMemoryMode = NonNullable<PetSettings['memoryMode']>;

export function memoryModeOf(settings: PetSettings): PetMemoryMode {
  return settings.memoryMode ?? 'ask';
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Where a fact saved in this chat was learned: the conversation, as the owner wrote it. Undefined before it has an item. */
export function conversationMemorySource(
  runtime: Pick<PetConnection, 'conversationId' | 'title'>,
): { kind: 'conversation'; id: string; title: string; author: string } | undefined {
  const id = runtime.conversationId;
  if (!UUID.test(id)) return undefined;
  // Core refuses control and format characters, so a saved fact never fails over a title.
  const title = runtime.title
    .replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Cn}\u2028\u2029]/gu, '')
    .slice(0, 100);
  return { kind: 'conversation' as const, id, title, author: 'You' };
}
