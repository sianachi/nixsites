import { X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';

import { Icon } from '../primitives/Icon';
import { Text } from '../primitives/Text';
import { Button } from './Button';

const DEFAULT_DURATION_MS = 8000;

interface ToastAction {
  /** What the action does, e.g. "Undo". Rendered as the button's label. */
  readonly label: string;
  /** Invoked on activation. The toast is dismissed immediately afterwards, whatever this does. */
  readonly onAction: () => void;
}

/**
 * <Toast> - a transient notice about something that already happened, with room for one way to
 * undo it.
 *
 * Built for one caller today - a deletion the sidebar used to gate behind `window.confirm()` - but
 * shaped as a general "this happened, here is the one thing you can still do about it" notice
 * rather than wired to deletion specifically, so a second caller (an archive, a bulk move) can
 * reach for it without a rewrite. What it deliberately does not grow into: a position prop or a
 * severity/variant axis - `action` stays the single optional recovery this component knows about,
 * one per notice. It is not itself a queue: each `<Toast>` reports exactly one thing that happened.
 * A caller wanting more than one on screen at once - `app-shell.tsx` allows up to two pending
 * deletions, so a third delete does not erase a second one's undo window - mounts more than one
 * `<Toast>`, each independent, rather than asking this component to grow a list prop.
 *
 * **`role="status"`, not `role="alert"`.** The two differ in urgency, not in whether they get
 * announced: `alert` is for something that demands attention now - a failed save, a validation
 * error - and a screen reader may cut off whatever it is reading to announce one. A completed
 * deletion is not that: it is an advisory the reader can finish their sentence before hearing,
 * which is what `status`'s implicit `aria-live="polite"` gives it. Reaching for `alert` because
 * the notice is *time-limited* would be conflating urgency with expiry - the timeout is handled
 * below, not by raising the announcement's priority. The same holds for a notice reporting that a
 * recovery attempt itself failed (a restore that did not go through, say): it is unwelcome news,
 * but not one that demands the reader's attention be interrupted for it, and there is nothing left
 * to do about it from here but try again some other way - so it stays `status` too rather than this
 * component growing a severity axis to give it `alert` instead.
 *
 * **Why this needed a new primitive instead of `announcer.ts`'s live region.** That region is one
 * `<p aria-live="polite" className="sr-only">` for the whole shell, and it is `sr-only` on purpose
 * - it exists to speak a change that already happened on screen, never to *be* the on-screen
 * change. A toast is the opposite: the message and its Undo button are the visible event, and a
 * button cannot be reached by anyone if the element holding it is `sr-only`. So this renders its
 * own visible `role="status"` region rather than pushing text through `announce()` - doing both
 * would announce the same sentence twice.
 *
 * **Focus, in both directions.** The control that opened a toast of this kind is usually gone by
 * the time it mounts - the deleted row it belonged to - so the browser has already dropped focus
 * to `<body>` before this component's own effects run. Landing focus on the primary action (Undo,
 * or the dismiss control when there is none) recovers it rather than leaving a keyboard user
 * stranded at the top of the document; unlike `<Dialog>`, there is no invoker to send focus back
 * to when this closes, so `returnFocusRef` lets the caller nominate a durable landing spot instead
 * (`app-shell.tsx` points it at the workspace tree's own scroll region). Omitting it is only safe
 * when the caller already has somewhere better in mind - the default is `document.body`, the same
 * place focus would have ended up anyway.
 *
 * **`autoFocus`, for the one caller where that story does not hold.** The mount-focus reasoning
 * above assumes focus has nowhere better to be, which is only true when whatever opened the toast
 * is already gone. A toast pushed later in the same flow - `app-shell.tsx`'s failed-undo notice,
 * which can land seconds after Undo already returned focus to the tree, or after the reader has
 * since clicked into a document and started typing - has no such excuse: the reader is somewhere on
 * purpose, and yanking focus away to announce a failure would be the exact bug already fixed for
 * the primary toast, reproduced one step later. `autoFocus={false}` opts a caller like that out; the
 * mount effect then leaves focus wherever the platform already put it, the same safe-failure
 * reasoning `returnFocusRef` above already uses for a target that turns out to be gone. Defaults to
 * `true`, matching every caller that existed before this prop did.
 *
 * **The return is conditional, unlike `<Dialog>`'s.** `<Dialog>` restores its invoker unconditionally
 * because it is modal - focus is inside it for its entire life, by construction, so "the toast is
 * going away" and "focus is leaving it" are the same event. A toast is not modal: the ordinary path
 * is that the reader ignores it and goes back to whatever they were doing - clicking into a document
 * to keep typing, say - long before the timeout ever fires. Reclaiming focus unconditionally on
 * unmount would rip it out of that document eight seconds later, mid-sentence, and hand it to a
 * `tabIndex={-1}` region nobody asked to go to. So the cleanup below only calls `.focus()` if focus
 * was still inside this toast at the moment it closes - tracked by the same `onFocus`/`onBlur` pair
 * that already knows whether focus is inside for the pause feature, in `hasFocusWithinRef`.
 *
 * **Escape dismisses it, but only while focus is inside it.** Gated on the same `hasFocusWithinRef`
 * the pause feature and the conditional return above both read, rather than firing on every Escape
 * press anywhere in the document: an unconditional listener here would silently outrank every other
 * surface's own documented Escape handling whenever a toast happened to be up, whether or not focus
 * was anywhere near it - the off-canvas drawer's own `window` listener (`sidebar-drawer.tsx`), the
 * spreadsheet grid, the slash menu, search, `workspace-sidebar.tsx`'s `CreateMenu`, all of it - and
 * with two toasts mounted at once, `stopPropagation` does not stop a sibling listener on the same
 * `document` node, so a single Escape press would dismiss both rather than only the one actually
 * being read. Gating on focus fixes both at once: a press with focus elsewhere now correctly falls
 * through to whatever should actually handle it, and of two mounted toasts only the one that
 * currently holds focus will ever act on the keypress, which makes the sibling's non-participation
 * moot without needing a coordination mechanism between instances.
 *
 * **The timeout pauses on hover and on focus-within**, restarting from the full duration once
 * neither is true, rather than counting down through either or resuming from where it left off.
 * Reaching this control at all costs a keyboard user at least one Tab press after the deletion that
 * produced it, and a timer that never stopped for that would punish exactly the person the pause
 * exists for. Eight seconds by default: long enough to notice the toast, move a pointer or a Tab
 * press to it, and decide - Material's own guidance gives an action-bearing snackbar the longer of
 * its two durations for the same reason, and the WCAG timing-adjustable case this most resembles is
 * served by the pause rather than by a fixed multi-hour minimum, which would be a strange promise
 * for something reporting a change already made. A full restart rather than a true resume is the
 * simpler contract to reason about - "however long you stayed away, you get the whole notice
 * again" - and is no less generous to the reader than a partial-time resume would have been.
 */
export interface ToastProps {
  /** What happened, in one sentence - the visible text and the whole of what the region reports. */
  readonly message: string;

  /** The one recovery action this notice offers, if it offers one at all. */
  readonly action?: ToastAction;

  /**
   * Asked to stop being shown - by the timeout, by the action being taken, or by the dismiss
   * control. The caller owns whether anything is actually unmounted; this component never removes
   * itself.
   */
  readonly onDismiss: () => void;

  /** Milliseconds before {@link onDismiss} fires on its own. */
  readonly duration?: number;

  /**
   * Where focus lands once this closes. Whatever opened the toast is typically gone by then (see
   * the component doc), so there is no invoker to return to automatically the way `<Dialog>` does.
   * Ignored if the element is gone by the time this closes, which is the safe failure: focus is
   * left wherever the platform already put it rather than thrown at a detached node.
   */
  readonly returnFocusRef?: RefObject<HTMLElement | null>;

  /**
   * Whether the mount-focus effect (see the component doc's `autoFocus` section) should run at
   * all. Defaults to `true`, the behavior every caller got before this prop existed. Set `false`
   * for a toast pushed into a flow the reader has already moved on from - a later, unrelated
   * notice - where landing focus here would drag it away from wherever they are now.
   */
  readonly autoFocus?: boolean;

  /**
   * Never time out: for something the reader must see (a reminder), which stays until acted on or
   * dismissed. Hover/focus pause is moot then. Routine notices leave this off.
   */
  readonly persistent?: boolean;
}

export function Toast(props: ToastProps): ReactNode {
  const {
    message,
    action,
    onDismiss,
    duration = DEFAULT_DURATION_MS,
    returnFocusRef,
    autoFocus = true,
    persistent = false,
  } = props;

  const messageId = useId();
  const [paused, setPaused] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const actionRef = useRef<HTMLButtonElement>(null);
  const dismissRef = useRef<HTMLButtonElement>(null);

  // Whether focus is currently somewhere inside this toast, kept for the return-focus effect below
  // rather than read from `paused` - `paused` also goes true on hover, which is not focus, and the
  // return effect cares only about the latter. Updated by the same `onFocus`/`onBlur` pair that
  // already computes this distinction for the pause feature, so there is exactly one place that
  // decides "is focus inside this toast right now".
  const hasFocusWithinRef = useRef(false);

  // The latest `onDismiss`, read by the timer effect below instead of the prop directly. A caller
  // showing a toast in response to a state change - `app-shell.tsx`'s deletion, say -
  // has no reason to memoize the closure it passes here, and most will not; if the timer effect
  // depended on `onDismiss` itself, every render that produced a new closure (any unrelated
  // re-render of the caller, while the toast happens to be up) would restart the countdown from
  // zero, and a caller that re-renders even once every few seconds would mean nothing here ever
  // times out. Written from an effect rather than during render - a ref is not a rendering
  // concern, and render has to stay pure - so it lags a render behind `onDismiss` itself, which
  // is immaterial here: nothing reads it before the next effect flush commits it.
  const onDismissRef = useRef(onDismiss);
  useEffect(() => {
    onDismissRef.current = onDismiss;
  });

  // The mount-focus effect below, when it runs at all, fires the very first `onFocus` this element
  // ever receives, before any real Tab press or click is even possible - so it is distinguished
  // from a genuine one by order, not by inspecting the event. Left true, that first focus would
  // pause the countdown for every toast a mouse ever produces (a mouse click never focuses anything
  // else afterwards), which would mean nothing shown to a mouse user ever times out on its own - the
  // opposite of "sensible auto-dismiss". Consumed once, so the second focus event - a real Tab in,
  // from anywhere - pauses it as intended. Seeded from `autoFocus` itself: when it is `false` there
  // is no synthetic focus call below to distinguish from a real one, so the very first `onFocus` is
  // already a genuine Tab in and must not be suppressed.
  const suppressNextFocusRef = useRef(autoFocus);

  // Recovers focus the browser already dropped (see the component doc's "Focus, in both
  // directions") by landing it on the action this toast most wants pressed - unless `autoFocus` is
  // `false` (see the component doc's own section on it), in which case this does nothing and focus
  // stays wherever the platform already put it. Runs once per mount: a caller that wants this to
  // re-fire for a second, unrelated deletion arriving while a toast is already showing gives the new
  // one a fresh `key` (see `app-shell.tsx`), which remounts this component rather than merely
  // changing its props.
  useEffect(() => {
    if (!autoFocus) {
      return;
    }
    (actionRef.current ?? dismissRef.current)?.focus();
  }, [autoFocus]);

  // Returns focus on the way out - including when the caller unmounts this rather than asking it
  // to dismiss itself, which is how every path here actually closes it (there is no `open` prop to
  // flip). The ref object, not its contents, is what the effect captures: the cleanup below runs
  // after this component is gone, and reading `.current` at that point is only sound because the
  // ref object it belongs to was captured while the component was alive - the same reasoning
  // `<Dialog>` uses for its own invoker ref.
  //
  // Gated on `hasFocusWithinRef` - see the component doc's "The return is conditional" section.
  // `<Dialog>` can skip this check because it is modal; this cannot, because the ordinary way a
  // toast closes is the reader having already moved on to something else, and reclaiming focus from
  // wherever that is would be a keyboard user's cursor silently relocating mid-task.
  useEffect(() => {
    const target = returnFocusRef;

    return () => {
      const element = target?.current;
      if (hasFocusWithinRef.current && element?.isConnected === true) {
        element.focus();
      }
    };
  }, [returnFocusRef]);

  useEffect(() => {
    if (paused || persistent) {
      return;
    }

    const timer = setTimeout(() => {
      onDismissRef.current();
    }, duration);
    return () => {
      clearTimeout(timer);
    };
    // `onDismissRef` is deliberately not a dependency (it never changes identity) and `onDismiss`
    // itself is read only through it - see the ref's own comment for why.
  }, [paused, persistent, duration]);

  // Escape dismisses, matching the visible dismiss control it stands in for - but only while focus
  // is actually inside this toast, gated on the same `hasFocusWithinRef` the pause feature and the
  // return-focus effect above both read - see the component doc's own section on this. On
  // `document` rather than as a JSX `onKeyDown`, so the propagation that `stopPropagation` below
  // cuts off is the same native path an outer `window` listener (the off-canvas drawer's own,
  // `sidebar-drawer.tsx`) would otherwise receive it on - matching the convention
  // `workspace-sidebar.tsx`'s `CreateMenu` already uses for the same reason. Without the focus
  // gate this would also fire for every Escape press anywhere in the document regardless of what it
  // was meant for, and - with two toasts mounted - for both of their listeners on the same
  // keypress, since `stopPropagation` only stops a listener further out, never a sibling on the
  // same node.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape' && hasFocusWithinRef.current) {
        event.stopPropagation();
        onDismissRef.current();
      }
    }

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  // Justification: `jsx-a11y` classes `status` as non-interactive, which is a fact about how a
  // screen reader treats it, not about whether a sighted or keyboard user's hover and focus may
  // land here. Pausing the countdown while either is true is the whole feature the section above
  // documents; there is no interactive-role alternative that also carries `aria-live` semantics.
  /* eslint-disable jsx-a11y/no-noninteractive-element-interactions */
  return (
    <div
      ref={rootRef}
      role="status"
      onMouseEnter={() => {
        setPaused(true);
      }}
      onMouseLeave={() => {
        setPaused(false);
      }}
      onFocus={() => {
        hasFocusWithinRef.current = true;
        if (suppressNextFocusRef.current) {
          suppressNextFocusRef.current = false;
          return;
        }
        setPaused(true);
      }}
      onBlur={(event) => {
        // Guards against treating a blur that lands on another control inside this same toast
        // (Undo to the dismiss control, say) as focus leaving it. Belt-and-braces rather than
        // load-bearing today: a `focusout` inside the toast is always immediately followed by a
        // `focusin` that re-sets `hasFocusWithinRef` straight back to `true`, so the transient
        // intermediate state this guard exists for never actually reaches a render that reads it -
        // but it is still the correct check to keep, in case that ordering ever stops holding.
        if (!rootRef.current?.contains(event.relatedTarget)) {
          hasFocusWithinRef.current = false;
          setPaused(false);
        }
      }}
      className="flex items-center gap-3 rounded-md border border-divider bg-background px-3 py-2 shadow-md"
    >
      <Text id={messageId} variant="bodySmall" as="p" className="min-w-0 flex-1">
        {message}
      </Text>

      {action === undefined ? null : (
        <Button
          ref={actionRef}
          variant="ghost"
          aria-describedby={messageId}
          onClick={() => {
            action.onAction();
            onDismiss();
          }}
        >
          {action.label}
        </Button>
      )}

      <Button
        ref={dismissRef}
        variant="icon"
        aria-label="Dismiss"
        aria-describedby={messageId}
        onClick={onDismiss}
      >
        <Icon icon={X} size="sm" />
      </Button>
    </div>
  );
}
