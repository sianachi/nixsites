import { nixEditingExtensions } from '@nix/editor-schema';
import { Editor, Extension } from '@tiptap/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CollaborationHistoryKeymap } from '../../editor/collaboration-history-keymap';

const NAVIGATOR_PLATFORM: unknown = Reflect.get(navigator, 'platform');
const MODIFIER: KeyboardEventInit =
  typeof NAVIGATOR_PLATFORM === 'string' && /Mac|iP(hone|[oa]d)/.test(NAVIGATOR_PLATFORM)
    ? { metaKey: true }
    : { ctrlKey: true };

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
});

describe('collaborative history shortcut ownership', () => {
  it('claims undo ahead of a later default-priority keymap', () => {
    const competingUndo = vi.fn(() => true);
    const LaterKeymap = Extension.create({
      name: 'laterKeymap',
      addKeyboardShortcuts() {
        return { 'Mod-z': competingUndo };
      },
    });
    editor = new Editor({
      element: document.createElement('div'),
      extensions: [...nixEditingExtensions, CollaborationHistoryKeymap, LaterKeymap],
    });
    const event = new KeyboardEvent('keydown', {
      key: 'z',
      ...MODIFIER,
      bubbles: true,
      cancelable: true,
    });

    editor.view.dom.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(competingUndo).not.toHaveBeenCalled();
  });
});
