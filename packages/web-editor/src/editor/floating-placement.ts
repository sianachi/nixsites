import type { Editor } from '@tiptap/react';
import { useEffect, useState, type RefObject } from 'react';

/**
 * Keeps a floating toolbar's placement in step with the editor: re-read on every transaction
 * (and on focus, when `refreshOnFocus`), and coalesced to one read per frame on scroll and resize.
 * `read` must be stable (a module-level function) and return null when nothing should float.
 *
 * The scroll listener is deliberately capture-phase on the window, so *every* scrolling element
 * on the page reaches it - a scroll event does not bubble out of the element that scrolled, and
 * the editor's own scroller is exactly the one that moves the text. Passive, because the handler
 * only ever books a frame; without the coalescing, a hundred scroll events were a hundred
 * renders, each forcing layout through `coordsAtPos`.
 *
 * Closed when focus truly leaves the editing surface. Focus moving *into* the menu is not
 * leaving - that is a keyboard user arriving - so the blur is ignored when its destination sits
 * inside the menu's own element.
 */
export function useFloatingPlacement<T>(
  editor: Editor,
  read: (editor: Editor) => T | null,
  container: RefObject<HTMLElement | null>,
  refreshOnFocus = false,
): T | null {
  const [placement, setPlacement] = useState<T | null>(null);

  useEffect(() => {
    let frame: number | null = null;

    function update(): void {
      setPlacement(editor.isDestroyed ? null : read(editor));
    }

    function schedule(): void {
      if (frame !== null) {
        return;
      }
      frame = requestAnimationFrame(() => {
        frame = null;
        update();
      });
    }

    function onBlur({ event }: { readonly event: FocusEvent }): void {
      const destination = event.relatedTarget;
      if (destination instanceof Node && container.current?.contains(destination) === true) {
        return;
      }
      setPlacement(null);
    }

    update();
    editor.on('transaction', update);
    editor.on('blur', onBlur);
    if (refreshOnFocus) {
      editor.on('focus', update);
    }
    window.addEventListener('scroll', schedule, { capture: true, passive: true });
    window.addEventListener('resize', schedule);
    const viewport = window.visualViewport;
    viewport?.addEventListener('resize', schedule);
    viewport?.addEventListener('scroll', schedule);

    return () => {
      if (frame !== null) {
        cancelAnimationFrame(frame);
      }
      editor.off('transaction', update);
      editor.off('blur', onBlur);
      if (refreshOnFocus) {
        editor.off('focus', update);
      }
      window.removeEventListener('scroll', schedule, { capture: true });
      window.removeEventListener('resize', schedule);
      viewport?.removeEventListener('resize', schedule);
      viewport?.removeEventListener('scroll', schedule);
    };
  }, [container, editor, read, refreshOnFocus]);

  return placement;
}
