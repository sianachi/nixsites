import { Button, Dialog } from '@nix/ui';
import { flushSync } from 'react-dom';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Editor } from '@tiptap/core';
import { useMobileToolbarPreference } from './mobile-toolbar-preference';

/**
 * The item's own controls when they live in the dock rather than in a row under the title: the
 * details panel's toggle, beside the item actions the dock already opens.
 */
export interface MobileNoteDetails {
  readonly open: boolean;
  readonly onToggle: () => void;
}

/** One quiet action surface, with horizontal scrolling instead of wrapped rows. */
export function MobileNoteToolbar({
  formatting,
  actions,
  details,
  editor,
}: {
  readonly formatting: ReactNode;
  readonly editor?: Editor;
  readonly actions?: ReactNode;
  readonly details?: MobileNoteDetails | undefined;
}): ReactNode {
  const visibility = useMobileToolbarPreference((state) => state.visibility);
  const [hidden, setHidden] = useState(false);
  const dockRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!editor || visibility !== 'while-writing') return;
    const writing = (): void => {
      if (editor.isFocused && editor.state.selection.empty) setHidden(true);
    };
    const selection = (): void => {
      if (!editor.state.selection.empty) setHidden(false);
    };
    editor.on('update', writing);
    editor.on('selectionUpdate', selection);
    return () => {
      editor.off('update', writing);
      editor.off('selectionUpdate', selection);
    };
  }, [editor, visibility]);
  useEffect(() => {
    const viewport = window.visualViewport;
    let frame = 0;
    const measure = (): void => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const dock = dockRef.current;
        const parent = dock?.parentElement;
        if (!dock || !parent) return;
        const bounds = parent.getBoundingClientRect();
        const bottom = viewport ? viewport.height + viewport.offsetTop : window.innerHeight;
        dock.style.setProperty(
          '--keyboard-inset',
          `${String(Math.max(0, bounds.bottom - bottom))}px`,
        );
        dock.style.setProperty(
          '--viewport-inset-left',
          `${String(Math.max(0, (viewport?.offsetLeft ?? 0) - bounds.left))}px`,
        );
        dock.style.setProperty(
          '--viewport-inset-right',
          `${String(Math.max(0, bounds.right - ((viewport?.offsetLeft ?? 0) + (viewport?.width ?? window.innerWidth))))}px`,
        );
        document.documentElement.style.setProperty(
          '--mobile-note-toolbar-clearance',
          `${String(Math.max(0, window.innerHeight - dock.getBoundingClientRect().top))}px`,
        );
        window.dispatchEvent(new Event('nix-mobile-note-toolbar-resized'));
      });
    };
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    if (dockRef.current?.parentElement) observer?.observe(dockRef.current.parentElement);
    if (dockRef.current) observer?.observe(dockRef.current);
    measure();
    viewport?.addEventListener('resize', measure);
    viewport?.addEventListener('scroll', measure);
    window.addEventListener('resize', measure);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      viewport?.removeEventListener('resize', measure);
      viewport?.removeEventListener('scroll', measure);
      window.removeEventListener('resize', measure);
      document.documentElement.style.removeProperty('--mobile-note-toolbar-clearance');
      window.dispatchEvent(new Event('nix-mobile-note-toolbar-resized'));
    };
  }, []);
  const collapsed = visibility === 'while-writing' && hidden;
  const [actionsOpen, setActionsOpen] = useState(false);
  return (
    // design-token-exempt: insets follow the runtime visual viewport and the device safe area.
    <div
      ref={dockRef}
      className="absolute left-[calc(var(--spacing)*3+var(--viewport-inset-left,0%))] right-[calc(var(--spacing)*3+var(--viewport-inset-right,0%))] bottom-[max(calc(var(--keyboard-inset,0%)+var(--spacing)*3),env(safe-area-inset-bottom))] z-20 min-w-0 rounded-md border border-divider bg-background p-1 shadow-md"
    >
      {collapsed ? (
        <Button
          variant="ghost"
          onMouseDown={(event) => {
            event.preventDefault();
          }}
          onClick={() => {
            setHidden(false);
          }}
        >
          Show writing tools
        </Button>
      ) : (
        <>
          <div className="flex min-w-0 items-center gap-1">
            <div
              className="min-w-0 flex-1 overflow-x-auto overscroll-x-contain"
              role="group"
              aria-label="Formatting actions"
              onMouseDownCapture={(event) => {
                // Portal dialogs need their own focus; dock buttons keep the text selection.
                if (
                  event.target instanceof Element &&
                  event.target.closest('button') !== null &&
                  event.currentTarget.contains(event.target)
                ) {
                  event.preventDefault();
                }
              }}
            >
              {formatting}
            </div>
            {actions || details ? (
              <Button
                variant="ghost"
                className="shrink-0"
                onClick={() => {
                  setActionsOpen(true);
                }}
              >
                Item
              </Button>
            ) : null}
            {editor ? (
              <Button
                variant="ghost"
                className="shrink-0"
                onClick={() => {
                  editor.commands.blur();
                }}
              >
                Done
              </Button>
            ) : null}
          </div>
        </>
      )}
      {actionsOpen ? (
        <Dialog
          open
          swipeToClose
          title="Item actions"
          onClose={() => {
            setActionsOpen(false);
          }}
        >
          {details ? (
            <Button
              variant="ghost"
              className="justify-start"
              aria-expanded={details.open}
              onClick={() => {
                // Restore focus to Item before the details dialog remembers its invoker.
                flushSync(() => {
                  setActionsOpen(false);
                });
                details.onToggle();
              }}
            >
              Details
            </Button>
          ) : null}
          {actions}
        </Dialog>
      ) : null}
    </div>
  );
}
