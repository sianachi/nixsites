import { EditorState, TextSelection } from '@tiptap/pm/state';
import { describe, expect, it } from 'vitest';
import { nixSchema, parseDocument } from './schema.js';
import { readTextAlignment, setTextAlignTr } from './text-alignment.js';
import { requiredSchemaVersion } from './versions.js';

describe('poem alignment', () => {
  it('justifies selected blocks together without changing their words or line breaks', () => {
    const doc = nixSchema.nodeFromJSON({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'First line' },
            { type: 'hardBreak' },
            { type: 'text', text: 'Second line' },
          ],
        },
        {
          type: 'heading',
          attrs: { level: 2 },
          content: [{ type: 'text', text: 'Another stanza' }],
        },
        { type: 'paragraph', content: [{ type: 'text', text: 'Leave this left' }] },
      ],
    });
    const end = doc.child(0).nodeSize + doc.child(1).nodeSize - 1;
    const state = EditorState.create({ doc, selection: TextSelection.create(doc, 1, end) });
    const dryRun = state.tr;
    expect(setTextAlignTr(dryRun, 'center', false)).toBe(true);
    expect(dryRun.docChanged).toBe(false);
    const tr = state.tr;
    expect(setTextAlignTr(tr, 'justify', true)).toBe(true);
    expect(tr.doc.child(0).attrs.textAlign).toBe('justify');
    expect(tr.doc.child(1).attrs.textAlign).toBe('justify');
    expect(tr.doc.child(2).attrs.textAlign).toBeNull();
    expect(tr.doc.textContent).toBe(doc.textContent);
    expect(tr.doc.child(0).child(1).type.name).toBe('hardBreak');
    const reopened = parseDocument(tr.doc.toJSON());
    expect(reopened.ok && reopened.document.eq(tr.doc)).toBe(true);
    expect(requiredSchemaVersion(tr.doc)).toBe(5);
    expect(requiredSchemaVersion(doc)).toBe(1);
  });
  it('aligns only the paragraph containing a caret', () => {
    const doc = nixSchema.node('doc', null, [
      nixSchema.node('paragraph'),
      nixSchema.node('paragraph'),
    ]);
    const tr = EditorState.create({ doc, selection: TextSelection.create(doc, 3) }).tr;
    expect(setTextAlignTr(tr, 'right', true)).toBe(true);
    expect(tr.doc.child(0).attrs.textAlign).toBeNull();
    expect(tr.doc.child(1).attrs.textAlign).toBe('right');
  });
  it('does not align code or turn unknown alignment values into CSS', () => {
    const doc = nixSchema.node('doc', null, [nixSchema.node('codeBlock')]);
    const tr = EditorState.create({ doc }).tr;
    expect(setTextAlignTr(tr, 'center', true)).toBe(false);
    expect(readTextAlignment('center; color: red')).toBeNull();
  });
});
