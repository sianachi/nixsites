import { nixSchema } from '@nix/editor-schema';
import { prosemirrorJSONToYXmlFragment, yXmlFragmentToProseMirrorRootNode } from 'y-prosemirror';
import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

import {
  MARKDOWN_ORIGIN,
  applyMarkdown,
  snapshotMarkdown,
  watchRemoteChanges,
} from '../../editor/markdown-mode';

function noteWith(blocks: unknown[]): { doc: Y.Doc; fragment: Y.XmlFragment } {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment('default');
  prosemirrorJSONToYXmlFragment(nixSchema, { type: 'doc', content: blocks }, fragment);
  return { doc, fragment };
}

const heading = { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Plan' }] };
const paragraph = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });

describe('Markdown mode', () => {
  it('round-trips supported blocks and writes nothing when the text is unchanged', () => {
    const { doc, fragment } = noteWith([heading, paragraph('First'), paragraph('Second')]);
    const snapshot = snapshotMarkdown(fragment);
    expect(snapshot.losses).toEqual([]);
    expect(snapshot.markdown).toContain('## Plan');

    const updates: unknown[] = [];
    doc.on('update', (update: Uint8Array) => updates.push(update));
    expect(applyMarkdown(doc, fragment, snapshot.markdown, snapshot.markdown)).toEqual({
      kind: 'unchanged',
    });
    expect(updates).toHaveLength(0);
  });

  it('replaces the body in one tagged transaction that the undo manager can take back as one step', () => {
    const { doc, fragment } = noteWith([heading, paragraph('First')]);
    const before: unknown = yXmlFragmentToProseMirrorRootNode(fragment, nixSchema).toJSON();
    const undo = new Y.UndoManager(fragment, { trackedOrigins: new Set([MARKDOWN_ORIGIN]) });
    const origins: unknown[] = [];
    doc.on('afterTransaction', (transaction: Y.Transaction) => origins.push(transaction.origin));

    const outcome = applyMarkdown(doc, fragment, '# New title\n\nOne paragraph.\n', 'old');
    expect(outcome).toEqual({ kind: 'applied' });
    expect(origins).toEqual([MARKDOWN_ORIGIN]);
    const after = yXmlFragmentToProseMirrorRootNode(fragment, nixSchema).toJSON() as {
      content: { type: string }[];
    };
    expect(after.content.map((node) => node.type)).toEqual(['heading', 'paragraph']);

    undo.undo();
    expect(yXmlFragmentToProseMirrorRootNode(fragment, nixSchema).toJSON()).toEqual(before);
  });

  it('reports what Markdown cannot carry instead of dropping it silently', () => {
    const { fragment } = noteWith([
      {
        type: 'columnBlock',
        content: [
          { type: 'column', content: [paragraph('Left')] },
          { type: 'column', content: [paragraph('Right')] },
        ],
      },
    ]);
    const snapshot = snapshotMarkdown(fragment);
    expect(snapshot.losses.length).toBeGreaterThan(0);
    expect(snapshot.markdown).toContain('Left');
  });

  it('keeps an empty text as a one-paragraph note and tells remote changes from local ones', () => {
    const { doc, fragment } = noteWith([paragraph('Body')]);
    const onRemote = vi.fn();
    const stop = watchRemoteChanges(fragment, onRemote);
    expect(applyMarkdown(doc, fragment, '', 'Body\n')).toEqual({ kind: 'applied' });
    expect(fragment.length).toBe(1);
    expect(onRemote).not.toHaveBeenCalled();

    // A colleague's update arrives as a non-local transaction.
    const other = new Y.Doc();
    prosemirrorJSONToYXmlFragment(
      nixSchema,
      { type: 'doc', content: [paragraph('Theirs')] },
      other.getXmlFragment('default'),
    );
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(other), 'remote');
    expect(onRemote).toHaveBeenCalledTimes(1);
    stop();
  });
});
