import { useMemo } from 'react';
import { programPieces, type ProgramPiece } from '../../../openui/fence';

type Pieces = readonly ProgramPiece[];
interface Turn {
  readonly role: string;
  readonly text: string;
}

/** What the last call saw and produced: `before[i]` is the pieces ahead of message `i`. */
interface Last {
  readonly turns: readonly Turn[];
  readonly before: readonly Pieces[];
}

// shortcut: one shared last result, diffed by content so any chat instance can reuse it; upgrade
// to per-instance state if two chats ever stream at once and thrash it.
const last = new Map<'turns', Last>();

/** `earlierPieces` for the chat, reparsing only from the first message whose role or text changed.
 * The watch hands over new message objects up to four times a second; earlier replies keep their
 * parsed arrays, so their document trees are not rebuilt and their fences are not reparsed. */
export function useStablePieces(messages: readonly Turn[]): readonly Pieces[] {
  return useMemo(() => {
    const previous = last.get('turns');
    let same = 0;
    if (previous) {
      const limit = Math.min(previous.turns.length, messages.length);
      while (
        same < limit &&
        previous.turns[same]?.role === messages[same]?.role &&
        previous.turns[same]?.text === messages[same]?.text
      ) {
        same += 1;
      }
    }
    const before: Pieces[] = previous ? previous.before.slice(0, same + 1) : [[]];
    let pieces: Pieces = before[same] ?? [];
    for (let index = same; index < messages.length; index += 1) {
      const message = messages[index];
      if (message?.role === 'assistant') {
        const added = programPieces(message.text);
        if (added.length > 0) pieces = [...pieces, ...added];
      }
      before.push(pieces);
    }
    last.set('turns', { turns: messages.map(({ role, text }) => ({ role, text })), before });
    return before;
  }, [messages]);
}
