import { describe, expect, it } from 'vitest';

import { CHUNK_CHARS, MAX_CHUNKS, chunkNote } from './chunks.ts';

const paragraph = (text: string): unknown => ({
  type: 'paragraph',
  content: [{ type: 'text', text }],
});
const heading = (level: number, text: string): unknown => ({
  type: 'heading',
  attrs: { level },
  content: [{ type: 'text', text }],
});
const doc = (...content: unknown[]): unknown => ({ type: 'doc', content });

describe('chunking a note', () => {
  it('keeps the first MAX_CHUNKS chunks of a very long note', () => {
    const sections = Array.from({ length: MAX_CHUNKS + 5 }, (_, index) => [
      heading(1, `Part ${String(index)}`),
      paragraph(`Section ${String(index)}.`),
    ]).flat();
    const chunks = chunkNote(doc(...sections));
    expect(chunks).toHaveLength(MAX_CHUNKS);
    expect(chunks?.at(-1)?.body).toBe(`Section ${String(MAX_CHUNKS - 1)}.`);
  });

  it('starts a chunk at every heading and carries the heading trail', () => {
    const chunks = chunkNote(
      doc(
        paragraph('Preface.'),
        heading(1, 'Contract'),
        paragraph('Parties.'),
        heading(3, 'Fees'),
        paragraph('Late fees are 2%.'),
        heading(2, 'Termination'),
        paragraph('Thirty days notice.'),
      ),
    );

    expect(chunks?.map(({ ord, heading, body }) => ({ ord, heading, body }))).toEqual([
      { ord: 0, heading: '', body: 'Preface.' },
      { ord: 1, heading: 'Contract', body: 'Parties.' },
      { ord: 2, heading: 'Contract › Fees', body: 'Late fees are 2%.' },
      { ord: 3, heading: 'Contract › Termination', body: 'Thirty days notice.' },
    ]);
  });

  it('packs blocks up to the cap and slices a block larger than it', () => {
    const chunks = chunkNote(
      doc(paragraph('a'.repeat(1_000)), paragraph('b'.repeat(1_000)), paragraph('c'.repeat(4_000))),
    );

    expect(chunks?.every((chunk) => chunk.body.length <= CHUNK_CHARS)).toBe(true);
    expect(chunks?.map((chunk) => chunk.body.length)).toEqual([1_000, 1_000, 1_500, 1_500, 1_000]);
  });

  it('covers the whole of a note far past the search-text ceiling', () => {
    const words = 'the quick brown fox jumps over the lazy dog. ';
    const sections = Array.from({ length: 500 }, (_, index) => [
      heading(2, `Section ${String(index)}`),
      paragraph(words.repeat(33).trim()),
    ]).flat();

    const chunks = chunkNote(doc(...sections)) ?? [];

    expect(chunks).toHaveLength(500);
    expect(chunks.reduce((total, chunk) => total + chunk.body.length, 0)).toBeGreaterThan(600_000);
    expect(chunks.at(-1)?.heading).toBe('Section 499');
  });

  it('hashes by text, so an unchanged passage keeps its hash wherever it moves', () => {
    const [before] = chunkNote(doc(heading(1, 'A'), paragraph('Same words.'))) ?? [];
    const [, after] =
      chunkNote(doc(paragraph('New intro.'), heading(1, 'A'), paragraph('Same words.'))) ?? [];
    const [edited] = chunkNote(doc(heading(1, 'A'), paragraph('Other words.'))) ?? [];

    expect(after?.contentHash).toBe(before?.contentHash);
    expect(edited?.contentHash).not.toBe(before?.contentHash);
  });

  it('refuses what is not a prose document, so existing chunks are left alone', () => {
    expect(chunkNote(null)).toBeNull();
    expect(chunkNote({ elements: [] })).toBeNull();
    expect(chunkNote({ type: 'doc', content: [{ type: 'noSuchNode' }] })).toBeNull();
    expect(chunkNote(doc())).toEqual([]);
  });
});
