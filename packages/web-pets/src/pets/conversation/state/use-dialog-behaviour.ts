import { useEffect, useRef, type RefObject } from 'react';
import { useLocation, useSearchParams } from 'react-router';

/** The dialog's window-level behaviour: Escape, focus targets, close on navigation, scroll lock,
 * the Tab trap and the keyboard-safe height of the full-screen layout. */
export function useDialogBehaviour({
  dialog,
  panelHeading,
  input,
  panel,
  fullscreen,
  touchLikeComposer,
  onClose,
  goBackFromPanel,
}: {
  readonly dialog: RefObject<HTMLDivElement | null>;
  readonly panelHeading: RefObject<HTMLDivElement | null>;
  readonly input: RefObject<HTMLTextAreaElement | null>;
  readonly panel: string;
  readonly fullscreen: boolean;
  readonly touchLikeComposer: boolean;
  readonly onClose: (() => void) | undefined;
  readonly goBackFromPanel: () => void;
}): void {
  const location = useLocation();
  const [search] = useSearchParams();

  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !dialog.current?.contains(document.activeElement)) return;
      // Must-fix 7: Escape inside a sub-panel backs out of it, rather than closing the whole
      // conversation the way it does from the chat panel itself. With no `onClose` (the page
      // layout) there is nothing to close, so Escape in the chat panel is left alone.
      if (panel !== 'chat') goBackFromPanel();
      else if (onClose) onClose();
      else return;
      event.stopPropagation();
    };
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('keydown', escape);
    };
  }, [dialog, goBackFromPanel, onClose, panel]);

  // Must-fix 7: the sub-panel's own heading takes focus as soon as it opens, so a screen reader
  // announces where focus landed rather than leaving it on whatever menu item was just chosen.
  useEffect(() => {
    if (panel !== 'chat') panelHeading.current?.focus();
  }, [panel, panelHeading]);

  // Must-fix 6: in the full-screen dialog the conversation has no room to share with the page behind
  // it, so a link followed from inside it (the menu's "Pet settings", a receipt's "Inspect
  // target item", a reply's own item link) must close it - otherwise the person navigates
  // somewhere new and never sees where they landed.
  const initialLocationKey = useRef(`${location.pathname}?${search.get('item') ?? ''}`);
  useEffect(() => {
    if (!fullscreen) return;
    const key = `${location.pathname}?${search.get('item') ?? ''}`;
    if (key === initialLocationKey.current) return;
    initialLocationKey.current = key;
    onClose?.();
  }, [fullscreen, location.pathname, search, onClose]);

  useEffect(() => {
    if (!fullscreen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [fullscreen]);

  // A full-screen phone dialog has no page underneath it to fall back on, so Tab is kept from
  // ever walking out of it and onto the shell painted below.
  useEffect(() => {
    if (!fullscreen) return;
    const node = dialog.current;
    if (!node) return;
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const focusable = node.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    node.addEventListener('keydown', trap);
    return () => {
      node.removeEventListener('keydown', trap);
    };
  }, [dialog, fullscreen]);

  // `100dvh` does not always shrink for the software keyboard (it depends on the browser's
  // virtual-keyboard resize mode), so the phone dialog's own height is measured from
  // `visualViewport` instead - the same approach `mobile-note-toolbar.tsx` uses - and written
  // onto the element so the composer at its bottom edge stays above the keyboard rather than
  // being covered by it.
  useEffect(() => {
    if (!fullscreen) return;
    const node = dialog.current;
    const viewport = window.visualViewport;
    if (!node) return;
    let frame = 0;
    const measure = (): void => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const height = viewport?.height ?? window.innerHeight;
        node.style.setProperty('--phone-dialog-height', `${String(height)}px`);
        node.style.setProperty('--phone-dialog-top', `${String(viewport?.offsetTop ?? 0)}px`);
      });
    };
    measure();
    viewport?.addEventListener('resize', measure);
    viewport?.addEventListener('scroll', measure);
    window.addEventListener('resize', measure);
    return () => {
      cancelAnimationFrame(frame);
      viewport?.removeEventListener('resize', measure);
      viewport?.removeEventListener('scroll', measure);
      window.removeEventListener('resize', measure);
    };
  }, [dialog, fullscreen]);

  useEffect(() => {
    if (fullscreen) dialog.current?.focus();
    else if (!touchLikeComposer) input.current?.focus();
  }, [dialog, input, fullscreen, touchLikeComposer]);
}
