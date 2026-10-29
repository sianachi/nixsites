import { describe, expect, it } from 'vitest';
import { lineSegments, rangeSegments } from '../../lib/text-diff';

describe('rangeSegments', () => {
  it('splits text around the changed run and drops empty runs', () => {
    expect(rangeSegments('Meet at teh station.', { start: 9, end: 10 })).toEqual([
      { text: 'Meet at t', changed: false },
      { text: 'e', changed: true },
      { text: 'h station.', changed: false },
    ]);
    expect(rangeSegments('abc', { start: 0, end: 3 })).toEqual([{ text: 'abc', changed: true }]);
  });

  it('clamps a range that runs past the text', () => {
    expect(rangeSegments('ab', { start: 1, end: 9 })).toEqual([
      { text: 'a', changed: false },
      { text: 'b', changed: true },
    ]);
  });
});

describe('lineSegments', () => {
  it('marks only the lines that differ on each side', () => {
    const result = lineSegments(
      '## Plan\n\n- one\n- two\n\nEnd.',
      '## Plan\n\n- one\n- three\n\nEnd.',
    );
    expect(result.before).toEqual([
      { text: '## Plan\n\n- one\n', changed: false },
      { text: '- two\n', changed: true },
      { text: '\nEnd.', changed: false },
    ]);
    expect(result.after).toEqual([
      { text: '## Plan\n\n- one\n', changed: false },
      { text: '- three\n', changed: true },
      { text: '\nEnd.', changed: false },
    ]);
  });

  it('keeps lines common to both sides even when lines are inserted and removed around them', () => {
    const result = lineSegments('a\nb\nc\nd', 'x\nb\ny\nd');
    expect(result.before.filter((s) => s.changed).map((s) => s.text)).toEqual(['a\n', 'c\n']);
    expect(result.after.filter((s) => s.changed).map((s) => s.text)).toEqual(['x\n', 'y\n']);
  });

  it('marks everything when nothing is shared', () => {
    expect(lineSegments('old', 'new')).toEqual({
      before: [{ text: 'old', changed: true }],
      after: [{ text: 'new', changed: true }],
    });
  });

  it('treats lines that differ only in whitespace, and blank lines, as unchanged', () => {
    const result = lineSegments('- one\n\n- two  \nEnd.', '-  one\n- two\n\n\nEnd!');
    expect(result.before.filter((s) => s.changed).map((s) => s.text)).toEqual(['End.']);
    expect(result.after.filter((s) => s.changed).map((s) => s.text)).toEqual(['End!']);
  });
});
