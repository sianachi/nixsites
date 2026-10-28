import { useSheetGesture } from './use-sheet-gesture';
import { X } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';

import { cn } from '../lib/cn';
import { blueprintFrame } from '../primitives/Blueprint';
import { Icon } from '../primitives/Icon';
import { Text } from '../primitives/Text';
import { focusRingInset } from '../primitives/interaction';
import { Button } from './Button';

/**
 * <Dialog> - a modal, on the platform's own `<dialog>`.
 *
 * Opened with `showModal()`, which is the whole reason to use the element rather than a positioned
 * div: the browser puts it in the top layer, renders a real `::backdrop`, makes the rest of the
 * document inert, and therefore traps focus and translates Escape without a keydown handler of
 * ours in the way. A hand-rolled focus trap is a list of edge cases (iframes, shadow roots, the
 * browser's own chrome, elements that become focusable while the dialog is open) that the platform
 * has already enumerated correctly, and every one it gets wrong is a keyboard user stranded behind
 * a modal.
 *
 * What is left for this component is the part the platform does not do:
 *
 * - **Focus in.** The dialog element itself takes focus, not the first button, so a screen reader
 *   announces the dialog and its title before the actions rather than starting mid-sentence at
 *   "Cancel". `initialFocus` overrides that for the dialog whose whole purpose is one field. It is
 *   a ref rather than an `autofocus` attribute because React never renders that attribute - it
 *   focuses on mount instead, and this dialog's content mounts long before it opens.
 * - **Focus back.** The invoker is remembered on open and refocused on close - including when the
 *   dialog is unmounted while open, which is how most callers close one. Focus falling to the body
 *   sends the next Tab to the top of the page, which is nowhere near where the person was.
 * - **A visible way out.** Escape and the backdrop are invisible affordances; the close control in
 *   the corner is the one a pointer user can see. It is not optional, because `actions` is.
 * - **Escape stays in this layer.** The platform still turns Escape into `cancel`, but the keydown
 *   does not bubble to an outer non-modal overlay and close two layers at once.
 *
 * **Open is the caller's, not the element's.** Escape and backdrop clicks are intercepted and
 * reported through `onClose` rather than allowed to close the element, so the DOM can never be
 * closed while the prop still says open. Whoever owns the flag decides when it flips - which is
 * also what lets a dialog refuse to close over unsaved work.
 *
 * **`dirty` refuses a dismissal, once, in-place.** A caller with something worth losing - typed
 * text, a changed selection - sets `dirty` once the person has actually changed something since the
 * dialog opened. Escape, the backdrop, the corner close control and the mobile swipe gesture then
 * stop reaching `onClose` directly: the first attempt shows an inline "Discard what you typed?"
 * prompt in place of the body, with focus on "Keep editing" so an accidental second dismissal
 * cannot compound the first, and only its own "Discard" button calls `onClose`. An explicit Cancel
 * button in `actions` is not routed through this - it stays the caller's own control, because a
 * caller that put a Cancel button there already made its own call about warning on it.
 *
 * **When not to use this.** A disclosure that must render as a sibling of an ancestor the user
 * still needs on screen - a header with its own toggle and search, say - cannot use `showModal()`:
 * the top layer is anchored to the viewport, and covering the viewport is precisely what such a
 * disclosure exists not to do. `packages/web-foundation/src/layout/sidebar-drawer.tsx` is that exception, applying
 * `inert` to what it covers instead of trapping focus; see ADR-0029 for the full reasoning and the
 * Escape-layering convention a non-modal overlay of this kind has to follow.
 */

export interface DialogProps {
  /** Whether the modal is showing. The caller owns it; the element only reflects it. */
  readonly open: boolean;

  /**
   * The modal's title, and its accessible name. Required: a dialog announced only as "dialog"
   * gives a screen reader user nothing to decide with.
   */
  readonly title: string;

  /**
   * Asked to close - by Escape, by the backdrop, or by the close control. Whether that actually
   * closes anything is the caller's decision.
   */
  readonly onClose: () => void;

  /** The body. */
  readonly children: ReactNode;

  /**
   * The actions, laid out along the trailing edge. Buttons, in reading order: the primary action
   * last, since it is the one the eye lands on before it leaves the box.
   */
  readonly actions?: ReactNode;

  /** Names the close control. Overridable because "Close" is not always the honest word for it. */
  readonly closeLabel?: string;

  /**
   * Where focus should land instead of on the dialog itself - the one field of a rename dialog,
   * say. Ignored if the element is not there when the dialog opens, which is the safe failure: the
   * dialog keeps the focus rather than leaving it behind on the page.
   */
  readonly initialFocus?: RefObject<HTMLElement | null>;

  /** Layout only - width, margin. Never a restyle of the frame or the backdrop. */
  readonly className?: string;
  /** Full-screen on phones, spacious item workspace on desktop. */
  readonly presentation?: 'standard' | 'workspace';
  /** The body supplies a visible heading, for example an editable item title. */
  readonly titleHidden?: boolean;
  /** Opt in only when the caller can safely handle a swipe dismissal request. */
  readonly swipeToClose?: boolean;

  /**
   * There is unsaved work a dismissal would silently discard. While true, Escape, the backdrop,
   * the close control and the swipe gesture stop calling `onClose` directly and instead show an
   * inline "Discard what you typed?" prompt; only that prompt's own Discard button calls it.
   * Leave it `false` for a dialog with nothing to lose, or whose only field mirrors state the
   * caller already persists as it changes.
   */
  readonly dirty?: boolean;
}

export function Dialog(props: DialogProps): ReactNode {
  const {
    open,
    title,
    onClose,
    children,
    actions,
    closeLabel = 'Close',
    initialFocus,
    className,
    presentation = 'standard',
    titleHidden = false,
    swipeToClose = false,
    dirty = false,
  } = props;

  const titleId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const handleRef = useRef<HTMLButtonElement>(null);
  const keepEditingRef = useRef<HTMLButtonElement>(null);
  const invokerRef = useRef<HTMLElement | null>(null);

  // A dismissal attempt while `dirty` shows the inline prompt instead of closing. It is not reset
  // to false as soon as `dirty` drops - only a Keep-editing/Discard decision or the dialog leaving
  // `open` should clear a prompt already on screen.
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);

  // Adjusted during render rather than in an effect - the recommended way to reset state on a
  // prop change - so a prompt left on screen does not survive the dialog actually closing and
  // reopening for something new.
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (!open) setConfirmingDiscard(false);
  }

  const requestClose = useCallback((): void => {
    if (dirty) {
      setConfirmingDiscard(true);
      return;
    }
    onClose();
  }, [dirty, onClose]);

  const keepEditing = (): void => {
    setConfirmingDiscard(false);
  };

  const discard = (): void => {
    setConfirmingDiscard(false);
    onClose();
  };

  useSheetGesture(
    dialogRef,
    handleRef,
    open && swipeToClose && presentation === 'standard',
    requestClose,
  );

  useEffect(() => {
    if (confirmingDiscard) {
      keepEditingRef.current?.focus();
    }
  }, [confirmingDiscard]);

  useEffect(() => {
    const element = dialogRef.current;
    const viewport = window.visualViewport;
    if (!open || !element || !viewport) return;
    const measure = (): void => {
      // Runtime viewport geometry keeps sheets above the software keyboard, including iOS.
      element.style.setProperty(
        '--sheet-keyboard-inset',
        `${String(Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop))}px`,
      );
      element.style.setProperty('--sheet-viewport-height', `${String(viewport.height)}px`);
      element.style.setProperty('--sheet-viewport-top', `${String(viewport.offsetTop)}px`);
    };
    measure();
    viewport.addEventListener('resize', measure);
    viewport.addEventListener('scroll', measure);
    return () => {
      viewport.removeEventListener('resize', measure);
      viewport.removeEventListener('scroll', measure);
      element.style.removeProperty('--sheet-keyboard-inset');
      element.style.removeProperty('--sheet-viewport-height');
      element.style.removeProperty('--sheet-viewport-top');
    };
  }, [open]);

  useEffect(() => {
    const element = dialogRef.current;
    if (element === null) {
      return;
    }

    if (open) {
      if (!element.open) {
        const active = document.activeElement;
        invokerRef.current = active instanceof HTMLElement ? active : null;
        element.showModal();
        (initialFocus?.current ?? element).focus();
      }
      return;
    }

    if (element.open) {
      element.close();
    }

    const invoker = invokerRef.current;
    invokerRef.current = null;
    if (invoker?.isConnected === true) {
      invoker.focus();
    }
    // `initialFocus` is a ref, so it is stable and only `open` ever re-runs this in practice; it is
    // listed because the effect reads it, not because it moves.
  }, [open, initialFocus]);

  useEffect(() => {
    // The ref object, not its contents: the cleanup below runs after the component is gone, and
    // reading `invokerRef.current` at that point is only sound because the ref object it belongs to
    // was captured while the component was alive.
    const invokers = invokerRef;

    return () => {
      const invoker = invokers.current;
      if (invoker?.isConnected === true) {
        invoker.focus();
      }
    };
  }, []);

  useEffect(() => {
    const element = dialogRef.current;
    if (element === null) {
      return;
    }

    // Backdrop handling needs the native event's target; cancel remains browser-owned.
    const onCancel = (event: Event): void => {
      event.preventDefault();
      requestClose();
    };

    // A press that starts inside and finishes on the backdrop is a text selection that overshot,
    // not a dismissal. Both ends of the press have to land outside before the modal closes.
    let pressStartedOnBackdrop = false;

    const onPointerDown = (event: MouseEvent): void => {
      pressStartedOnBackdrop = event.target === element;
    };

    const onClick = (event: MouseEvent): void => {
      const outside = pressStartedOnBackdrop && event.target === element;
      pressStartedOnBackdrop = false;
      if (outside) {
        requestClose();
      }
    };

    element.addEventListener('cancel', onCancel);
    element.addEventListener('mousedown', onPointerDown);
    element.addEventListener('click', onClick);

    return () => {
      element.removeEventListener('cancel', onCancel);
      element.removeEventListener('mousedown', onPointerDown);
      element.removeEventListener('click', onClick);
    };
    // `requestClose` closes over `onClose` and `dirty` and is recreated with them, so listing it
    // alone keeps this in step with both without a separate, easy-to-miss entry for each.
  }, [requestClose]);

  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- Escape containment belongs to the modal dialog.
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      // React bubbles child disclosures first, so Escape closes the innermost panel.
      onKeyDown={(event) => {
        if (event.key === 'Escape') event.stopPropagation();
      }}
      // Focus has to land somewhere inside on open, and the element is only a landing spot - there
      // is nothing here to operate, so the 2px accent ring every control wears would be drawn
      // around an entire modal to indicate nothing. The frame and the backdrop already say where
      // the boundary is.
      tabIndex={-1}
      className={cn(
        blueprintFrame,
        // Preflight zeroes the margin a modal `<dialog>` relies on to centre itself.
        'm-auto p-0 shadow-lg outline-none',
        // Opaque, unlike a card: a transparent line drawing over live content is unreadable, and
        // this is the one place in the system where a surface has to sit on top of another.
        'bg-background text-foreground',
        // design-token-exempt: 560px is a comfortable reading measure for a modal, not a step on
        // any scale - the same category as the shell's sidebar and panel widths, which
        // packages/web-foundation/src/layout/regions.ts keeps out of the token sheet for the same reason. Making it a
        // token would have the design system carry one number used in one place, and the gutter
        // beside it already comes from `--spacing`.
        'w-[min(560px,calc(100vw-var(--spacing)*8))]',
        // The scrim is the one colour in the library that must *not* follow the ground. It exists
        // to dim what is behind the modal, and an ink wash of `--color-foreground` stops doing
        // that the moment the foreground is paper: on the dark ground it would be a light veil
        // that brightens the page instead of pushing it back. The neutral ramp does not move
        // between grounds (ADR-0008), so its deepest step is the one thing here that darkens on
        // both - which is why this is a ramp step rather than a role. It is one of exactly two:
        // the other is `<Duotone>`, whose two tones must not move for the same kind of reason.
        'backdrop:bg-neutral-900/40',
        presentation === 'standard' &&
          // design-token-exempt: runtime keyboard and visual viewport geometry.
          'max-sm:mb-[var(--sheet-keyboard-inset,0%)] max-sm:max-h-[var(--sheet-viewport-height,100dvh)] max-sm:mt-auto max-sm:w-full max-sm:max-w-full max-sm:rounded-b-none',
        presentation === 'workspace' &&
          // design-token-exempt: runtime keyboard and visual viewport geometry.
          'h-dvh max-h-dvh w-screen max-w-full max-sm:h-[var(--sheet-viewport-height,100dvh)] max-sm:mt-[var(--sheet-viewport-top,0%)] max-sm:mb-auto sm:h-[90dvh] sm:w-11/12 sm:max-w-6xl',
        className,
      )}
    >
      {swipeToClose && presentation === 'standard' ? (
        <button
          ref={handleRef}
          type="button"
          aria-label="Dismiss sheet"
          onClick={requestClose}
          className="flex min-h-(--control-lg) w-full touch-none items-center justify-center rounded-t-md focus-visible:outline-2 focus-visible:outline-accent sm:hidden"
        >
          <span aria-hidden="true" className="h-1 w-10 rounded-full bg-divider" />
        </button>
      ) : null}
      {/* The scroll lives here rather than on the element itself so a long body scrolls inside the
          frame, and the registration marks - which sit 6px outside it - are never clipped. */}
      <div
        className={
          presentation === 'workspace'
            ? // design-token-exempt: device safe areas protect full-screen mobile dialog controls.
              'flex h-full min-h-0 flex-col gap-2 p-3 pt-[max(var(--spacing)*3,env(safe-area-inset-top))] pb-[max(var(--spacing)*3,env(safe-area-inset-bottom))] sm:p-6'
            : // design-token-exempt: viewport and device safe-area constrain the mobile sheet. The
              // frame itself is capped here, at whichever of the two is smaller: 80vh most of the
              // time, or the on-screen-keyboard-adjusted visual viewport once one is up. Below,
              // only the body scrolls - the header and the actions are flex items beside it, not
              // inside it, so a tall body can never carry them out of view.
              'flex min-h-0 max-h-[min(80dvh,var(--sheet-viewport-height,100dvh))] flex-col gap-3 p-3 pb-[max(var(--spacing)*3,env(safe-area-inset-bottom))] sm:gap-4 sm:p-6'
        }
      >
        <div
          className={
            titleHidden
              ? 'absolute right-3 top-3 z-30 flex items-start gap-4'
              : 'flex min-w-0 shrink-0 items-start gap-3'
          }
        >
          {/* h2, not a caller's choice: a modal is its own document for the duration, so its title
              starts a heading outline rather than joining the page's. */}
          <Text
            id={titleId}
            variant="h3"
            as="h2"
            className={titleHidden ? 'sr-only' : 'min-w-0 flex-1 break-words'}
          >
            {title}
          </Text>
          <Button
            variant="icon"
            className="shrink-0 any-pointer-coarse:min-h-(--control-lg) any-pointer-coarse:min-w-(--control-lg)"
            aria-label={closeLabel}
            onClick={requestClose}
          >
            <Icon icon={X} size="sm" />
          </Button>
        </div>

        {confirmingDiscard ? (
          // Replaces the body and actions rather than layering over them: the dialog only has one
          // decision live at a time, and the person's unsaved work is still right there underneath,
          // unchanged, if they choose to keep editing it.
          <div className="flex min-h-0 flex-1 flex-col gap-4">
            <Text variant="bodySmall">Discard what you typed?</Text>
            <div className="flex flex-wrap shrink-0 items-center justify-end gap-2">
              <Button ref={keepEditingRef} variant="secondary" onClick={keepEditing}>
                Keep editing
              </Button>
              <Button onClick={discard}>Discard</Button>
            </div>
          </div>
        ) : (
          <>
            {presentation === 'standard' ? (
              // The one scroll region in a standard dialog. `min-h-0` overrides the flex item's
              // default min-content height, which is otherwise exactly tall enough to defeat
              // `overflow-y-auto` by never shrinking below the body's own content.
              <div
                role="region"
                aria-label={`${title} content`}
                // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Justification: keyboard users need focus to scroll dialog content.
                tabIndex={0}
                className={`flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain ${focusRingInset}`}
              >
                {children}
              </div>
            ) : (
              children
            )}

            {actions === undefined ? null : (
              <div className="flex flex-wrap shrink-0 items-center justify-end gap-2">
                {actions}
              </div>
            )}
          </>
        )}
      </div>
    </dialog>
  );
}
