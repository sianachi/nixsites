import { nixSchema } from '@nix/editor-schema';
import { describe, expect, it } from 'vitest';

import { readNoteStats } from '../../editor/note-stats';

describe('readNoteStats', () => {
  const doc = nixSchema.nodeFromJSON({
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Title' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'one two three' }] },
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Part' }] },
    ],
  });

  it('counts words across blocks and rounds reading time up', () => {
    const stats = readNoteStats(doc);
    expect(stats.words).toBe(5);
    expect(stats.minutes).toBe(1);
  });

  it('leaves out text proposed for deletion', () => {
    const marked = nixSchema.nodeFromJSON({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'keep' },
            { type: 'text', text: ' gone away', marks: [{ type: 'suggestionDelete', attrs: {} }] },
          ],
        },
      ],
    });
    expect(readNoteStats(marked).words).toBe(1);
  });

  it('counts a hard break as a word separator', () => {
    const broken = nixSchema.nodeFromJSON({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'foo' },
            { type: 'hardBreak' },
            { type: 'text', text: 'bar' },
          ],
        },
      ],
    });
    expect(readNoteStats(broken).words).toBe(2);
  });

  it('lists headings with level and the position of the heading node', () => {
    const { outline } = readNoteStats(doc);
    expect(outline.map((h) => [h.level, h.text])).toEqual([
      [1, 'Title'],
      [2, 'Part'],
    ]);
    expect(doc.nodeAt(outline[1]?.pos ?? -1)?.type.name).toBe('heading');
  });
});
