import { getSchema } from '@tiptap/core';
import { nixEditingExtensions } from '@nix/editor-schema';
import { describe, expect, it } from 'vitest';

import { findTrigger, linkedTargets, linkFrecencyNamespace } from '../../editor/reference-menu';

describe('finding a reference trigger in the text before the caret', () => {
  it('opens on a double bracket, for an item', () => {
    expect(findTrigger('See [[')).toEqual({ start: 4, query: '', kind: 'item' });
  });

  it('opens on an at sign, which also offers people', () => {
    expect(findTrigger('Ask @')).toEqual({ start: 4, query: '', kind: 'principal' });
  });

  it('opens at the very start of a block', () => {
    expect(findTrigger('[[')).toEqual({ start: 0, query: '', kind: 'item' });
  });

  it('carries what has been typed since the trigger', () => {
    expect(findTrigger('See [[quarterly')?.query).toBe('quarterly');
    expect(findTrigger('Ask @dana')?.query).toBe('dana');
  });

  it('keeps the query when it has spaces in it', () => {
    // Titles have spaces, so a trigger that ended at the first one could only ever find
    // single-word documents.
    expect(findTrigger('See [[quarterly ledger')?.query).toBe('quarterly ledger');
  });

  it('ignores a trigger in the middle of a word', () => {
    // The case this exists for is an email address: nobody typing one is asking for a people
    // picker, and one that opened would swallow the next Enter they pressed.
    expect(findTrigger('mail dana@example.test')).toBeNull();
    expect(findTrigger('a[[b')).toBeNull();
  });

  it('closes on a closing bracket, so a finished link is text again', () => {
    expect(findTrigger('See [[quarterly]]')).toBeNull();
  });

  it('closes on a newline', () => {
    expect(findTrigger('See [[quarterly\nand more')).toBeNull();
  });

  it('gives up once the query is longer than a title', () => {
    // Somebody who typed `[[` and carried on writing a paragraph is writing a paragraph, and a
    // picker still open behind it would keep taking their arrow keys.
    expect(findTrigger(`See [[${'x'.repeat(65)}`)).toBeNull();
    expect(findTrigger(`See [[${'x'.repeat(64)}`)).not.toBeNull();
  });

  it('takes the nearest trigger when there are two', () => {
    // The one being typed into is the last one, whichever kind it is.
    expect(findTrigger('See [[one and @tw')).toEqual({ start: 14, query: 'tw', kind: 'principal' });
    expect(findTrigger('Ask @dana and [[qu')).toEqual({ start: 14, query: 'qu', kind: 'item' });
  });

  it('finds nothing in ordinary prose', () => {
    expect(findTrigger('Just some words')).toBeNull();
    expect(findTrigger('')).toBeNull();
  });
});

describe('what a note already links to', () => {
  const schema = getSchema([...nixEditingExtensions]);

  function noteWith(...targets: string[]) {
    return schema.nodeFromJSON({
      type: 'doc',
      content: targets.map((targetId) => ({
        type: 'paragraph',
        content: [
          { type: 'text', text: 'See ' },
          { type: 'reference', attrs: { kind: 'item', targetId, label: targetId } },
        ],
      })),
    });
  }

  it('collects every referenced item once', () => {
    expect([...linkedTargets(noteWith('a', 'b', 'a'))].sort()).toEqual(['a', 'b']);
  });

  it('stops reading at its budget, so a very long note costs a bounded walk', () => {
    // Each paragraph is three nodes: the paragraph, its text and its reference.
    const targets = Array.from({ length: 10 }, (_, index) => `item-${String(index)}`);

    expect(linkedTargets(noteWith(...targets), 6).size).toBe(2);
  });

  it('scopes pick history to one workspace', () => {
    expect(linkFrecencyNamespace('w1')).not.toBe(linkFrecencyNamespace('w2'));
  });
});
