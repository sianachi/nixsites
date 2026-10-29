import { nixEditingExtensions } from '@nix/editor-schema';
import { UndoRedo } from '@tiptap/extensions';
import { AllSelection } from '@tiptap/pm/state';
import { Editor } from '@tiptap/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { anchorRange, applyInlineResult } from '../../editor/inline-ai/inline-ai-apply';
import { contextFor, gatherMaterial } from '../../editor/inline-ai/inline-ai-material';
import {
  InlineAiError,
  MAX_INLINE_OUTPUT_BYTES,
  streamInline,
  truncateUtf8,
  utf8Length,
} from '../../editor/inline-ai/inline-ai-stream';
import type { NixClient } from '@nix/api-client';

const editors: Editor[] = [];
beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    clear: () => {
      values.clear();
    },
  });
});
function editorWith(text: string): Editor {
  const editor = new Editor({
    extensions: [...nixEditingExtensions, UndoRedo],
    content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] },
  });
  editors.push(editor);
  return editor;
}
afterEach(() => {
  editors.splice(0).forEach((editor) => {
    editor.destroy();
  });
  localStorage.clear();
});

describe('inline writing material and acceptance', () => {
  it('checks byte limits without splitting code points, including a suffix for continue', () => {
    expect(truncateUtf8('A界B', 4)).toBe('A界');
    expect(truncateUtf8('A界B', 4, true)).toBe('界B');
    const editor = editorWith('界'.repeat(6_000));
    editor.commands.setTextSelection({ from: 1, to: 6_001 });
    expect(gatherMaterial(editor, 'improve').problem).toBe('too_long');
    editor.commands.setTextSelection(6_001);
    expect(utf8Length(gatherMaterial(editor, 'summarise').text)).toBeLessThanOrEqual(16_000);
    expect(utf8Length(gatherMaterial(editor, 'continue').text)).toBeLessThanOrEqual(8_000);
  });
  it('accepts Select All as material and a replaceable span', () => {
    const editor = editorWith('All the words');
    editor.view.dispatch(editor.state.tr.setSelection(new AllSelection(editor.state.doc)));
    expect(gatherMaterial(editor, 'fix')).toMatchObject({
      text: 'All the words',
      hadSelection: true,
      problem: null,
      range: { from: 0, to: 15 },
    });
  });
  it('sends no context by default and bounds explicitly enabled note context', () => {
    const editor = editorWith('界'.repeat(12_000));
    expect(contextFor(editor)).toBeUndefined();
    localStorage.setItem('nix.pet.inlineContext', 'true');
    expect(utf8Length(contextFor(editor) ?? '')).toBe(31_998);
  });
  it('replaces an intact tracked selection and a single undo restores it', async () => {
    const editor = editorWith('Original words');
    const anchor = anchorRange(editor, 1, 9);
    expect(
      await applyInlineResult(
        editor,
        'Better',
        { anchor, replace: { rangeText: 'Original' }, end: 9 },
        'replace',
      ),
    ).toEqual({ kind: 'replaced' });
    expect(editor.getText()).toBe('Better words');
    expect(editor.commands.undo()).toBe(true);
    expect(editor.getText()).toBe('Original words');
    anchor.dispose();
  });
  it('keeps edits made while generating and inserts below instead of overwriting them', async () => {
    const editor = editorWith('Original words');
    const anchor = anchorRange(editor, 1, 9);
    editor.commands.insertContentAt(3, 'new');
    expect(
      await applyInlineResult(
        editor,
        'Better',
        { anchor, replace: { rangeText: 'Original' }, end: 9 },
        'replace',
      ),
    ).toEqual({ kind: 'inserted', fellBack: true });
    expect(editor.getText()).toBe('Ornewiginal words\n\nBetter');
    anchor.dispose();
  });
  it('does not apply results to an editor made read only', async () => {
    const editor = editorWith('Original');
    const anchor = anchorRange(editor, 1, 9);
    editor.setEditable(false);
    expect(
      await applyInlineResult(editor, 'Better', { anchor, replace: null, end: 9 }, 'insert'),
    ).toEqual({ kind: 'failed', reason: 'not_editable' });
    expect(editor.getText()).toBe('Original');
    anchor.dispose();
  });
});

describe('inline stream failure and completion', () => {
  const request = {
    workspaceId: 'workspace',
    itemId: 'note',
    requestId: 'attempt',
    kind: 'improve' as const,
    selection: 'Original',
  };
  function client(body: string, status = 200): NixClient {
    return {
      stream: vi.fn().mockResolvedValue(new Response(body, { status })),
    } as unknown as NixClient;
  }
  it('rejects oversized terminal and cumulative delta text before displaying it', async () => {
    const onDelta = vi.fn();
    const oversized = 'x'.repeat(MAX_INLINE_OUTPUT_BYTES + 1);
    await expect(
      streamInline(
        client(`event: done\ndata: ${JSON.stringify({ text: oversized })}\n\n`),
        request,
        { signal: new AbortController().signal, onDelta },
      ),
    ).rejects.toMatchObject({ code: 'inline.interrupted' });
    const first = 'x'.repeat(MAX_INLINE_OUTPUT_BYTES);
    await expect(
      streamInline(
        client(
          `event: delta\ndata: ${JSON.stringify({ text: first })}\n\nevent: delta\ndata: ${JSON.stringify({ text: 'extra' })}\n\n`,
        ),
        request,
        { signal: new AbortController().signal, onDelta },
      ),
    ).rejects.toMatchObject({ code: 'inline.interrupted' });
    expect(onDelta).toHaveBeenCalledExactlyOnceWith(first);
  });
  it('receives split deltas and requires a terminal done event', async () => {
    const onDelta = vi.fn();
    expect(
      await streamInline(
        client(
          'event: delta\ndata: {"text":"Better"}\n\nevent: done\ndata: {"text":"Better words"}\n\n',
        ),
        request,
        { signal: new AbortController().signal, onDelta },
      ),
    ).toEqual({ text: 'Better words' });
    expect(onDelta).toHaveBeenCalledWith('Better');
    await expect(
      streamInline(client('event: delta\ndata: {"text":"partial"}\n\n'), request, {
        signal: new AbortController().signal,
        onDelta,
      }),
    ).rejects.toMatchObject({ code: 'inline.interrupted' });
  });
  it('preserves stable error codes from Core and the provider', async () => {
    for (const [body, status, code] of [
      ['{"code":"pets.inline_disabled"}', 403, 'pets.inline_disabled'],
      ['event: error\ndata: {"code":"inline.refused"}\n\n', 200, 'inline.refused'],
    ] as const) {
      await expect(
        streamInline(client(body, status), request, {
          signal: new AbortController().signal,
          onDelta: vi.fn(),
        }),
      ).rejects.toEqual(new InlineAiError(code, status === 200 ? undefined : status));
    }
  });
});
