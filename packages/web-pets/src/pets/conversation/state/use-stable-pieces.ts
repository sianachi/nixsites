import { useMemo } from 'react';
import { earlierPieces, type ProgramPiece } from '../../../openui/fence';

type Pieces = readonly ProgramPiece[];

// shortcut: one shared cache of piece lists by content, cleared past 200 entries; upgrade if a
// chat ever holds more distinct generated-UI histories than that.
const cache = new Map<string, Pieces>();

/** `earlierPieces` for the chat, keeping each message's array identity while its content is
 * unchanged. The watch hands over new message objects up to four times a second; without this
 * every reply's document tree would be rebuilt for a new array of the same pieces. */
export function useStablePieces(
  messages: readonly { readonly role: string; readonly text: string }[],
): readonly Pieces[] {
  return useMemo(() => {
    if (cache.size > 200) cache.clear();
    return earlierPieces(messages).map((pieces) => {
      const key = JSON.stringify(pieces);
      const known = cache.get(key);
      if (known) return known;
      cache.set(key, pieces);
      return pieces;
    });
  }, [messages]);
}
