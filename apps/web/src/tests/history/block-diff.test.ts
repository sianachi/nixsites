import { describe, expect, it } from 'vitest';

import { blockTexts, diffBlocks } from '../../history/block-diff';
import { paragraph } from '../paragraph-fixture';

function heading(level: number, text: string): unknown {
  return { type: 'heading', attrs: { level }, content: [{ type: 'text', text }] };
}

function cell(text: string): unknown {
  return { type: 'tableCell', content: [paragraph(text)] };
}

function row(cells: readonly string[]): unknown {
  return { type: 'tableRow', content: cells.map(cell) };
}

function table(rows: readonly (readonly string[])[]): unknown {
  return { type: 'table', content: rows.map(row) };
}

function image(alt: string | null): unknown {
  return { type: 'image', attrs: { alt } };
}

function doc(content: readonly unknown[]): unknown {
  return { type: 'doc', content };
}

describe('blockTexts', () => {
  it('flattens paragraphs and headings to one entry each', () => {
    expect(
      blockTexts(doc([heading(1, 'Title'), paragraph('First para.'), paragraph('Second para.')])),
    ).toEqual(['Title', 'First para.', 'Second para.']);
  });

  it('flattens a table to one entry, cells joined by tabs and rows by newlines', () => {
    expect(
      blockTexts(
        doc([
          table([
            ['Name', 'Value'],
            ['Answer', '42'],
          ]),
        ]),
      ),
    ).toEqual(['Name\tValue\nAnswer\t42']);
  });

  it('flattens an image to its alt text', () => {
    expect(blockTexts(doc([image('A diagram of the pipeline')]))).toEqual([
      'A diagram of the pipeline',
    ]);
  });

  it('falls back to a placeholder for an image with no alt text', () => {
    expect(blockTexts(doc([image(null)]))).toEqual(['[image]']);
    expect(blockTexts(doc([image('')]))).toEqual(['[image]']);
  });

  it('flattens block containers (a list) to newline-joined item text', () => {
    const bulletList = {
      type: 'bulletList',
      content: [
        { type: 'listItem', content: [paragraph('First')] },
        { type: 'listItem', content: [paragraph('Second')] },
      ],
    };
    expect(blockTexts(doc([bulletList]))).toEqual(['First\nSecond']);
  });

  it('returns no blocks for a document with no usable content', () => {
    expect(blockTexts(null)).toEqual([]);
    expect(blockTexts({})).toEqual([]);
    expect(blockTexts(doc([]))).toEqual([]);
  });
});

describe('diffBlocks', () => {
  it('marks matching blocks as same, in order', () => {
    const before = ['Title', 'Body one', 'Body two'];
    const after = ['Title', 'Body one', 'Body two'];
    expect(diffBlocks(before, after)).toEqual([
      { kind: 'same', before: 'Title', after: 'Title' },
      { kind: 'same', before: 'Body one', after: 'Body one' },
      { kind: 'same', before: 'Body two', after: 'Body two' },
    ]);
  });

  it('marks a block only in after as added', () => {
    const before = ['Title'];
    const after = ['Title', 'A brand new unrelated closing paragraph.'];
    expect(diffBlocks(before, after)).toEqual([
      { kind: 'same', before: 'Title', after: 'Title' },
      { kind: 'added', after: 'A brand new unrelated closing paragraph.' },
    ]);
  });

  it('marks a block only in before as removed', () => {
    const before = ['Title', 'A whole unrelated paragraph that goes away entirely.'];
    const after = ['Title'];
    expect(diffBlocks(before, after)).toEqual([
      { kind: 'same', before: 'Title', after: 'Title' },
      { kind: 'removed', before: 'A whole unrelated paragraph that goes away entirely.' },
    ]);
  });

  it('finds the longest common subsequence across a reordering', () => {
    // "Middle" moves from between A and C to after C - the LCS keeps A and C matched and treats
    // Middle as removed-then-added rather than matching it as 'same' out of position.
    const before = ['A', 'Middle', 'C'];
    const after = ['A', 'C', 'Middle'];
    const result = diffBlocks(before, after);
    expect(result.filter((entry) => entry.kind === 'same').map((entry) => entry.before)).toEqual([
      'A',
      'C',
    ]);
  });

  it('collapses an adjacent removed+added pair into changed when they share a long prefix', () => {
    const before = ['This is the original opening sentence of the paragraph.'];
    const after = ['This is the original opening sentence of the paragraph, extended.'];
    expect(diffBlocks(before, after)).toEqual([
      {
        kind: 'changed',
        before: 'This is the original opening sentence of the paragraph.',
        after: 'This is the original opening sentence of the paragraph, extended.',
      },
    ]);
  });

  it('collapses an adjacent removed+added pair into changed when they share a long suffix', () => {
    const before = ['An old lead-in before the shared tail of this particular sentence.'];
    const after = ['A rewritten lead-in before the shared tail of this particular sentence.'];
    expect(diffBlocks(before, after)).toEqual([
      {
        kind: 'changed',
        before: 'An old lead-in before the shared tail of this particular sentence.',
        after: 'A rewritten lead-in before the shared tail of this particular sentence.',
      },
    ]);
  });

  it('leaves an adjacent removed+added pair separate when they share under 12 characters', () => {
    const before = ['Completely different first sentence.'];
    const after = ['Not related at all, second sentence.'];
    expect(diffBlocks(before, after)).toEqual([
      { kind: 'removed', before: 'Completely different first sentence.' },
      { kind: 'added', after: 'Not related at all, second sentence.' },
    ]);
  });

  it('handles empty inputs', () => {
    expect(diffBlocks([], [])).toEqual([]);
    expect(diffBlocks([], ['New'])).toEqual([{ kind: 'added', after: 'New' }]);
    expect(diffBlocks(['Old'], [])).toEqual([{ kind: 'removed', before: 'Old' }]);
  });
});
