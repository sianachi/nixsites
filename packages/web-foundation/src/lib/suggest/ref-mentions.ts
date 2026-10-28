/**
 * Where, in one block of text, the server's unlinked-mention matches actually are.
 *
 * **The server says what, the client says where.** `findMentions` answers "these items' titles
 * appear in this passage" with the phrase that matched, not an offset - and the passage the editor
 * sends is several blocks joined together, positions in which mean nothing once the document has
 * moved on. So each block finds its own occurrences, against its own current text, with the same
 * rule the server uses: a whole-word phrase, ignoring case.
 *
 * **Longest phrase first, no overlaps.** "Project Alpha Review" and "Project Alpha" both matching
 * the same words is one mention of the longer title; underlining both would offer two links for
 * one span. The server returns its matches longest first; this sorts again rather than relying on
 * that, so the rule holds whatever order they arrive in.
 *
 * Pure: text in, offsets out. Characters that are not prose in the editor (references, inline code,
 * hard breaks) are expected as U+FFFC, which is neither a letter nor a digit, so a phrase can
 * never run through one.
 */

/** An item whose title the server found in the text, with the phrase that matched. */
export interface MentionCandidate {
  readonly itemId: string;
  readonly title: string;
  readonly phrase: string;
}

/** One occurrence in the block's text: offsets, end exclusive, and what it names. */
export interface MentionRange extends MentionCandidate {
  readonly from: number;
  readonly to: number;
}

/** The most mentions underlined in one block; past it the block is a list of titles, not prose. */
export const MAX_MENTIONS_PER_BLOCK = 12;

/** Phrases shorter than this are not underlined: two letters match too much prose by accident. */
export const MIN_PHRASE_LENGTH = 3;

function escape(phrase: string): string {
  return phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Every whole-word, case-insensitive occurrence of each candidate's phrase, longest first. */
export function locateMentions(
  text: string,
  candidates: readonly MentionCandidate[],
  limit: number = MAX_MENTIONS_PER_BLOCK,
): MentionRange[] {
  const ordered = [...candidates]
    .filter((candidate) => candidate.phrase.trim().length >= MIN_PHRASE_LENGTH)
    .sort((a, b) => b.phrase.length - a.phrase.length || a.itemId.localeCompare(b.itemId));
  const found: MentionRange[] = [];
  for (const candidate of ordered) {
    const pattern = new RegExp(
      `(?<![\\p{L}\\p{N}])${escape(candidate.phrase)}(?![\\p{L}\\p{N}])`,
      'giu',
    );
    for (const match of text.matchAll(pattern)) {
      const from = match.index;
      const to = from + match[0].length;
      if (found.some((range) => from < range.to && to > range.from)) continue;
      found.push({ ...candidate, from, to });
      if (found.length >= limit) {
        return found.sort((a, b) => a.from - b.from);
      }
    }
  }
  return found.sort((a, b) => a.from - b.from);
}

/**
 * The candidates whose phrase occurs in `text` at all, each judged on its own - what a block's
 * cache entry keeps. Independently rather than after the overlap rule, because which of two
 * overlapping titles wins depends on what is excluded at the time (a longer title already linked
 * leaves the shorter one to underline).
 */
export function candidatesIn(
  text: string,
  candidates: readonly MentionCandidate[],
): MentionCandidate[] {
  return candidates.filter((candidate) => locateMentions(text, [candidate], 1).length > 0);
}
