import type { ListboxController } from '@nix/ui';
import type { Editor } from '@tiptap/react';
import { useEffect, useState } from 'react';

/** Where a trigger's text sits, so it can be replaced exactly, and where the caret is on screen. */
export interface TriggerPlace {
  /** Document positions of the trigger's text. */
  readonly from: number;
  readonly to: number;
  /** Viewport coordinates of the caret, for `placeFloatingMenu` to clamp against. */
  readonly left: number;
  readonly top: number;
  readonly bottom: number;
}

/**
 * Shared by the reference picker and the slash menu: reads the open trigger out of the document
 * on every transaction, because the document is where the trigger lives.
 *
 * Only the tail of the block is read - `windowSize` characters. This runs on every transaction -
 * every local keystroke and every remote update arriving through the CRDT - so reading a whole
 * paragraph would allocate a fresh copy of it per keystroke per collaborator. `find` must be
 * stable (a module-level function).
 *
 * Closed when the editor loses the focus: the trigger derives from the document's selection,
 * which survives a blur, so clicking into the sidebar with a trigger half-typed would otherwise
 * leave the menu floating with its keyboard handler bound to an element nobody is typing in.
 *
 * Escape closes a trigger without unwriting it: what somebody typed is theirs. The dismissal is
 * of one position, not of the feature, so typing another trigger elsewhere opens the menu again.
 */
export function useEditorTrigger<F extends { readonly start: number }>(
  editor: Editor,
  windowSize: number,
  find: (text: string, truncated: boolean) => F | null,
): { trigger: (F & TriggerPlace) | null; open: boolean; dismiss: (at: number) => void } {
  const [trigger, setTrigger] = useState<(F & TriggerPlace) | null>(null);
  const [dismissed, setDismissed] = useState<number | null>(null);

  useEffect(() => {
    function readTrigger(): void {
      const { state } = editor;
      const { from, empty } = state.selection;
      const at = state.doc.resolve(from);
      const window = Math.max(0, at.parentOffset - windowSize);
      const text = at.parent.textBetween(window, at.parentOffset, '\n', '\n');
      const found = empty ? find(text, window > 0) : null;

      if (found === null) {
        setTrigger(null);
        return;
      }

      const coords = editor.view.coordsAtPos(from);
      setTrigger({
        ...found,
        from: from - (text.length - found.start),
        to: from,
        left: coords.left,
        top: coords.top,
        bottom: coords.bottom,
      });
    }

    function onBlur(): void {
      setTrigger(null);
    }

    readTrigger();
    editor.on('transaction', readTrigger);
    editor.on('blur', onBlur);

    return () => {
      editor.off('transaction', readTrigger);
      editor.off('blur', onBlur);
    };
  }, [editor, find, windowSize]);

  return { trigger, open: trigger !== null && trigger.from !== dismissed, dismiss: setDismissed };
}

/**
 * The keys are taken off the editor's own element, because that is what holds the focus. Capture
 * phase, so the arrow keys move the highlight rather than the caret while the menu is open. Also
 * sets `aria-activedescendant` on the editor itself: it is a textbox with a listbox attached,
 * which is what the attribute is for; without it the highlight moves silently for anybody who
 * cannot see it.
 */
export function useEditorListbox(
  editor: Editor,
  listbox: ListboxController,
  trigger: { readonly from: number } | null,
  open: boolean,
  dismiss: (at: number) => void,
): void {
  useEffect(() => {
    if (!open || trigger === null) {
      return;
    }

    const dom = editor.view.dom;
    const dismissAt = trigger.from;

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        // The innermost open layer wins and stops the event, so Escape here does not also close
        // the pane behind it. See `command-palette.tsx` for the full convention.
        event.preventDefault();
        event.stopPropagation();
        dismiss(dismissAt);
        return;
      }

      listbox.onKeyDown(event);
    }

    dom.addEventListener('keydown', onKeyDown, true);
    return () => {
      dom.removeEventListener('keydown', onKeyDown, true);
    };
  }, [dismiss, editor, listbox, open, trigger]);

  useEffect(() => {
    const dom = editor.view.dom;
    if (!open) {
      dom.removeAttribute('aria-activedescendant');
      dom.removeAttribute('aria-controls');
      return;
    }

    dom.setAttribute('aria-controls', listbox.id);
    if (listbox.activeOptionId === undefined) {
      dom.removeAttribute('aria-activedescendant');
    } else {
      dom.setAttribute('aria-activedescendant', listbox.activeOptionId);
    }

    return () => {
      dom.removeAttribute('aria-activedescendant');
      dom.removeAttribute('aria-controls');
    };
  }, [editor, listbox.activeOptionId, listbox.id, open]);
}
