import { Extension } from '@tiptap/core';
import { redo, undo } from 'y-prosemirror';

/**
 * The editor's familiar history keys, pointed at the collaborative history it actually uses.
 *
 * ProseMirror history is deliberately absent: it would undo whichever transaction happened last,
 * including a colleague's. y-prosemirror's UndoManager tracks only this client's edits and keeps
 * selections as Yjs-relative positions, which is the same history the toolbar buttons invoke.
 */
export const CollaborationHistoryKeymap = Extension.create({
  name: 'collaborationHistoryKeymap',
  // Match TipTap's collaboration extension so this history owns the browser chords even when a
  // future extension registers another keymap later in the extension list.
  priority: 1000,

  addKeyboardShortcuts() {
    return {
      'Mod-z': () => {
        undo(this.editor.state);
        // Even an empty collaborative stack owns this key. Returning false would fall through to
        // the browser's native contenteditable history, which can rewrite peer-rendered DOM.
        return true;
      },
      'Mod-Shift-z': () => {
        redo(this.editor.state);
        return true;
      },
      'Mod-y': () => {
        redo(this.editor.state);
        return true;
      },
    };
  },
});
