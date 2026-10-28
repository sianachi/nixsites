import { NixApiError, NixErrorKind, type Mentions } from '@nix/api-client';
import { nixEditingExtensions } from '@nix/editor-schema';
import { act } from '@testing-library/react';
import { Editor } from '@tiptap/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { frecencyScores } from '../../lib/frecency';
import { readDismissals, rememberDismissal } from '../../lib/suggestion-dismissals';
import { linkFrecencyNamespace } from '../../editor/reference-menu';
import {
  activeMention,
  dismissMention,
  IDLE_MS,
  linkMention,
  MAX_EXCLUDED_IDS,
  MAX_REQUEST_CHARS,
  mentionsIn,
  MIN_INTERVAL_MS,
  setMentionContext,
  UnlinkedMentions,
  type MentionLookup,
} from '../../editor/unlinked-mentions';
import { useChoiceOrderPreference } from '../../lib/suggestion-preferences';
import { memoryStorage } from '../memory-storage';

/**
 * Unlinked mentions against a real editor: typed text, a faked idle timer, a lookup that answers
 * when the test says so, and the underlines as decorations.
 */

const WORKSPACE = 'w-1111';
const NOTE = 'note-0000';
const ATLAS = 'item-atlas';
const BETA = 'item-beta';

let editor: Editor | null = null;

/** An in-memory `Storage`: the test environment's global is not a usable one. */
function hit(id: string, title: string): Mentions['mentions'][number]['item'] {
  return {
    id,
    workspaceId: WORKSPACE,
    type: 'note',
    title,
    parentId: null,
    updatedAt: '2026-09-01T00:00:00Z',
  };
}

function answer(entries: readonly [string, string][], truncated = false): Mentions {
  return {
    mentions: entries.map(([id, title]) => ({ item: hit(id, title), phrase: title })),
    truncated,
  };
}

interface Call {
  readonly lookup: MentionLookup;
  readonly resolve: (value: Mentions) => void;
  readonly reject: (reason: unknown) => void;
}

/** A lookup that records each call and answers only when the test resolves it. */
function deferredLookup(): {
  calls: Call[];
  find: (lookup: MentionLookup, signal: AbortSignal) => Promise<Mentions>;
} {
  const calls: Call[] = [];
  return {
    calls,
    find: (lookup) =>
      new Promise<Mentions>((resolve, reject) => {
        calls.push({ lookup, resolve, reject });
      }),
  };
}

function makeEditor(
  html: string,
  find: (lookup: MentionLookup, signal: AbortSignal) => Promise<Mentions>,
): Editor {
  const element = document.createElement('div');
  document.body.append(element);
  const created = new Editor({
    element,
    extensions: [...nixEditingExtensions, UnlinkedMentions],
    content: html,
  });
  setMentionContext(created, {
    enabled: true,
    workspaceId: WORKSPACE,
    currentItemId: NOTE,
    find,
  });
  editor = created;
  return created;
}

/** Types at the end of the last block and lets the idle pause pass. */
function typeAtEnd(target: Editor, text: string): void {
  act(() => {
    target.commands.insertContentAt(target.state.doc.content.size - 1, text);
  });
}

async function pause(ms: number = IDLE_MS + 10): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function settle(call: Call | undefined, value: Mentions): Promise<void> {
  await act(async () => {
    call?.resolve(value);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
  });
}

function underlined(target: Editor): string[] {
  return mentionsIn(target.state).map((mention) =>
    target.state.doc.textBetween(mention.from, mention.to),
  );
}

/** The underline for `text`, as the caret would find it. */
function mentionNamed(target: Editor, text: string) {
  const found = mentionsIn(target.state).find(
    (mention) => target.state.doc.textBetween(mention.from, mention.to) === text,
  );
  if (found === undefined) throw new Error(`No underline for ${text}.`);
  return found;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('localStorage', memoryStorage());
  useChoiceOrderPreference.setState({ setting: 'on', saved: true });
});

afterEach(() => {
  editor?.destroy();
  editor = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('asking about a note', () => {
  it('asks once typing pauses, in this workspace, and underlines what comes back', async () => {
    const lookup = deferredLookup();
    const target = makeEditor('<p>Notes on Project Atlas</p>', lookup.find);

    typeAtEnd(target, ' today');
    await pause();

    expect(lookup.calls).toHaveLength(1);
    expect(lookup.calls[0]?.lookup.text).toContain('Notes on Project Atlas today');
    await settle(lookup.calls[0], answer([[ATLAS, 'Project Atlas']]));

    expect(underlined(target)).toEqual(['Project Atlas']);
  });

  it('tells the server what not to suggest: the note itself, what it links to, and dismissals', async () => {
    rememberDismissal(`mention:${WORKSPACE}:${BETA}`);
    rememberDismissal('mention:another-workspace:item-elsewhere');
    const lookup = deferredLookup();
    const target = makeEditor(
      `<p>See <span data-reference data-kind="item" data-target-id="item-linked" data-label="Linked">Linked</span> and Atlas</p>`,
      lookup.find,
    );

    typeAtEnd(target, '.');
    await pause();

    const excluded = lookup.calls[0]?.lookup.excludeIds ?? [];
    expect(excluded[0]).toBe(NOTE);
    expect(excluded).toContain('item-linked');
    expect(excluded).toContain(BETA);
    expect(excluded).not.toContain('item-elsewhere');
  });

  it('never sends more exclusions than the server accepts', async () => {
    for (let index = 0; index < 400; index += 1) {
      rememberDismissal(`mention:${WORKSPACE}:dismissed-${String(index)}`);
    }
    const lookup = deferredLookup();
    const target = makeEditor('<p>Atlas</p>', lookup.find);

    typeAtEnd(target, '.');
    await pause();

    expect(lookup.calls[0]?.lookup.excludeIds).toHaveLength(MAX_EXCLUDED_IDS);
    expect(lookup.calls[0]?.lookup.excludeIds[0]).toBe(NOTE);
  });

  it('keeps a request within the server’s text limit', () => {
    expect(MAX_REQUEST_CHARS).toBe(4000);
  });

  it('still leaves out a target the note linked while the request was in flight', async () => {
    const lookup = deferredLookup();
    const target = makeEditor('<p>Atlas and Beta</p><p>more</p>', lookup.find);
    typeAtEnd(target, '.');
    await pause();

    // Linked in the second block while the answer is on its way.
    act(() => {
      target.commands.insertContentAt(target.state.doc.content.size - 1, {
        type: 'reference',
        attrs: { kind: 'item', targetId: BETA, label: 'Beta' },
      });
    });
    await settle(
      lookup.calls[0],
      answer([
        [ATLAS, 'Atlas'],
        [BETA, 'Beta'],
      ]),
    );

    expect(underlined(target)).toEqual(['Atlas']);
  });
});

describe('keeping underlines honest', () => {
  it('drops an answer for a block whose text changed while it was in flight', async () => {
    const lookup = deferredLookup();
    const target = makeEditor('<p>Project Atlas</p>', lookup.find);
    typeAtEnd(target, ' plan');
    await pause();

    typeAtEnd(target, 's');
    await settle(lookup.calls[0], answer([[ATLAS, 'Project Atlas']]));

    expect(underlined(target)).toEqual([]);
  });

  it('removes an underline the moment its text changes', async () => {
    const lookup = deferredLookup();
    const target = makeEditor('<p>Project Atlas</p>', lookup.find);
    typeAtEnd(target, ' plan');
    await pause();
    await settle(lookup.calls[0], answer([[ATLAS, 'Project Atlas']]));
    expect(underlined(target)).toEqual(['Project Atlas']);

    act(() => {
      target.commands.insertContentAt(3, 'x');
    });

    expect(underlined(target)).toEqual([]);
  });

  it('refuses to link a mention whose text is no longer what matched', async () => {
    const lookup = deferredLookup();
    const target = makeEditor('<p>Project Atlas</p>', lookup.find);
    typeAtEnd(target, ' plan');
    await pause();
    await settle(lookup.calls[0], answer([[ATLAS, 'Project Atlas']]));
    const mention = mentionNamed(target, 'Project Atlas');

    act(() => {
      target.commands.insertContentAt(3, 'x');
    });

    expect(linkMention(target, mention)).toBe(false);
    expect(target.state.doc.textContent).toContain('Prxoject Atlas');
  });

  it('links a mention as a reference and remembers the pick', async () => {
    const lookup = deferredLookup();
    const target = makeEditor('<p>Project Atlas</p>', lookup.find);
    typeAtEnd(target, ' plan');
    await pause();
    await settle(lookup.calls[0], answer([[ATLAS, 'Project Atlas']]));

    expect(linkMention(target, mentionNamed(target, 'Project Atlas'))).toBe(true);

    let linked = false;
    target.state.doc.descendants((node) => {
      if (node.type.name === 'reference' && node.attrs.targetId === ATLAS) linked = true;
    });
    expect(linked).toBe(true);
    expect(frecencyScores(linkFrecencyNamespace(WORKSPACE)).has(ATLAS)).toBe(true);
  });

  it('remembers no pick when ordering by picks is off', async () => {
    useChoiceOrderPreference.setState({ setting: 'off', saved: true });
    const lookup = deferredLookup();
    const target = makeEditor('<p>Project Atlas</p>', lookup.find);
    typeAtEnd(target, ' plan');
    await pause();
    await settle(lookup.calls[0], answer([[ATLAS, 'Project Atlas']]));

    expect(linkMention(target, mentionNamed(target, 'Project Atlas'))).toBe(true);
    expect(frecencyScores(linkFrecencyNamespace(WORKSPACE)).size).toBe(0);
  });

  it('dismisses an item for this workspace, removing its underlines and asking without it', async () => {
    const lookup = deferredLookup();
    const target = makeEditor('<p>Project Atlas</p><p>Atlas</p>', lookup.find);
    typeAtEnd(target, ' plan');
    await pause();
    await settle(lookup.calls[0], answer([[ATLAS, 'Project Atlas']]));

    dismissMention(target, mentionNamed(target, 'Project Atlas'));

    expect(underlined(target)).toEqual([]);
    expect(readDismissals().has(`mention:${WORKSPACE}:${ATLAS}`)).toBe(true);
    typeAtEnd(target, ' again');
    await pause(MIN_INTERVAL_MS);
    expect(lookup.calls.at(-1)?.lookup.excludeIds).toContain(ATLAS);
  });
});

describe('spending the rate limit carefully', () => {
  it('reuses an answer for a block typed back to text already asked about', async () => {
    const lookup = deferredLookup();
    const target = makeEditor('<p>Project Atlas</p>', lookup.find);
    typeAtEnd(target, ' x');
    await pause();
    await settle(lookup.calls[0], answer([[ATLAS, 'Project Atlas']]));

    typeAtEnd(target, 'y');
    await pause(MIN_INTERVAL_MS);
    await settle(lookup.calls[1], answer([]));
    act(() => {
      target.commands.deleteRange({
        from: target.state.doc.content.size - 2,
        to: target.state.doc.content.size - 1,
      });
    });
    await pause(MIN_INTERVAL_MS);

    expect(lookup.calls).toHaveLength(2);
    expect(underlined(target)).toEqual(['Project Atlas']);
  });

  it('keeps one request in flight and waits the minimum interval before the next', async () => {
    const lookup = deferredLookup();
    const target = makeEditor('<p>Project Atlas</p>', lookup.find);
    typeAtEnd(target, ' a');
    await pause();
    typeAtEnd(target, 'b');
    await pause();

    expect(lookup.calls).toHaveLength(1);

    await settle(lookup.calls[0], answer([]));
    await pause(IDLE_MS + 10);
    expect(lookup.calls).toHaveLength(2);
  });

  it('does not cache a truncated answer, and asks again one block at a time', async () => {
    const lookup = deferredLookup();
    const target = makeEditor('<p>Project Atlas</p><p>Beta notes</p>', lookup.find);
    typeAtEnd(target, ' x');
    await pause();
    expect(lookup.calls[0]?.lookup.text).toContain('Beta notes x');

    await settle(lookup.calls[0], answer([[ATLAS, 'Project Atlas']], true));
    // What did come back is drawn.
    expect(underlined(target)).toEqual(['Project Atlas']);

    await pause(MIN_INTERVAL_MS + IDLE_MS);
    expect(lookup.calls).toHaveLength(2);
    expect(lookup.calls[1]?.lookup.text).not.toContain('\n');
    await settle(lookup.calls[1], answer([[ATLAS, 'Project Atlas']]));

    await pause(MIN_INTERVAL_MS + IDLE_MS);
    expect(lookup.calls).toHaveLength(3);
    expect(lookup.calls[2]?.lookup.text).not.toContain('\n');
  });

  it('waits out a rate-limit refusal before asking again', async () => {
    const lookup = deferredLookup();
    const target = makeEditor('<p>Project Atlas</p>', lookup.find);
    typeAtEnd(target, ' a');
    await pause();

    await act(async () => {
      lookup.calls[0]?.reject(
        new NixApiError({
          kind: NixErrorKind.Problem,
          code: 'request.rate_limited',
          message: 'Too many requests',
          status: 429,
          retryAfterSeconds: 30,
        }),
      );
      await vi.advanceTimersByTimeAsync(0);
    });
    typeAtEnd(target, 'b');
    await pause(29_000);
    expect(lookup.calls).toHaveLength(1);

    await pause(2_000 + IDLE_MS);
    expect(lookup.calls).toHaveLength(2);
    // The refused blocks were not lost: they are asked about again.
    expect(lookup.calls[1]?.lookup.text).toContain('Project Atlas ab');
  });
});

describe('the caret in a mention', () => {
  it('finds the mention the caret is in', async () => {
    const lookup = deferredLookup();
    const target = makeEditor('<p>Project Atlas</p>', lookup.find);
    typeAtEnd(target, ' plan');
    await pause();
    await settle(lookup.calls[0], answer([[ATLAS, 'Project Atlas']]));

    act(() => {
      target.commands.setTextSelection(4);
    });

    expect(activeMention(target.state)?.itemId).toBe(ATLAS);
  });
});
