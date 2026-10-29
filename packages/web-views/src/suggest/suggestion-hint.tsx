import { Icon, Text, cn, focusRing } from '@nix/ui';
import { Lightbulb, X } from 'lucide-react';
import type { ReactNode } from 'react';

/**
 * The one shape every suggestion takes on screen: a quiet sentence, and the buttons that act on it.
 *
 * **Suggestions are only suggestions** - the principle `filter-rules-editor.tsx` states for its
 * property list, applied to every hint the views offer. Nothing a suggestion proposes is written
 * until somebody presses its button, and the write that button makes is the ordinary one the view
 * already makes for a typed value. So the hint has to read as an aside rather than as an
 * instruction: muted caption text, a small icon, no frame, no colour fill, and never a role that
 * interrupts. One shape for all of them so a person learns once what "this is a suggestion" looks
 * like.
 *
 * **It adds buttons and nothing else.** No landmark, no region, no status role: several views
 * compare exact role inventories (see `create-item-control.tsx`), and a hint that brought its own
 * live region would break assertions that are about the view. A caller that wants a new hint
 * announced wraps its hints in an `aria-live` container it already owns.
 */

export interface SuggestionHintProps {
  /** The sentence: what is suggested and why, in words a person can check. */
  readonly children: ReactNode;

  /** The buttons that act on it - accept, open, undo. Rendered after the sentence. */
  readonly actions?: ReactNode;

  /**
   * Draws a dismiss button, when given, and calls this when it is pressed. How long the hint stays
   * away is the caller's decision - the board remembers a stale-card dismissal until the card
   * changes, the spreadsheet forgets a fill offer once the selection moves - and so is where focus
   * goes next, since the button unmounts with the hint. Named per hint (`dismissLabel`) because
   * "Dismiss" repeated down a board cannot be told apart by anybody navigating by name.
   */
  readonly onDismiss?: () => void;
  readonly dismissLabel?: string;

  /** Layout only. */
  readonly className?: string;
}

export function SuggestionHint(props: SuggestionHintProps): ReactNode {
  const { children, actions, onDismiss, dismissLabel, className } = props;

  return (
    <div className={cn('flex items-start gap-1.5 px-1', className ?? '')}>
      <Icon icon={Lightbulb} size="sm" className="mt-0.5 shrink-0 text-muted" />
      <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <Text variant="caption" tone="muted" as="span" className="min-w-0">
          {children}
        </Text>
        {actions}
      </div>
      {onDismiss === undefined ? null : (
        <button
          type="button"
          aria-label={dismissLabel ?? 'Dismiss this suggestion'}
          title={dismissLabel ?? 'Dismiss this suggestion'}
          onClick={onDismiss}
          className={cn(
            // The same widened hit target CreateItemControl's chip uses: the drawn glyph is under
            // WCAG 2.5.8's 24px floor, the pseudo-element is not.
            'relative shrink-0 rounded-sm text-muted before:absolute before:-inset-1',
            'hover:bg-foreground/7 hover:text-foreground',
            focusRing,
          )}
        >
          <Icon icon={X} size="sm" />
        </button>
      )}
    </div>
  );
}

export interface SuggestionActionProps {
  readonly children: ReactNode;
  readonly onClick: () => void;

  /** The full name when the visible word alone ("Use", "Open") would be ambiguous. */
  readonly label?: string;
}

/** A hint's button: a small accent word, not a boxed control - the hint must not out-shout the view. */
export function SuggestionAction(props: SuggestionActionProps): ReactNode {
  const { children, onClick, label } = props;

  return (
    <button
      type="button"
      onClick={onClick}
      {...(label === undefined ? {} : { 'aria-label': label })}
      className={cn(
        'relative rounded-sm px-1 text-xs font-semibold text-accent-text before:absolute before:-inset-y-1.5 before:inset-x-0',
        'hover:bg-foreground/7',
        focusRing,
      )}
    >
      {children}
    </button>
  );
}
