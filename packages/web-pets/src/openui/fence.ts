/** The fence the pet writes generated UI in, and the one a saved artifact's body holds. */
export const OPENUI_LANGUAGE = 'openui-lang';

/** The first `openui-lang` program in a Markdown body, or null when it has none. */
export function programIn(markdown: string): string | null {
  const match = /^```openui-lang[^\n]*\n([\s\S]*?)^```\s*$/m.exec(markdown);
  return match?.[1] ?? null;
}

/** One generated-UI block in a reply: a whole program, or a patch (` ```openui-lang patch `) that
 * changes only some statements of the program before it. */
export interface ProgramPiece {
  readonly patch: boolean;
  readonly source: string;
}

/** Whether a code block's info string is generated UI, and if so whether it is a patch. */
export function pieceKind(info: string | null): 'program' | 'patch' | null {
  const [language, ...rest] = (info ?? '').trim().split(/\s+/);
  if (language !== OPENUI_LANGUAGE) return null;
  return rest.join(' ') === 'patch' ? 'patch' : 'program';
}

/** Every generated-UI block in a Markdown text, in order. Dependency-free, so a conversation can
 * collect them without loading the renderer. */
export function programPieces(markdown: string): ProgramPiece[] {
  const pieces: ProgramPiece[] = [];
  for (const match of markdown.matchAll(/^```([^\n]*)\n([\s\S]*?)^```\s*$/gm)) {
    const kind = pieceKind(match[1] ?? null);
    if (kind !== null) pieces.push({ patch: kind === 'patch', source: match[2] ?? '' });
  }
  return pieces;
}

/** For each message, the generated-UI blocks that came before it in the assistant's replies. */
export function earlierPieces(
  messages: readonly { readonly role: string; readonly text: string }[],
): (readonly ProgramPiece[])[] {
  const before: (readonly ProgramPiece[])[] = [];
  let pieces: readonly ProgramPiece[] = [];
  for (const message of messages) {
    before.push(pieces);
    if (message.role === 'assistant') pieces = [...pieces, ...programPieces(message.text)];
  }
  before.push(pieces);
  return before;
}

/** A program as the Markdown an artifact body stores. */
export function fenced(program: string): string {
  return `\`\`\`${OPENUI_LANGUAGE}\n${program.trimEnd()}\n\`\`\`\n`;
}

/** What a block's runtime state may be persisted as: the renderer's own state map, bounded so one
 * component cannot fill an item's property budget (Core caps all properties at 32 KB). */
export const STATE_LIMIT = 16 * 1024;

export function storableState(state: Record<string, unknown>): string | null {
  const text = JSON.stringify(state);
  return text.length <= STATE_LIMIT ? text : null;
}

/** The fence an artifact's saved values sit in, beside its program in the same body: so a lock
 * protects them with the program, note history keeps them, and saving them is an edit of the body
 * under the same collab permissions. An item property would be served with the envelope, which a
 * lock does not withhold. */
export const STATE_LANGUAGE = 'openui-state';

/** An artifact body's saved values: the text of its `openui-state` block and the map it holds, or
 * null when it has none (or none that parses as an object). */
export function stateIn(
  markdown: string,
): { readonly text: string; readonly values: Record<string, unknown> } | null {
  const match = /^```openui-state[^\n]*\n([\s\S]*?)^```\s*$/m.exec(markdown);
  const text = match?.[1]?.trimEnd();
  if (text === undefined) return null;
  try {
    const values: unknown = JSON.parse(text);
    return typeof values === 'object' && values !== null && !Array.isArray(values)
      ? { text, values: values as Record<string, unknown> }
      : null;
  } catch {
    return null;
  }
}

/** Saved values as the Markdown block an artifact body stores. */
export function fencedState(text: string): string {
  return `\`\`\`${STATE_LANGUAGE}\n${text}\n\`\`\`\n`;
}
