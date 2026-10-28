import { createHash } from 'node:crypto';

import { nixSchema } from '@nix/editor-schema';

/**
 * Note bodies cut into passages a pet can retrieve, so a note far longer than one tool reply
 * (and the notes under it) can still be asked about.
 *
 * A heading always starts a new chunk and blocks are packed up to {@link CHUNK_CHARS}, so a chunk
 * is one section or part of one. Each chunk carries its heading trail, which is what tells a
 * reader where a passage sits in a two-hundred-page note. There is deliberately no cap on the
 * number of chunks: the whole body is covered, unlike the search text, which stops at its
 * ceiling.
 */

/** The most characters packed into one chunk; a single larger block is sliced. */
export const CHUNK_CHARS = 1_500;

export interface NoteChunk {
  readonly ord: number;
  /** The heading trail above the passage, outermost first, joined with " › "; empty before the first heading. */
  readonly heading: string;
  readonly body: string;
  /** Identifies the text a stored embedding was computed from, so unchanged passages keep theirs. */
  readonly contentHash: string;
}

/**
 * Chunks a materialised note. Returns null for anything that is not a prose document this build
 * can parse, so the caller leaves existing chunks alone rather than erasing them.
 */
export function chunkNote(json: unknown): NoteChunk[] | null {
  if (typeof json !== 'object' || json === null || (json as { type?: unknown }).type !== 'doc') {
    return null;
  }
  let document;
  try {
    document = nixSchema.nodeFromJSON(json);
  } catch {
    return null;
  }

  const chunks: NoteChunk[] = [];
  const trail: string[] = [];
  let heading = '';
  let parts: string[] = [];
  let size = 0;

  const flush = (): void => {
    if (size === 0) return;
    const body = parts.join('\n');
    chunks.push({
      ord: chunks.length,
      heading,
      body,
      contentHash: createHash('sha256').update(heading).update('\0').update(body).digest('hex'),
    });
    parts = [];
    size = 0;
  };

  document.forEach((block) => {
    // No leaf-text argument, as in the note materialiser: a reference contributes its label.
    const text = block.textBetween(0, block.content.size, '\n').trim();
    if (block.type.name === 'heading') {
      flush();
      const level = Math.max(1, Number(block.attrs.level) || 1);
      trail.length = Math.min(trail.length, level - 1);
      trail[level - 1] = text;
      // A skipped level (h1 then h3) leaves a hole; `filter(Boolean)` drops it with the empty ones.
      heading = trail.filter(Boolean).join(' › ');
      return;
    }
    if (text === '') return;
    if (size > 0 && size + text.length > CHUNK_CHARS) flush();
    for (let start = 0; start < text.length; start += CHUNK_CHARS) {
      const slice = text.slice(start, start + CHUNK_CHARS);
      if (size > 0 && size + slice.length > CHUNK_CHARS) flush();
      parts.push(slice);
      size += slice.length;
    }
  });
  flush();

  return chunks;
}
