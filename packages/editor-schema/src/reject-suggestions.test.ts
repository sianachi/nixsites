import { describe, expect, it } from 'vitest';

import { rejectAllSuggestions } from './reject-suggestions.js';

const mark = (type: string, extra: Record<string, unknown> = {}) => ({
  type,
  attrs: { id: 's1', authorId: 'a', createdAt: 'now', ...extra },
});
const para = (content: unknown[], suggestion?: Record<string, unknown>) => ({
  type: 'paragraph',
  ...(suggestion === undefined ? {} : { attrs: { suggestion } }),
  content,
});
const text = (value: string, marks?: unknown[]) => ({
  type: 'text',
  text: value,
  ...(marks === undefined ? {} : { marks }),
});
const doc = (...content: unknown[]) => ({ type: 'doc', content });

describe('rejectAllSuggestions', () => {
  it('drops inserted text, keeps deleted text and joins what is left', () => {
    const out = rejectAllSuggestions(
      doc(
        para([
          text('one '),
          text('added', [mark('suggestionInsert')]),
          text('two', [mark('suggestionDelete')]),
        ]),
      ),
    );
    expect(out).toEqual(doc(para([text('one two')])));
  });

  it('restores the marks a format change replaced', () => {
    const before = JSON.stringify([{ type: 'italic' }]);
    const out = rejectAllSuggestions(
      doc(para([text('x', [{ type: 'bold' }, mark('suggestionFormat', { before })])])),
    );
    expect(out).toEqual(doc(para([text('x', [{ type: 'italic' }])])));
  });

  it('removes inserted blocks and joins a split block back into the one before', () => {
    const out = rejectAllSuggestions(
      doc(
        para([text('head')]),
        para([text('tail')], { id: 's1', op: 'insert' }),
        para([text('new', [mark('suggestionInsert')])], { id: 's2', op: 'insert' }),
      ),
    );
    expect(out).toEqual(doc(para([text('headtail')])));
  });

  it('keeps blocks marked for deletion and drops the attribute', () => {
    const out = rejectAllSuggestions(doc(para([text('gone')], { id: 's1', op: 'delete' })));
    expect(out).toEqual(doc({ type: 'paragraph', attrs: {}, content: [text('gone')] }));
  });

  it('puts a restructured run of blocks back to its snapshot', () => {
    const snapshot = JSON.stringify({ content: [para([text('a')])], openStart: 0, openEnd: 0 });
    const out = rejectAllSuggestions(
      doc({
        type: 'bulletList',
        attrs: { suggestion: { id: 's1', op: 'restructure', before: snapshot } },
        content: [{ type: 'listItem', content: [para([text('a')])] }],
      }),
    );
    expect(out).toEqual(doc(para([text('a')])));
  });
});
