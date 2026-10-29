import type { Mentions } from '@nix/api-client';
import { nixEditingExtensions } from '@nix/editor-schema';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAnnouncement } from '@nix/web-foundation/a11y/announcer';
import { MentionBubble } from '../../editor/mention-bubble';
import {
  IDLE_MS,
  mentionsIn,
  setMentionContext,
  UnlinkedMentions,
} from '../../editor/unlinked-mentions';
import { readDismissals } from '@nix/web-foundation/lib/suggestion-dismissals';
import { memoryStorage } from '@nix/web-foundation/testing/memory-storage';

/**
 * The "Link to" bubble against a real editor: it appears when the caret is moved into an
 * underlined phrase, not while somebody types through one.
 */

const WORKSPACE = 'w-1';
const ATLAS = 'item-atlas';

let captured: Editor | null = null;

/** An in-memory `Storage`: the test environment's global is not a usable one. */
const ANSWER: Mentions = {
  mentions: [
    {
      item: {
        id: ATLAS,
        workspaceId: WORKSPACE,
        type: 'note',
        title: 'Project Atlas',
        parentId: null,
        updatedAt: '2026-09-01T00:00:00Z',
      },
      phrase: 'Project Atlas',
    },
  ],
  truncated: false,
};

function Harness(): ReactNode {
  const editor = useEditor({
    extensions: [...nixEditingExtensions, UnlinkedMentions],
    content: '<p>Notes on Project Atlas</p>',
    onCreate: ({ editor: created }) => {
      captured = created;
      setMentionContext(created, {
        enabled: true,
        workspaceId: WORKSPACE,
        currentItemId: 'note',
        find: () => Promise.resolve(ANSWER),
      });
    },
  });
  return (
    <>
      <EditorContent editor={editor} />
      <MentionBubble editor={editor} />
    </>
  );
}

/** Renders, types at the end, and lets the lookup answer: the caret ends beside the mention. */
async function underlinedByTyping(): Promise<Editor> {
  render(<Harness />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  const editor = captured;
  if (editor === null) throw new Error('The editor never reported itself created.');
  vi.spyOn(editor.view, 'coordsAtPos').mockReturnValue({ left: 0, top: 0, right: 0, bottom: 0 });
  act(() => {
    editor.commands.focus();
    editor.commands.insertContentAt(editor.state.doc.content.size - 1, ' today');
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(IDLE_MS + 10);
  });
  expect(mentionsIn(editor.state)).toHaveLength(1);
  return editor;
}

function moveCaretInto(editor: Editor): void {
  act(() => {
    editor.commands.setTextSelection(12);
  });
}

beforeEach(() => {
  captured = null;
  vi.useFakeTimers();
  vi.stubGlobal('localStorage', memoryStorage());
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the mention bubble', () => {
  it('stays out of the way while somebody is typing', async () => {
    const editor = await underlinedByTyping();
    // Deleting back to the end of the title leaves the caret touching it, by an edit.
    act(() => {
      editor.commands.deleteRange({ from: 23, to: editor.state.doc.content.size - 1 });
    });
    expect(mentionsIn(editor.state)).toHaveLength(1);
    expect(editor.state.selection.head).toBe(23);

    expect(screen.queryByRole('button', { name: /Link to/ })).not.toBeInTheDocument();
  });

  it('appears when the caret is moved into an underlined phrase', async () => {
    const editor = await underlinedByTyping();

    moveCaretInto(editor);

    expect(screen.getByRole('button', { name: 'Link to Project Atlas' })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Don’t suggest linking Project Atlas' }),
    ).toBeInTheDocument();
  });

  it('hides for that mention on Escape', async () => {
    const editor = await underlinedByTyping();
    moveCaretInto(editor);

    fireEvent.keyDown(editor.view.dom, { key: 'Escape' });

    expect(screen.queryByRole('button', { name: /Link to/ })).not.toBeInTheDocument();
    act(() => {
      editor.commands.setTextSelection(13);
    });
    expect(screen.queryByRole('button', { name: /Link to/ })).not.toBeInTheDocument();
  });

  it('keeps Escape to itself while it is shown, so nothing behind the note also closes', async () => {
    const editor = await underlinedByTyping();
    moveCaretInto(editor);
    const outer = vi.fn();
    document.addEventListener('keydown', outer);

    fireEvent.keyDown(editor.view.dom, { key: 'Escape' });
    document.removeEventListener('keydown', outer);

    expect(outer).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /Link to/ })).not.toBeInTheDocument();
  });

  it('lets Escape through when it is not shown', async () => {
    const editor = await underlinedByTyping();
    const outer = vi.fn();
    document.addEventListener('keydown', outer);

    fireEvent.keyDown(editor.view.dom, { key: 'Escape' });
    document.removeEventListener('keydown', outer);

    expect(outer).toHaveBeenCalledTimes(1);
  });

  it('says where a dismissed suggestion can be brought back', async () => {
    const editor = await underlinedByTyping();
    moveCaretInto(editor);
    const { result } = renderHook(() => useAnnouncement());

    fireEvent.click(screen.getByRole('button', { name: 'Don’t suggest linking Project Atlas' }));

    expect(result.current.text.trim()).toBe(
      'Project Atlas will not be suggested in this workspace again. You can bring it back in Settings.',
    );
  });

  it('stops suggesting the item in this workspace when asked to', async () => {
    const editor = await underlinedByTyping();
    moveCaretInto(editor);

    fireEvent.click(screen.getByRole('button', { name: 'Don’t suggest linking Project Atlas' }));

    expect(readDismissals().has(`mention:${WORKSPACE}:${ATLAS}`)).toBe(true);
    expect(mentionsIn(editor.state)).toHaveLength(0);
  });

  it('links the mention from its button', async () => {
    const editor = await underlinedByTyping();
    moveCaretInto(editor);

    fireEvent.click(screen.getByRole('button', { name: 'Link to Project Atlas' }));

    const references: string[] = [];
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'reference') references.push(String(node.attrs.targetId));
    });
    expect(references).toEqual([ATLAS]);
  });
});
