import { Button, Dialog, Icon } from '@nix/ui';
import { ChevronDown, MoreHorizontal } from 'lucide-react';
import { flushSync } from 'react-dom';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Editor } from '@tiptap/core';
import { NoteStatsFooter } from './note-stats';
import { useMobileToolbarPreference } from './mobile-toolbar-preference';

/**
 * The item's own controls when they live in the dock rather than in a row under the title: the
 * details panel's toggle, beside the item actions the dock already opens.
 */
export interface MobileNoteDetails {
  readonly open: boolean;
  readonly onToggle: () => void;
}

/** The note actions stay within the dock, even when the visual viewport narrows. */
export function MobileNoteToolbar({
  formatting,
  actions,
  details,
  editor,
}: {
  readonly formatting: ReactNode;
  readonly editor?: Editor;
  readonly actions?: ReactNode | ((close: () => void) => ReactNode);
  readonly details?: MobileNoteDetails | undefined;
}): ReactNode {
  const visibility = useMobileToolbarPreference((state) => state.visibility);
  const [hidden, setHidden] = useState<'automatic' | 'manual' | null>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!editor || visibility !== 'while-writing') return;
    const writing = (): void => {
      if (editor.isFocused && editor.state.selection.empty) {
        setHidden((current) => (current === 'manual' ? current : 'automatic'));
      }
    };
    const selection = (): void => {
      if (!editor.state.selection.empty) {
        setHidden((current) => (current === 'automatic' ? null : current));
      }
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
    let clearance: number | null = null;
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
        const next = Math.max(0, window.innerHeight - dock.getBoundingClientRect().top);
        const grew = clearance !== null && next > clearance;
        clearance = next;
        document.documentElement.style.setProperty(
          '--mobile-note-toolbar-clearance',
          `${String(next)}px`,
        );
        if (grew && editor?.isFocused && !editor.isDestroyed) {
          editor.view.dispatch(editor.state.tr.scrollIntoView());
        }
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
  }, [editor]);
  const collapsed =
    hidden === 'manual' || (visibility === 'while-writing' && hidden === 'automatic');
  const [actionsOpen, setActionsOpen] = useState(false);
  return (
    // design-token-exempt: insets follow the runtime visual viewport and the device safe area.
    <div
      ref={dockRef}
      className={`relative shrink-0 min-w-0 ml-[calc(var(--spacing)*3+var(--viewport-inset-left,0%))] mr-[calc(var(--spacing)*3+var(--viewport-inset-right,0%))] mb-[max(calc(var(--keyboard-inset,0%)+var(--spacing)*3),env(safe-area-inset-bottom))] rounded-2xl bg-surface p-1 shadow-lg ${collapsed ? 'self-end' : ''}`}
    >
      {collapsed || !editor ? null : <NoteStatsFooter editor={editor} className="px-2 pb-1" />}
      <div className="flex min-w-0 items-center gap-1">
        {collapsed ? null : (
          <>
            <div
              className="min-w-0 flex-1"
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
                variant="subtle"
                className="shrink-0 px-2"
                aria-label="Item"
                onClick={() => {
                  setActionsOpen(true);
                }}
              >
                <Icon icon={MoreHorizontal} size="sm" />
              </Button>
            ) : null}
            {editor ? (
              <Button
                variant="ghost"
                className="shrink-0 px-2"
                aria-label="Done"
                onClick={() => {
                  editor.commands.blur();
                }}
              >
                <Icon icon={ChevronDown} size="sm" />
              </Button>
            ) : null}
          </>
        )}
        <Button
          variant="subtle"
          className="min-h-(--control-lg) min-w-(--control-lg) shrink-0"
          aria-label={collapsed ? 'Show writing tools' : 'Hide writing tools'}
          title={collapsed ? 'Show writing tools' : 'Hide writing tools'}
          aria-expanded={!collapsed}
          onMouseDown={(event) => {
            event.preventDefault();
          }}
          onClick={() => {
            setHidden(collapsed ? null : 'manual');
          }}
        >
          {collapsed ? 'Show writing tools' : 'Hide'}
        </Button>
      </div>
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
              variant="subtle"
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
          {typeof actions === 'function'
            ? actions(() => {
                flushSync(() => {
                  setActionsOpen(false);
                });
              })
            : actions}
        </Dialog>
      ) : null}
    </div>
  );
}
