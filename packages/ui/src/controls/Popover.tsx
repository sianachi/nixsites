import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';

import { cn } from '../lib/cn';
import { blueprintFrame } from '../primitives/Blueprint';
import { chromeSurface } from '../primitives/interaction';
import { useAnchoredPanel } from './use-anchored-panel';

/**
 * <Popover> - a button that discloses a small non-modal panel of controls: a filter, a sort, one
 * cell's editor.
 *
 * **Not a menu, and that is why it exists.** `<Menu>` can carry bespoke `content` entries, but it
 * announces itself as `role="menu"` and owns the arrow keys, which is wrong for a form: a screen
 * reader would describe a set of fields as a list of commands, and ArrowDown in a select would
 * fight the menu for the key. This is the disclosure-dialog pattern instead - `role="dialog"`,
 * focus moved into the panel on open and handed back to the trigger on Escape, the page behind it
 * still usable.
 *
 * **Placed exactly as a menu is** (see `use-anchored-panel.ts`): beside its trigger on a wide
 * screen, flipped above when there is no room, and a bottom sheet on a phone - the same device
 * concession `<Dialog>` and `<Menu>` already make, so a filter opened on a phone sits within reach
 * of the thumb rather than under the keyboard.
 */

export interface PopoverHelpers {
  /** Closes the panel and returns focus to the trigger, as Escape does. */
  readonly close: () => void;
}

/** Handed to the render-prop trigger. Spread directly onto a `<Button>` or a plain `<button>`. */
export interface PopoverTriggerRenderProps {
  readonly ref: RefObject<HTMLButtonElement | null>;
  readonly type: 'button';
  readonly 'aria-haspopup': 'dialog';
  readonly 'aria-expanded': boolean;
  readonly 'aria-controls': string;
  readonly onClick: () => void;
}

export interface PopoverProps {
  /** The panel's accessible name - what it is for. */
  readonly label: string;
  /** Renders the trigger. Spread the argument onto a `<Button>` or a plain `<button>`. */
  readonly trigger: (trigger: PopoverTriggerRenderProps) => ReactNode;
  readonly children: ReactNode | ((helpers: PopoverHelpers) => ReactNode);
  /** Open from outside - a cell editor opened by a keystroke rather than a click. */
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  /** Keep a live preview open while the person interacts with the page behind it. */
  readonly dismissOnOutside?: boolean;
  /** Layout only - the panel's own width, never a restyle of the frame. */
  readonly className?: string;
}

export function Popover(props: PopoverProps): ReactNode {
  const { label, trigger, children, className, onOpenChange } = props;

  const panelId = useId();
  const [ownOpen, setOwnOpen] = useState(false);
  const open = props.open ?? ownOpen;
  const triggerRef = useRef<HTMLButtonElement>(null);
  // A counter for the same reason `<Menu>` keeps one: every close path is reachable from inside the
  // panel, and the trigger is focused from an effect rather than read during render.
  const [focusReturnToken, setFocusReturnToken] = useState(0);

  useEffect(() => {
    if (focusReturnToken === 0) return;
    triggerRef.current?.focus();
  }, [focusReturnToken]);

  const setOpen = (next: boolean): void => {
    if (props.open === undefined) setOwnOpen(next);
    onOpenChange?.(next);
  };

  // A close that resolves late (an async write) must not steal focus from wherever the person went.
  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
  });

  // Each opening is a generation; a close handed out during one opening only applies to that one.
  const [generation, setGeneration] = useState(0);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setGeneration((g) => g + 1);
  }
  const generationRef = useRef(generation);
  useEffect(() => {
    generationRef.current = generation;
  });

  const close = (returnFocus: boolean): void => {
    setOpen(false);
    if (returnFocus && openRef.current) setFocusReturnToken((token) => token + 1);
  };

  return (
    <>
      {trigger({
        ref: triggerRef,
        type: 'button',
        'aria-haspopup': 'dialog',
        'aria-expanded': open,
        'aria-controls': panelId,
        onClick: () => {
          setOpen(!open);
        },
      })}

      {open ? (
        <PopoverPanel
          id={panelId}
          label={label}
          className={className}
          triggerRef={triggerRef}
          onClose={close}
          dismissOnOutside={props.dismissOnOutside ?? true}
        >
          {typeof children === 'function'
            ? // Justification: `close` reads `openRef` when an event or a late promise calls it, never
              // while this render runs; the rule cannot see that through the render prop.
              // eslint-disable-next-line react-hooks/refs
              children({
                close: () => {
                  if (generationRef.current === generation) close(true);
                },
              })
            : children}
        </PopoverPanel>
      ) : null}
    </>
  );
}

interface PopoverPanelProps {
  readonly id: string;
  readonly label: string;
  readonly className: string | undefined;
  readonly triggerRef: RefObject<HTMLButtonElement | null>;
  readonly onClose: (returnFocus: boolean) => void;
  readonly dismissOnOutside: boolean;
  readonly children: ReactNode;
}

function PopoverPanel(props: PopoverPanelProps): ReactNode {
  const { id, label, className, triggerRef, onClose, dismissOnOutside, children } = props;
  const panelRef = useRef<HTMLDivElement>(null);

  const latest = useRef(onClose);
  useEffect(() => {
    latest.current = onClose;
  });

  useAnchoredPanel(
    panelRef,
    () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      return rect ? { left: rect.left, top: rect.top, bottom: rect.bottom } : null;
    },
    children,
  );

  // Focus moves into the panel on open - onto its first control, or the panel itself when it has
  // none - so a keyboard user is where the content is rather than left on the trigger behind it.
  useEffect(() => {
    const panel = panelRef.current;
    const first = Array.from(
      panel?.querySelectorAll<HTMLElement>('input, select, textarea, button, [href], [tabindex]') ??
        [],
    ).find((element) => !element.matches(':disabled, [aria-disabled="true"], [tabindex="-1"]'));
    (first ?? panel)?.focus();
  }, []);

  // An outside pointerdown closes it, as every other disclosure in this package does. The trigger
  // is not "outside": its own click toggles the panel, and closing here first would reopen it.
  useEffect(() => {
    if (!dismissOnOutside) return;
    function onPointerDown(event: PointerEvent): void {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) === true) return;
      if (panelRef.current?.contains(target) === true) return;
      // Blur first: unmounting a focused field fires no reliable blur, and fields commit on blur.
      const active = document.activeElement;
      if (active instanceof HTMLElement && panelRef.current?.contains(active) === true) {
        active.blur();
      }
      latest.current(false);
    }

    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [dismissOnOutside, triggerRef]);

  useEffect(() => {
    if (dismissOnOutside) return;
    function onWorkspaceEscape(event: KeyboardEvent): void {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (
        event.target instanceof Element &&
        event.target.closest('dialog[open], [popover]:popover-open')
      ) {
        return;
      }
      event.preventDefault();
      latest.current(true);
    }

    document.addEventListener('keydown', onWorkspaceEscape);
    return () => {
      document.removeEventListener('keydown', onWorkspaceEscape);
    };
  }, [dismissOnOutside]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    // Stopped at the panel so a dialog or drawer this sits inside does not close too: the
    // innermost open thing wins, the convention `<Menu>` documents.
    event.stopPropagation();
    onClose(true);
  };

  // Justification: `jsx-a11y` classes `dialog` as non-interactive, but Escape closing a dialog is
  // the WAI-ARIA dialog pattern itself, and it has to be heard on the panel so the innermost open
  // thing closes first (see `onKeyDown`). No interactive role carries dialog semantics.
  /* eslint-disable jsx-a11y/no-noninteractive-element-interactions */
  return (
    <div
      id={id}
      ref={panelRef}
      popover="manual"
      role="dialog"
      aria-label={label}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className={cn(
        blueprintFrame,
        'fixed inset-auto z-50 m-0 flex flex-col gap-3 overflow-y-auto bg-background p-3 text-foreground shadow-md',
        chromeSurface,
        // design-token-exempt: the same reading-measure floor and phone bottom-sheet concession as
        // `<Menu>`'s panel, so a popover and a menu opened from one toolbar look like one family.
        'min-w-0 max-w-[calc(100vw-16px)] sm:min-w-[220px]',
        'max-sm:rounded-b-none max-sm:pb-[max(var(--spacing)*3,env(safe-area-inset-bottom))]',
        className,
      )}
    >
      {children}
    </div>
  );
  /* eslint-enable jsx-a11y/no-noninteractive-element-interactions */
}
