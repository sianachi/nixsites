import { describe, expect, it } from 'vitest';

import {
  candidatesIn,
  locateMentions,
  MAX_MENTIONS_PER_BLOCK,
  type MentionCandidate,
} from '../../../lib/suggest/ref-mentions';

const ATLAS: MentionCandidate = { itemId: 'atlas', title: 'Atlas', phrase: 'Atlas' };
const PROJECT_ATLAS: MentionCandidate = {
  itemId: 'project-atlas',
  title: 'Project Atlas',
  phrase: 'Project Atlas',
};

describe('locating mentions in a block', () => {
  it('finds whole-word occurrences, ignoring case', () => {
    const ranges = locateMentions('atlas, Atlases and ATLAS.', [ATLAS]);

    expect(ranges.map((range) => [range.from, range.to])).toEqual([
      [0, 5],
      [19, 24],
    ]);
  });

  it('gives an overlapping span to the longest phrase, whatever order the candidates arrive in', () => {
    const ranges = locateMentions('Notes on Project Atlas today', [ATLAS, PROJECT_ATLAS]);

    expect(ranges.map((range) => range.itemId)).toEqual(['project-atlas']);
  });

  it('never matches through a non-prose placeholder', () => {
    expect(locateMentions('Project￼Atlas', [PROJECT_ATLAS])).toEqual([]);
  });

  it('treats a phrase’s metacharacters literally', () => {
    const plus: MentionCandidate = { itemId: 'c', title: 'C++ notes', phrase: 'C++ notes' };

    expect(locateMentions('My C++ notes', [plus])).toHaveLength(1);
    expect(locateMentions('My Cxx notes', [plus])).toHaveLength(0);
  });

  it('skips phrases too short to be meant', () => {
    expect(locateMentions('an ox', [{ itemId: 'ox', title: 'ox', phrase: 'ox' }])).toEqual([]);
  });

  it('stops at the per-block ceiling and returns the ranges in reading order', () => {
    const text = Array.from({ length: MAX_MENTIONS_PER_BLOCK + 5 }, () => 'Atlas').join(' ');

    const ranges = locateMentions(text, [ATLAS]);

    expect(ranges).toHaveLength(MAX_MENTIONS_PER_BLOCK);
    expect(ranges.map((range) => range.from)).toEqual(
      [...ranges.map((range) => range.from)].sort((a, b) => a - b),
    );
  });
});

describe('which candidates a block holds', () => {
  it('keeps each candidate that occurs, judged on its own rather than after overlaps', () => {
    expect(
      candidatesIn('Notes on Project Atlas', [ATLAS, PROJECT_ATLAS]).map((c) => c.itemId),
    ).toEqual(['atlas', 'project-atlas']);
  });

  it('drops a candidate the block does not contain', () => {
    expect(candidatesIn('Nothing here', [ATLAS])).toEqual([]);
  });
});
