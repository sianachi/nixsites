import { Extension } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { isRecord } from '@nix/web-foundation/lib/guards';
import {
  ProsemirrorBinding,
  redo,
  relativePositionToAbsolutePosition,
  ySyncPluginKey,
  yUndoPluginKey,
} from 'y-prosemirror';
import { RelativePosition } from 'yjs';

export function undoWithSelection(view: EditorView): boolean {
  const change = yUndoPluginKey.getState(view.state)?.undoManager.undo();
  if (!change) return false;

  // Yjs publishes the undone document before y-prosemirror receives the saved selection.
  const sync: unknown = ySyncPluginKey.getState(view.state);
  if (isRecord(sync) && sync.binding instanceof ProsemirrorBinding) {
    const { doc, type, mapping } = sync.binding;
    const saved: unknown = change.meta.get(sync.binding);
    if (
      isRecord(saved) &&
      saved.type === 'text' &&
      saved.anchor instanceof RelativePosition &&
      saved.head instanceof RelativePosition
    ) {
      const anchor = relativePositionToAbsolutePosition(doc, type, saved.anchor, mapping);
      const head = relativePositionToAbsolutePosition(doc, type, saved.head, mapping);
      if (anchor !== null && head !== null) {
        const tr = view.state.tr;
        tr.setSelection(TextSelection.between(tr.doc.resolve(anchor), tr.doc.resolve(head)));
        view.dispatch(tr.scrollIntoView());
      }
    }
  }
  return true;
}

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
        undoWithSelection(this.editor.view);
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
