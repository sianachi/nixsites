import { markdownToDocument } from '@nix/markdown';
import { describe, expect, it } from 'vitest';

import { insertNoteLink } from '../../editor/markdown-mode';
import { findTrigger } from '../../editor/reference-menu';

describe('the [[ note-link picker in Markdown mode', () => {
  const typed = 'See [[quarter';
  const target = { id: '0192f2a0-7c1e-7000-8000-000000000001', title: 'Q3 [plan] *draft*' };

  it('finds the open trigger before the caret and replaces it with a link', () => {
    expect(findTrigger(typed)).toEqual({ start: 4, query: 'quarter', kind: 'item' });

    const after = ' and more';
    const next = insertNoteLink(typed + after, typed.length, 4, target);
    expect(next.text).toBe(`See [Q3 \\[plan\\] \\*draft\\*](nix://item/${target.id})${after}`);
    expect(next.text.slice(next.caret)).toBe(after);
  });

  it('parses back to a reference to the same item', () => {
    const { text } = insertNoteLink(typed, typed.length, 4, target);
    const parsed = markdownToDocument(text);
    expect(parsed.ok).toBe(true);
    expect(JSON.stringify(parsed)).toContain(
      JSON.stringify({ kind: 'item', targetId: target.id, label: target.title }),
    );
  });
});
