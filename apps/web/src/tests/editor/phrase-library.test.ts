import 'fake-indexeddb/auto';
import { nixEditingExtensions } from '@nix/editor-schema';
import { Editor } from '@tiptap/core';
import * as Y from 'yjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearBodyCache,
  discardBodyCache,
  documentScope,
  openBodyCache,
  pruneBodyCache,
  sealItemBodies,
  writeBodyCache,
} from '../../lib/body-cache';
import { GhostText, setGhostTextContext } from '../../editor/ghost-text';
import {
  learnBody,
  libraryModels,
  MAX_LIBRARY_BODIES,
  proseTextOfUpdate,
  resetPhraseLibrary,
  warmPhraseLibrary,
} from '../../editor/phrase-library';
import { completePhrase } from '../../lib/suggest/ngram';
import { memoryStorage } from '../memory-storage';

const ADA = 'subject-ada';
const WORKSPACE = 'workspace-1';
const PHRASE = 'The launch checklist is ready. The launch checklist is ready.';

function scope(item: string, workspace = WORKSPACE, subject = ADA): string {
  const value = documentScope(subject, workspace, item, 'note');
  if (value === undefined) throw new Error('No scope.');
  return value;
}

/** A Yjs update shaped the way the editor stores a note: paragraphs, and here a code block. */
function noteUpdate(paragraphs: readonly string[], code?: string): Uint8Array {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment('default');
  const blocks = paragraphs.map((text) => {
    const paragraph = new Y.XmlElement('paragraph');
    paragraph.insert(0, [new Y.XmlText(text)]);
    return paragraph;
  });
  if (code !== undefined) {
    const block = new Y.XmlElement('codeBlock');
    block.insert(0, [new Y.XmlText(code)]);
    blocks.push(block);
  }
  fragment.insert(0, blocks);
  return Y.encodeStateAsUpdate(doc);
}

beforeEach(async () => {
  vi.stubGlobal('localStorage', memoryStorage());
  resetPhraseLibrary();
  await clearBodyCache();
  await openBodyCache(ADA);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('reading a cached body as text', () => {
  it('reads every paragraph and leaves code out, with no editor involved', () => {
    const text = proseTextOfUpdate(noteUpdate(['First line.', 'Second line.'], 'const x = 1'));

    expect(text).toContain('First line.');
    expect(text).toContain('Second line.');
    expect(text).not.toContain('const');
  });

  it('stops at its character budget', () => {
    expect(proseTextOfUpdate(noteUpdate(['abcdefghij']), 4)).toHaveLength(4);
  });
});

describe('the phrase library', () => {
  it('suggests from another note in the same workspace', () => {
    learnBody(scope('other'), PHRASE);

    const models = libraryModels(ADA, WORKSPACE, scope('current'));
    expect(completePhrase('the launch ch', models)?.text).toBe('ecklist is ready');
  });

  it('never offers a workspace its neighbour learned', () => {
    learnBody(scope('other', 'workspace-2'), PHRASE);

    expect(libraryModels(ADA, WORKSPACE)).toEqual([]);
  });

  it('leaves out the note being edited, which has its own model', () => {
    learnBody(scope('current'), PHRASE);

    expect(libraryModels(ADA, WORKSPACE, scope('current'))).toEqual([]);
  });

  it('refuses to learn while nobody is signed in', async () => {
    await clearBodyCache();

    learnBody(scope('other'), PHRASE);

    expect(libraryModels(ADA, WORKSPACE)).toEqual([]);
  });

  it('holds a bounded number of bodies, dropping the oldest learned', () => {
    for (let index = 0; index <= MAX_LIBRARY_BODIES; index += 1) {
      learnBody(scope(`item-${String(index)}`), PHRASE);
    }

    expect(libraryModels(ADA, WORKSPACE)).toHaveLength(MAX_LIBRARY_BODIES);
    expect(libraryModels(ADA, WORKSPACE, scope('item-0'))).toHaveLength(MAX_LIBRARY_BODIES);
  });
});

describe('forgetting what the body cache forgets', () => {
  // A fresh item per test: a sealed item stays sealed for the module's lifetime, as it does for
  // a page's, so reusing one would leave later tests learning nothing for the wrong reason.
  let item = '';
  let sequence = 0;
  beforeEach(() => {
    sequence += 1;
    item = `forgettable-${String(sequence)}`;
    learnBody(scope(item), PHRASE);
    expect(libraryModels(ADA, WORKSPACE)).toHaveLength(1);
  });

  it('forgets everything at sign-out', async () => {
    await clearBodyCache();

    expect(libraryModels(ADA, WORKSPACE)).toEqual([]);
  });

  it('forgets a body the collaboration service refused', async () => {
    await discardBodyCache(scope(item));

    expect(libraryModels(ADA, WORKSPACE)).toEqual([]);
  });

  it('forgets an item found to be locked, and will not learn it again this session', async () => {
    await sealItemBodies(ADA, WORKSPACE, item);

    expect(libraryModels(ADA, WORKSPACE)).toEqual([]);
    learnBody(scope(item), PHRASE);
    expect(libraryModels(ADA, WORKSPACE)).toEqual([]);
  });

  it('forgets a workspace that is no longer reachable', async () => {
    await pruneBodyCache(ADA, ['workspace-elsewhere']);

    expect(libraryModels(ADA, WORKSPACE)).toEqual([]);
  });

  it('forgets everything when a different person signs in', async () => {
    await openBodyCache('subject-bo');

    expect(libraryModels(ADA, WORKSPACE)).toEqual([]);
  });
});

describe('learning from copies the body cache already holds', () => {
  it('reads this workspace’s cached notes on idle, skipping the one being edited', async () => {
    await writeBodyCache({
      scope: scope('cached'),
      docId: 'doc-cached',
      schemaVersion: 1,
      savedAt: Date.now(),
      update: noteUpdate([PHRASE]),
    });
    await writeBodyCache({
      scope: scope('current'),
      docId: 'doc-current',
      schemaVersion: 1,
      savedAt: Date.now(),
      update: noteUpdate(['Something else entirely.']),
    });

    warmPhraseLibrary(ADA, WORKSPACE, scope('current'), new AbortController().signal);

    await vi.waitFor(() => {
      expect(libraryModels(ADA, WORKSPACE)).toHaveLength(1);
    });
    expect(completePhrase('the launch ch', libraryModels(ADA, WORKSPACE))?.text).toBe(
      'ecklist is ready',
    );
  });
});

describe('handing a closed note to the library', () => {
  function closeNote(learnable: boolean, enabled = true): void {
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: [...nixEditingExtensions, GhostText],
      content: `<p>${PHRASE}</p>`,
    });
    setGhostTextContext(editor, {
      enabled,
      learnable,
      subject: ADA,
      workspaceId: WORKSPACE,
      scope: scope('closing'),
    });
    editor.destroy();
  }

  it('learns a note that may keep a local copy when it closes', () => {
    closeNote(true);

    expect(libraryModels(ADA, WORKSPACE)).toHaveLength(1);
  });

  it('does not learn a note that may not be kept, such as a locked one', () => {
    closeNote(false);

    expect(libraryModels(ADA, WORKSPACE)).toEqual([]);
  });

  it('holds nothing at all while suggestions are switched off', () => {
    closeNote(true, false);

    expect(libraryModels(ADA, WORKSPACE)).toEqual([]);
  });
});
