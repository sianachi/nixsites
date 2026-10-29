import type { CommentThread } from '@nix/api-client';
import { describe, expect, it } from 'vitest';

import { reanchorCandidates } from '../../editor/use-comment-sync';

const ITEM = '11111111-1111-4111-8111-111111111111';

function thread(id: string, anchored: boolean): CommentThread {
  return {
    id,
    anchorStart: anchored ? 'AQ==' : null,
    anchorEnd: anchored ? 'AQ==' : null,
    quote: 'quote',
    resolvedAt: null,
    resolvedBy: null,
    resolvedByName: null,
    comments: [],
  };
}

describe('re-anchor scope', () => {
  it('re-anchors threads detached on first sight or never anchored, not ones that lose text later', () => {
    const live = thread('live', true);
    const loaded = thread('loaded', true);
    const imported = thread('imported', false);

    // First sight: `loaded` and `imported` are detached already, `live` is attached.
    expect(reanchorCandidates(ITEM, [live, loaded, imported], ['loaded', 'imported'])).toEqual([
      'loaded',
      'imported',
    ]);
    // `live` loses its text during the session.
    expect(
      reanchorCandidates(ITEM, [live, loaded, imported], ['live', 'loaded', 'imported']),
    ).toEqual(['loaded', 'imported']);
  });
});
