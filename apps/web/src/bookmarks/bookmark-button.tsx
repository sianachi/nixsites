import { Button, Icon, Text, cn, focusRing } from '@nix/ui';
import { Star } from 'lucide-react';
import type { ReactNode } from 'react';

import { useBookmarksStore, useIsKept } from '../collections/items/use-bookmarks';

/**
 * The one control that keeps and releases an item, wherever it appears.
 *
 * **One component for every touchpoint**, because a star that means "kept" in the tree and
 * something subtly different in the editor is two things a reader has to learn. It reads the shelf
 * from the store rather than from a prop, so a row and the open document cannot disagree about the
 * same item - which they would the moment one of them was keeping its own copy.
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

  readonly className?: string | undefined;
}

export function BookmarkButton(props: BookmarkButtonProps): ReactNode {
  const { itemId, title, compact = false, className = '' } = props;
  const kept = useIsKept(itemId);
  const toggle = useBookmarksStore((state) => state.toggle);

  // Only this button's own failure, not whichever item's star was last pressed anywhere in the
  // app - the store tracks one at a time, and every other button reading it has to stay silent
  // about a refusal that was not about the item it renders.
  const failure = useBookmarksStore((state) =>
    state.actionError?.itemId === itemId ? state.actionError.message : null,
  );

  const label = `Bookmark ${title.length > 0 ? title : 'Untitled'}`;

  const star = compact ? (
    <button
      type="button"
      aria-label={label}
      title={kept ? 'Unpin from sidebar' : 'Pin to sidebar'}
      aria-pressed={kept}
      onClick={(event) => {
        // The tree's rows open an item on click, and the editor's chrome sits inside other
        // controls. Neither should fire because somebody aimed at the star.
        event.stopPropagation();
        void toggle(itemId);
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
      <Icon icon={Star} size="sm" className={kept ? 'fill-current' : ''} />
    </button>
  ) : (
    <Button
      variant="icon"
      aria-label={label}
      title={kept ? 'Unpin from sidebar' : 'Pin to sidebar'}
      aria-pressed={kept}
      className={className}
      onClick={() => {
        void toggle(itemId);
      }}
    >
      <Icon icon={Star} size="sm" className={kept ? 'fill-current text-accent-text' : ''} />
    </Button>
  );

  if (failure === null) {
    return star;
  }

  // Inline, next to the star it is about, rather than a shelf-wide banner - there is no shelf-wide
  // toast reachable from here without threading one through every tree row and every editor's
  // chrome that renders this button, and the star that flipped back is exactly where the reader is
  // already looking.
  return (
    <span className="inline-flex items-center gap-1.5">
      {star}
      <Text variant="note" role="alert" tone="accent">
        {failure}
      </Text>
    </span>
  );
}
