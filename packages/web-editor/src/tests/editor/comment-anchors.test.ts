import type { CommentThread } from '@nix/api-client';
import { nixEditingExtensions } from '@nix/editor-schema';
import { Editor } from '@tiptap/core';
import type { Plugin } from '@tiptap/pm/state';
import { ySyncPlugin } from 'y-prosemirror';
import * as Y from 'yjs';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CommentAnchors,
  captureAnchor,
  findQuote,
  isAnchoredThread,
  patchComments,
  readComments,
  threadRange,
} from '../../editor/comment-anchors';

/** A real editor bound to a Yjs document: P1 "Hello world" spans 1..12, P2 "Second" 14..20. */
const ITEM = '11111111-1111-4111-8111-111111111111';
let editor: Editor | null = null;

function makeEditor(): Editor {
  const element = document.createElement('div');
  document.body.append(element);
  const created = new Editor({ element, extensions: [...nixEditingExtensions, CommentAnchors] });
  created.registerPlugin(ySyncPlugin(new Y.Doc().getXmlFragment('default')) as Plugin);
  created.commands.setContent('<p>Hello world</p><p>Second</p>');
  created.storage.commentAnchors.itemId = ITEM;
  editor = created;
  return created;
}

function thread(patch: Partial<CommentThread>): CommentThread {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    anchorStart: null,
    anchorEnd: null,
    quote: null,
    resolvedAt: null,
    resolvedBy: null,
    resolvedByName: null,
    comments: [],
    ...patch,
  };
}

afterEach(() => {
  editor?.destroy();
  editor = null;
  patchComments(ITEM, { threads: [], ready: false, detached: [], activeThreadId: null });
  document.body.replaceChildren();
});

describe('comment anchors', () => {
  it('captures a selection and decodes it back to the same text, following later edits', () => {
    const target = makeEditor();
    target.commands.setTextSelection({ from: 7, to: 12 });
    const anchor = captureAnchor(target.view);
    expect(anchor?.quote).toBe('world');
    if (anchor === null) return;

    const stored = thread({
      anchorStart: anchor.start,
      anchorEnd: anchor.end,
      quote: anchor.quote,
    });
    expect(threadRange(target.state, stored)).toEqual({ from: 7, to: 12 });

    // Text typed before the range moves it; the anchor stays on the same words.
    target.commands.insertContentAt(1, 'Oh, ');
    const range = threadRange(target.state, stored);
    expect(range).toEqual({ from: 11, to: 16 });
    expect(target.state.doc.textBetween(11, 16)).toBe('world');
  });

  it('captures nothing for a caret', () => {
    const target = makeEditor();
    target.commands.setTextSelection(3);
    expect(captureAnchor(target.view)).toBeNull();
  });

  it('treats a quote with no anchors, or text that was deleted, as detached', () => {
    const target = makeEditor();
    const unanchored = thread({ quote: 'world' });
    expect(isAnchoredThread(unanchored)).toBe(true);
    expect(isAnchoredThread(thread({}))).toBe(false);
    expect(threadRange(target.state, unanchored)).toBeNull();

    target.commands.setTextSelection({ from: 7, to: 12 });
    const anchor = captureAnchor(target.view);
    if (anchor === null) throw new Error('Expected an anchor.');
    const stored = thread({ anchorStart: anchor.start, anchorEnd: anchor.end, quote: 'world' });
    target.commands.deleteRange({ from: 7, to: 12 });
    expect(threadRange(target.state, stored)).toBeNull();
    expect(threadRange(target.state, thread({ anchorStart: '!!', anchorEnd: '!!' }))).toBeNull();
  });

  it('finds a quote only when it occurs exactly once, through inline code and hard breaks', () => {
    const target = makeEditor();
    expect(findQuote(target.state.doc, 'world')).toEqual({ from: 7, to: 12 });
    expect(findQuote(target.state.doc, 'Second')).toEqual({ from: 14, to: 20 });
    expect(findQuote(target.state.doc, 'absent')).toBeNull();

    target.commands.setContent('<p>one <code>fn()</code> two</p><p>twice</p><p>twice</p>');
    expect(findQuote(target.state.doc, 'twice')).toBeNull();
    expect(findQuote(target.state.doc, 'one fn() two')).toEqual({ from: 1, to: 13 });
    target.commands.setTextSelection({ from: 1, to: 13 });
    expect(captureAnchor(target.view)?.quote).toBe('one fn() two');
  });

  it('keeps a highlight on its words through a local edit before it', () => {
    const target = makeEditor();
    target.commands.setTextSelection({ from: 7, to: 12 });
    const anchor = captureAnchor(target.view);
    if (anchor === null) throw new Error('Expected an anchor.');
    const stored = thread({ anchorStart: anchor.start, anchorEnd: anchor.end, quote: 'world' });
    patchComments(ITEM, { threads: [stored], ready: true });
    target.view.dispatch(target.state.tr.setMeta('refresh', true));

    // Yjs learns of a local edit only after its transaction is applied.
    target.commands.insertContentAt(1, 'XY');
    expect(target.view.dom.querySelector('[data-comment-thread]')?.textContent).toBe('world');

    // A big delete before the range moves it rather than collapsing it.
    target.commands.deleteRange({ from: 1, to: 6 });
    expect(target.view.dom.querySelector('[data-comment-thread]')?.textContent).toBe('world');
    expect(readComments(ITEM).detached).toEqual([]);
  });

  it('draws a highlight for each open anchored thread once the body is ready', () => {
    const target = makeEditor();
    target.commands.setTextSelection({ from: 7, to: 12 });
    const anchor = captureAnchor(target.view);
    if (anchor === null) throw new Error('Expected an anchor.');
    const open = thread({ anchorStart: anchor.start, anchorEnd: anchor.end, quote: 'world' });
    const resolved = thread({
      id: '33333333-3333-4333-8333-333333333333',
      anchorStart: anchor.start,
      anchorEnd: anchor.end,
      resolvedAt: '2026-10-29T10:00:00Z',
    });

    patchComments(ITEM, { threads: [open, resolved], ready: false });
    expect(target.view.dom.querySelector('[data-comment-thread]')).toBeNull();

    patchComments(ITEM, { ready: true });
    target.view.dispatch(target.state.tr.setMeta('refresh', true));
    const marks = target.view.dom.querySelectorAll('[data-comment-thread]');
    expect(marks).toHaveLength(1);
    expect(marks[0]?.textContent).toBe('world');
    expect(readComments(ITEM).detached).toEqual([]);
  });
});
