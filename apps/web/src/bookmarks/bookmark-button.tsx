import { Button, Icon, Text, cn, focusRing } from '@nix/ui';
import { Pin, Star } from 'lucide-react';
import type { ReactNode } from 'react';

import { useBookmarksStore, useIsKept } from '@nix/web-collections/items/use-bookmarks';

/**
 * The one control that keeps and releases an item, wherever it appears.
 *
 * **One component for every touchpoint.** Explorer shows a pin and the editor shows a star. Both
 * read the same shelf from the store, so the row and open document agree about the item's state.
 *
 * **It is a toggle, and it says which state it is in.** `aria-pressed` rather than swapping the
 * accessible name between "Bookmark" and "Remove bookmark": a toggle button is a thing with a
 * state, and a screen reader announces that state itself. Two names for one control would make the
 * same key press sound like it did two different things.
 */

export interface BookmarkButtonProps {
  readonly itemId: string;

  /** What the item is called, so the control can name what it acts on rather than "this". */
  readonly title: string;

  /**
   * Renders as a bare icon on a hover row rather than as a boxed control.
   *
   * The tree's row controls are icons and the editor's chrome is boxed; the difference is the
   * caller's to state, because only the caller knows what it sits beside.
   */
  readonly compact?: boolean | undefined;
  readonly pin?: boolean;

  readonly className?: string | undefined;

  /** Replaces the plain toggle, for a caller that wraps the action (the shelf adds undo). */
  readonly onToggle?: (() => void) | undefined;
}

export function BookmarkButton(props: BookmarkButtonProps): ReactNode {
  const { itemId, title, compact = false, className = '', onToggle } = props;
  const kept = useIsKept(itemId);
  const toggle = useBookmarksStore((state) => state.toggle);

  // Only this button's own failure, not whichever item's star was last pressed anywhere in the
  // app - the store tracks one at a time, and every other button reading it has to stay silent
  // about a refusal that was not about the item it renders.
  const failure = useBookmarksStore((state) =>
    state.actionError?.itemId === itemId ? state.actionError.message : null,
  );

  const label = `Bookmark ${title.length > 0 ? title : 'Untitled'}`;
  const icon = props.pin === true ? Pin : Star;

  const control = compact ? (
    <button
      type="button"
      aria-label={label}
      title={kept ? 'Unpin from sidebar' : 'Pin to sidebar'}
      aria-pressed={kept}
      onClick={(event) => {
        // The tree's rows open an item on click, and the editor's chrome sits inside other
        // controls. Neither should fire because somebody aimed at the star.
        event.stopPropagation();
        const button = event.currentTarget;
        if (props.pin === true && document.activeElement === button) {
          const row = button.parentElement;
          const explorer = button.closest('aside');
          requestAnimationFrame(() => {
            if (document.activeElement !== document.body) return;
            if (button.isConnected) button.focus({ preventScroll: true });
            else if (row?.isConnected === true) row.querySelector('button')?.focus();
            else explorer?.focus();
          });
        }
        if (onToggle) onToggle();
        else void toggle(itemId);
      }}
      className={cn(
        focusRing,
        'flex size-(--control-sm) shrink-0 items-center justify-center rounded-sm text-muted hover:bg-surface hover:text-accent-text',
        'pointer-coarse:size-(--control-lg)',
        kept ? 'text-accent-text' : '',
        className,
      )}
    >
      {/* `fill-current` is the whole difference between kept and not: a filled star and an
          outlined one, which is the convention every application that has stars uses. The colour
          change beside it is the second signal, so this does not rest on fill alone. */}
      <Icon icon={icon} size="sm" className={kept ? 'fill-current' : ''} />
    </button>
  ) : (
    <Button
      variant="icon"
      aria-label={label}
      title={kept ? 'Unpin from sidebar' : 'Pin to sidebar'}
      aria-pressed={kept}
      className={className}
      onClick={() => {
        if (onToggle) onToggle();
        else void toggle(itemId);
      }}
    >
      <Icon icon={icon} size="sm" className={kept ? 'fill-current text-accent-text' : ''} />
    </Button>
  );

  if (failure === null) {
    return control;
  }

  // Inline, next to the star it is about, rather than a shelf-wide banner - there is no shelf-wide
  // toast reachable from here without threading one through every tree row and every editor's
  // chrome that renders this button, and the star that flipped back is exactly where the reader is
  // already looking.
  return (
    <span className="inline-flex items-center gap-1.5">
      {control}
      <Text variant="note" role="alert" tone="accent">
        {failure}
      </Text>
    </span>
  );
}
